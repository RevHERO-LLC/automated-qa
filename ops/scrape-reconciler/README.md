# Scrape-status reconciler (#602)

## What / Why

RevHero's website scraper writes lead text to S3 but never updates the cosmetic
tracking columns `deal_configurations.scraped_on` (timestamptz) and
`deal_configurations.aws_website_text_link` (text) in the campaign Postgres DB.

This reconciler is a daily scheduled job that backfills those columns from S3
object metadata — no changes to the scraper required.

**S3 key layout:**
```
s3://<PROCESSED_BUCKET>/leads/{email}/website-text/content.txt
```

`scraped_on` is set from the S3 object's `LastModified` timestamp.
`aws_website_text_link` is set to the full `s3://` URI of the object.

Both columns are written **only when blank** (idempotent — safe to re-run).

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DB_DSN` | yes | — | Postgres DSN for the campaign DB (VPS4). E.g. `postgres://user:pass@194.140.198.15:5432/campaign_db` |
| `PROCESSED_BUCKET` | no | `leadenrichstack-processeddatabucket4e25d3b7-srglu6vbtymz` | S3 bucket holding scraped lead text |
| `DRY_RUN` | no | `true` | `true` = log what would change, no writes. `false` = real writes. |
| `LIMIT` | no | `0` (no limit) | Max deal rows to process (useful for test runs) |

## GitHub Actions secrets required

| Secret | Where to create | Notes |
|---|---|---|
| `CAMPAIGN_DB_DSN` | automated-qa repo (or RevHERO-LLC org) secrets | **Does not yet exist — must be created before the scheduled run fires.** DSN must reach the campaign DB on VPS4 from the self-hosted runner. |
| `AWS_DEPLOY_ROLE_ARN` | Already used by `AI-data-lake/deploy-scrapers.yml`. Add to automated-qa repo secrets if not already present. | OIDC role ARN with `s3:HeadObject` on the processed-data bucket. |

## Manual run (local)

```bash
# Dry run (safe — no writes)
export DB_DSN="postgres://user:pass@194.140.198.15:5432/campaign_db"
export DRY_RUN=true
python ops/scrape-reconciler/reconcile.py

# Real run with a row cap for validation
export DRY_RUN=false
export LIMIT=50
python ops/scrape-reconciler/reconcile.py

# Full production run
export DRY_RUN=false
export LIMIT=0
python ops/scrape-reconciler/reconcile.py
```

Dependencies: `boto3`, `psycopg2-binary` (both available via pip).
AWS credentials must be available in the environment (e.g. `AWS_PROFILE=revhero-qa`).

## Workflow schedule

Daily at **06:30 UTC** (after the PIQ aggregator's 06:00 window).

Use `workflow_dispatch` with `dry_run=true` for the initial validation run before
allowing the scheduled job to write to production.
