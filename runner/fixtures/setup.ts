// Vitest setup file. Loads .env from the workspace root once per test file.
import * as dotenv from "dotenv";
import * as path from "node:path";
import { loadEnv } from "@revhero/qa-shared";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// Eager-load + validate env. Throws fast if STAGING_BASE_URL is wrong (e.g. prod).
loadEnv();
