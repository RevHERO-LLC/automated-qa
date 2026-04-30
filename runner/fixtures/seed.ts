// One-time seed of the test fixtures attached to the Maggie ADMIN account.
// Idempotent — running it twice is a no-op for already-seeded rows.
//
// The Maggie account was seeded by hand 2026-04-08 with:
//   - 2 campaigns (id 4 active, id 5 inactive)
//   - 3 deals
//   - 1 phone number (Twilio sub-account 1)
//   - 3 SMS messages
//   - Mailbox connected (Gmail)
//
// This module re-asserts those rows and re-creates anything that was wiped
// out between runs. It does NOT create new accounts — those come from
// test-credentials.md.
import { query } from "./db.js";
import { getCredentials, getEnv } from "../lib/context.js";

export async function ensureBaselineFixtures(): Promise<void> {
  const adminCreds = getCredentials("ADMIN");
  const rows = await query<{ id: number; account_id: number }>(
    "SELECT id, account_id FROM users WHERE email = $1 LIMIT 1",
    [adminCreds.email]
  );
  if (rows.length === 0) {
    throw new Error(
      `Baseline fixture user (${adminCreds.email}) is missing — seed it via the FE register flow before running tests`
    );
  }
  // Phase 1 baseline: just assert the user exists. Campaign/deal/SMS seeds are
  // touched by Phase 2 tests; we add them when those tests start running.
}

export async function ensureSuperAdminAccount(): Promise<{ email: string; password: string } | null> {
  const env = getEnv();
  if (!env.SUPER_ADMIN_EMAIL || !env.SUPER_ADMIN_PASSWORD) {
    return null;
  }
  // Phase 1 leaves the SUPER_ADMIN account creation manual (the BFF accepts
  // role: SUPER_ADMIN on /v1/auth/register today — that's a known finding).
  // Phase 2 wires this up to actually call the register endpoint.
  return { email: env.SUPER_ADMIN_EMAIL, password: env.SUPER_ADMIN_PASSWORD };
}
