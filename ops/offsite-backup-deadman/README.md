# offsite-backup-deadman

Hourly VPS2 check that the **offsite** prod database backup (`s3://920373022094-database-backups/postgres/prod/`) is fresh. It Slacks when:

| Condition | Alert |
|---|---|
| The newest object is older than `STALE_HOURS` (26), or the prefix is **empty** | `stale`, immediately |
| S3 cannot be read (bad/rotated credential, network) | `failed`, after `CONFIRM_RUNS` (2) runs in a row |
| The check cannot run (no `aws` CLI) | `config`, immediately; the unit also exits 2 so it shows in `systemctl --failed` |

- An unchanged problem re-alerts every `REMIND_HOURS` (12). When the backup is fresh again, one RECOVERED message is posted.
- **Fails loud:** with no `SLACK_WEBHOOK`, the unit fails (exit 2). If Slack is down, the alert is not recorded and is retried next run.

**Why:** VPS4's nightly offsite job failed every night from 2026-09-12 to 2026-11-21 and the prefix went empty with nobody told (#1255). This check runs on a different host and looks at the S3 side.

**Credential:** a READ-ONLY IAM identity, profile `backup-deadman-ro`, with only `s3:ListBucket` on the bucket for prefix `postgres/*`. The VPS4 backup key is write-only by design and cannot list.

**Pagination:** with `--output text` the AWS CLI applies `--query` per 1000-key page. The script takes the newest timestamp across all pages, and the test covers a multi-page listing.

**Install (manual, not CI):** `sudo bash ops/offsite-backup-deadman/install.sh`. Then fill `/etc/revhero/offsite-backup-deadman.env` and run with `TEST_ALERT=true` once. Full steps are in the RevHero runbook (`docs/missions/waiting-on-zach.md`, R2).

**Test:** `bash ops/offsite-backup-deadman/test-deadman.sh` is hermetic (aws, curl and jq are mocked).
