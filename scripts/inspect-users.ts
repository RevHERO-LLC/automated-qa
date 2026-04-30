import { Pool } from "pg";
import * as dotenv from "dotenv";
import * as path from "node:path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const pool = new Pool({
  connectionString: process.env.SUPABASE_POOLER_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  const cols = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users'
     ORDER BY ordinal_position`
  );
  console.log("users columns:");
  console.log(JSON.stringify(cols.rows, null, 2));

  const tabs = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' ORDER BY 1`
  );
  console.log("public tables:");
  console.log(tabs.rows.map((r) => r.table_name).join(", "));

  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
