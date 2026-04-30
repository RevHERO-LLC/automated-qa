// Postgres pooled-mode client for verification queries.
// Connects to the Supabase pooler in session mode (port 5432) — NOT 6543,
// which breaks GORM prepared statements (RevHero infra note 2026-04-05).
import { Pool, type PoolClient } from "pg";
import { getEnv } from "../lib/context.js";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const env = getEnv();
  if (!env.SUPABASE_POOLER_URL) {
    throw new Error("SUPABASE_POOLER_URL not set — DB-backed tests will fail");
  }
  if (env.SUPABASE_POOLER_URL.includes(":6543")) {
    throw new Error(
      "SUPABASE_POOLER_URL is using port 6543 (transaction pooler) — must be 5432 (session pooler)"
    );
  }
  pool = new Pool({
    connectionString: env.SUPABASE_POOLER_URL,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: false }
  });
  return pool;
}

export async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const p = getPool();
  const res = await p.query(sql, params as any);
  return res.rows as T[];
}

export async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const p = getPool();
  const client = await p.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function findUserByEmail(
  email: string
): Promise<{ id: number; account_id: number | null; setup_finished: boolean } | null> {
  // The users table has no account_id column directly — accounts are linked
  // via the accounts_users join table. Pull both in one query.
  const rows = await query<{ id: number; account_id: number | null; setup_finished: boolean }>(
    `SELECT u.id, u.setup_finished, au.account_id
     FROM users u
     LEFT JOIN accounts_users au ON au.user_id = u.id
     WHERE u.email = $1
     ORDER BY au.account_id NULLS LAST
     LIMIT 1`,
    [email]
  );
  return rows.length > 0 ? rows[0]! : null;
}

export async function findCampaignsByAccount(accountId: number): Promise<Array<{ id: number; name: string; is_active: boolean }>> {
  return query("SELECT id, name, is_active FROM automation_campaigns WHERE account_id = $1", [accountId]);
}

export async function setNextMoveDate(dealId: number, date: Date | null): Promise<void> {
  await query("UPDATE deals SET next_move_date = $1 WHERE id = $2", [date, dealId]);
}

export async function getMessageById(id: number): Promise<{ id: number; status: string; sentiment: string; direction: string } | null> {
  const rows = await query<{ id: number; status: string; sentiment: string; direction: string }>(
    "SELECT id, status, sentiment, direction FROM messages WHERE id = $1 LIMIT 1",
    [id]
  );
  return rows.length > 0 ? rows[0]! : null;
}
