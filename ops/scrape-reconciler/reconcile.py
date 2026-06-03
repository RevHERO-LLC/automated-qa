#!/usr/bin/env python3
"""
Scrape-status reconciler (#602).

Backfills deal_configurations.scraped_on and deal_configurations.aws_website_text_link
from S3 object metadata for every deal whose config columns are currently blank.

Environment variables
---------------------
DB_DSN           (required) Postgres connection string, e.g.
                 postgres://user:pass@host:5432/dbname
PROCESSED_BUCKET (optional) S3 bucket that holds scraped text.
                 Default: leadenrichstack-processeddatabucket4e25d3b7-srglu6vbtymz
DRY_RUN          (optional) "true" / "false". Default: "true".
                 When true, logs what WOULD change but writes nothing.
LIMIT            (optional) Integer. Max number of deal rows to consider.
                 Default: 0 (no limit).

S3 key layout
-------------
  leads/{email}/website-text/content.txt

The reconciler performs ONE s3.head_object per unique (lowercased, trimmed) email
address — not one per deal row — so a single scrape result backfills all configs
that share the same lead email.

Idempotency
-----------
The UPDATE uses COALESCE / CASE so it never overwrites an already-populated value.
Re-running is safe at any time.

Exit codes
----------
0  — success (including "nothing to backfill" and "all S3 misses").
1  — systemic failure (DB unreachable, missing env vars, unhandled exception).
     Per-email S3 or per-row DB failures are logged and counted, not fatal.
"""

import logging
import os
import sys
from datetime import timezone

import boto3
import psycopg2

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
    stream=sys.stdout,
)
log = logging.getLogger("scrape-reconciler")


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
def _require_env(name: str) -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        log.error("Required environment variable %s is not set or empty.", name)
        sys.exit(1)
    return val


DB_DSN = _require_env("DB_DSN")
PROCESSED_BUCKET = os.environ.get(
    "PROCESSED_BUCKET",
    "leadenrichstack-processeddatabucket4e25d3b7-srglu6vbtymz",
).strip()
DRY_RUN = os.environ.get("DRY_RUN", "true").strip().lower() != "false"
LIMIT = int(os.environ.get("LIMIT", "0").strip() or "0")

# ---------------------------------------------------------------------------
# SQL
# ---------------------------------------------------------------------------
_QUERY_SQL = """
SELECT
    d.id          AS deal_id,
    LOWER(TRIM(d.email)) AS email,
    dc.id         AS config_id
FROM deals d
JOIN deal_configurations dc ON dc.id = d.deal_configuration_id
WHERE
    COALESCE(d.email, '') <> ''
    AND (
        dc.scraped_on IS NULL
        OR COALESCE(dc.aws_website_text_link, '') = ''
    )
ORDER BY d.id
"""

_UPDATE_SQL = """
UPDATE deal_configurations
SET
    scraped_on          = COALESCE(scraped_on, %(scraped_on)s),
    aws_website_text_link = CASE
                               WHEN COALESCE(aws_website_text_link, '') = ''
                               THEN %(link)s
                               ELSE aws_website_text_link
                           END,
    updated_at          = NOW()
WHERE id = %(config_id)s
"""


# ---------------------------------------------------------------------------
# S3 helpers
# ---------------------------------------------------------------------------
def _s3_key(email: str) -> str:
    return f"leads/{email}/website-text/content.txt"


def _head_object(s3_client, bucket: str, email: str):
    """
    Return the S3 head-object response for the given email's scraped text, or
    None if the object does not exist (404).  Other errors are re-raised.
    """
    key = _s3_key(email)
    try:
        return s3_client.head_object(Bucket=bucket, Key=key)
    except s3_client.exceptions.ClientError as exc:
        code = exc.response["Error"]["Code"]
        if code in ("404", "NoSuchKey"):
            return None
        raise


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    log.info(
        "Starting scrape-status reconciler | bucket=%s dry_run=%s limit=%s",
        PROCESSED_BUCKET,
        DRY_RUN,
        LIMIT if LIMIT > 0 else "none",
    )

    # --- DB connection -------------------------------------------------------
    try:
        conn = psycopg2.connect(DB_DSN)
        conn.autocommit = False
    except Exception as exc:
        log.error("Cannot connect to DB: %s", exc)
        return 1

    # --- S3 client -----------------------------------------------------------
    s3 = boto3.client("s3")
    # Validate bucket access early so we catch mis-config before the long loop.
    try:
        s3.head_bucket(Bucket=PROCESSED_BUCKET)
    except Exception as exc:
        log.error("Cannot access S3 bucket %s: %s", PROCESSED_BUCKET, exc)
        conn.close()
        return 1

    # --- Fetch rows needing backfill -----------------------------------------
    try:
        with conn.cursor() as cur:
            sql = _QUERY_SQL
            if LIMIT > 0:
                sql = sql.rstrip() + f"\nLIMIT {LIMIT}"
            cur.execute(sql)
            rows = cur.fetchall()
    except Exception as exc:
        log.error("Query failed: %s", exc)
        conn.close()
        return 1

    total_scanned = len(rows)
    log.info("Rows needing backfill: %d", total_scanned)

    if total_scanned == 0:
        log.info("Nothing to do — all deal_configurations are already populated.")
        conn.close()
        _summary(total_scanned, 0, 0, 0, 0)
        return 0

    # --- Deduplicate by email ------------------------------------------------
    # Map: email -> list of config_ids
    email_to_configs: dict[str, list[int]] = {}
    for _deal_id, email, config_id in rows:
        email_to_configs.setdefault(email, []).append(config_id)

    unique_emails = list(email_to_configs.keys())
    log.info("Unique lead emails to probe in S3: %d", len(unique_emails))

    # --- S3 HEAD loop --------------------------------------------------------
    s3_hits: dict[str, dict] = {}   # email -> head-object response
    s3_miss_count = 0

    for email in unique_emails:
        key = _s3_key(email)
        try:
            head = _head_object(s3, PROCESSED_BUCKET, email)
        except Exception as exc:
            log.warning("S3 head_object error for email=%s key=%s: %s", email, key, exc)
            s3_miss_count += 1
            continue

        if head is None:
            log.debug("S3 miss: %s (no scraped text found)", key)
            s3_miss_count += 1
        else:
            s3_hits[email] = head
            log.debug(
                "S3 hit: %s | LastModified=%s",
                key,
                head.get("LastModified"),
            )

    s3_hit_count = len(s3_hits)
    log.info("S3 hits: %d  misses: %d", s3_hit_count, s3_miss_count)

    # --- DB update loop ------------------------------------------------------
    rows_updated = 0
    rows_would_update = 0

    for email, head in s3_hits.items():
        config_ids = email_to_configs[email]
        last_modified = head["LastModified"]
        # Ensure timezone-aware UTC datetime for Postgres timestamptz.
        if last_modified.tzinfo is None:
            last_modified = last_modified.replace(tzinfo=timezone.utc)

        s3_link = f"s3://{PROCESSED_BUCKET}/{_s3_key(email)}"

        for config_id in config_ids:
            if DRY_RUN:
                log.info(
                    "[DRY RUN] Would update deal_configurations id=%d | "
                    "scraped_on=%s aws_website_text_link=%s",
                    config_id,
                    last_modified.isoformat(),
                    s3_link,
                )
                rows_would_update += 1
                continue

            try:
                with conn.cursor() as cur:
                    cur.execute(
                        _UPDATE_SQL,
                        {
                            "scraped_on": last_modified,
                            "link": s3_link,
                            "config_id": config_id,
                        },
                    )
                    affected = cur.rowcount
                conn.commit()
                if affected:
                    log.info(
                        "Updated deal_configurations id=%d | scraped_on=%s link=%s",
                        config_id,
                        last_modified.isoformat(),
                        s3_link,
                    )
                    rows_updated += 1
                else:
                    # Row disappeared or was already fully populated by a
                    # concurrent update — not an error, just log it.
                    log.debug(
                        "UPDATE affected 0 rows for config_id=%d (already filled or deleted)",
                        config_id,
                    )
            except Exception as exc:
                log.warning(
                    "DB update failed for config_id=%d email=%s: %s — continuing",
                    config_id,
                    email,
                    exc,
                )
                try:
                    conn.rollback()
                except Exception:
                    pass

    conn.close()

    if DRY_RUN:
        _summary(total_scanned, len(unique_emails), s3_hit_count, s3_miss_count, rows_would_update, dry=True)
    else:
        _summary(total_scanned, len(unique_emails), s3_hit_count, s3_miss_count, rows_updated)

    return 0


def _summary(
    scanned: int,
    unique_emails: int,
    s3_hits: int,
    s3_misses: int,
    rows: int,
    dry: bool = False,
) -> None:
    label = "would-update" if dry else "updated"
    log.info(
        "SUMMARY | scanned=%d unique_emails=%d s3_hits=%d s3_misses=%d %s=%d",
        scanned,
        unique_emails,
        s3_hits,
        s3_misses,
        label,
        rows,
    )


if __name__ == "__main__":
    sys.exit(main())
