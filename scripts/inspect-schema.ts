import { Pool } from "pg";
import * as dotenv from "dotenv";
import * as path from "node:path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const pool = new Pool({
  connectionString: process.env.SUPABASE_POOLER_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  const userTables = await pool.query(
    `SELECT table_schema, table_name FROM information_schema.tables
     WHERE table_schema NOT IN ('pg_catalog','information_schema')
     AND table_name ILIKE '%user%' OR table_name ILIKE '%account%'
     ORDER BY 1,2 LIMIT 30`
  );
  console.log("User/account tables:");
  console.log(JSON.stringify(userTables.rows, null, 2));

  const schemas = await pool.query(
    `SELECT DISTINCT table_schema FROM information_schema.tables
     WHERE table_schema NOT IN ('pg_catalog','information_schema')
     ORDER BY 1`
  );
  console.log("Schemas:");
  console.log(JSON.stringify(schemas.rows, null, 2));

  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
