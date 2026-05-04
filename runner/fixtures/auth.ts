// Browser-based auth fixture. loginAs() returns a logged-in BrowserContext that
// shares cookies + localStorage across tests in the same file.
//
// Implementation note (2026-04-30): the React login form has a hydration race
// where a button click before hydration falls back to the browser's default
// GET form submit (URL becomes `/login?email=...&password=...`). To avoid the
// race entirely, performLogin hits the BFF /v1/auth/login endpoint via
// BrowserContext.request — Set-Cookie headers from that response land in the
// context's cookie jar, and we mirror the JWT into localStorage for FE code
// paths that read from there.
//
// Tests that explicitly verify the login UI (FE-AUTH-019 spinner) interact
// with the form directly and don't go through this helper.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAreaUrls, getCredentials } from "../lib/context.js";

type AuthRole = "ADMIN" | "PAID_ADMIN" | "MEMBER" | "SUPER_ADMIN";

let browser: Browser | null = null;

// In the deployed runner container, .sessions lives in the shared
// qa-reports-volume so it survives container restarts. That keeps the
// BFF login budget intact across days — without this, each scheduled
// run does a fresh login which over time exhausts
// LoginMaxAttemptsPerEmail. Locally (no QA_REPORT_DIR or QA_REPORT_DIR
// not on /mnt), .sessions falls back to the runner's own dir.
const SESSION_DIR = (() => {
  const reportDir = process.env.QA_REPORT_DIR;
  if (reportDir && reportDir.startsWith("/mnt/")) {
    return path.join(reportDir, ".sessions");
  }
  return path.resolve(__dirname, "../.sessions");
})();

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({
      headless: process.env.PWHEADLESS !== "false",
      args: ["--disable-dev-shm-usage", "--no-sandbox"]
    });
  }
  return browser;
}

function sessionPath(role: AuthRole): string {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  return path.join(SESSION_DIR, `${role.toLowerCase()}.json`);
}

// Vitest runs test files across worker processes in parallel. Each call to
// loginAs() may concurrently read/write the same per-role session file. The
// previous implementation passed a path directly to Playwright's
// newContext({ storageState: <path> }) and storageState({ path }), both of
// which open the file non-atomically — readers could land mid-write and see
// 0 bytes ("Unexpected end of JSON input"), and a half-applied state could
// produce a context that looks logged-in to the cache check but lands on a
// blank/redirect page later. Both failure modes were observed in the
// scheduled-20260504T080637 run (FE-CAMP-001 and FE-CAMP-002). Fix: do the
// I/O ourselves with defensive parsing and atomic temp+rename writes.
function readStorageStateOrNull(file: string): unknown | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeStorageStateAtomic(context: BrowserContext, file: string): Promise<void> {
  const state = await context.storageState();
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state), "utf8");
  fs.renameSync(tmp, file);
}

export async function loginAs(role: AuthRole): Promise<{ context: BrowserContext; page: Page }> {
  const b = await getBrowser();
  const sp = sessionPath(role);
  const cached = readStorageStateOrNull(sp);
  const reuse = cached !== null;
  const baseURL = getAreaUrls().base;
  const context = await b.newContext(
    reuse
      ? { baseURL, storageState: cached as any, viewport: { width: 1440, height: 900 } }
      : { baseURL, viewport: { width: 1440, height: 900 } }
  );
  const page = await context.newPage();

  let needsLogin = !reuse;
  if (reuse) {
    // Validate the cached session still works; if not, rebuild.
    await page.goto("/automation-campaign", { waitUntil: "domcontentloaded" });
    if (page.url().includes("/login")) needsLogin = true;
  }
  if (needsLogin) {
    await performLoginViaApi(context, role);
    await page.goto("/automation-campaign", { waitUntil: "domcontentloaded" });
    try {
      await writeStorageStateAtomic(context, sp);
    } catch (err) {
      // Best-effort persistence — a failed write means the next test re-logs in.
      console.warn(`[auth] storage state write failed for ${role}:`, err);
    }
  }
  return { context, page };
}

async function performLoginViaApi(context: BrowserContext, role: AuthRole): Promise<void> {
  const creds = getCredentials(role);
  const bff = getAreaUrls().bff;
  let res = await context.request.post(`${bff}/v1/auth/login`, {
    data: { email: creds.email, password: creds.password },
    headers: { "content-type": "application/json", accept: "application/json" }
  });

  // The BFF rate-limits login attempts per email (LoginMaxAttemptsPerEmail = 10
  // per 6m20s window). Prior test runs may have polluted the budget. If we hit
  // 429, wait the server-suggested retry_after and try once more — but cap the
  // wait at 60s so a rogue test doesn't hang the suite indefinitely.
  if (res.status() === 429) {
    let retrySec = 30;
    try {
      const body = (await res.json()) as any;
      const suggested = body?.data?.retry_after_seconds ?? body?.retry_after_seconds;
      if (typeof suggested === "number" && suggested > 0) retrySec = Math.min(suggested + 2, 60);
    } catch {
      /* ignore json parse */
    }
    console.log(`[auth] BFF login returned 429 for ${role}; sleeping ${retrySec}s before retry`);
    await new Promise((r) => setTimeout(r, retrySec * 1000));
    res = await context.request.post(`${bff}/v1/auth/login`, {
      data: { email: creds.email, password: creds.password },
      headers: { "content-type": "application/json", accept: "application/json" }
    });
  }

  if (!res.ok()) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(`BFF /v1/auth/login returned ${res.status()}: ${body.slice(0, 300)}`);
  }
  let body: any = {};
  try {
    body = await res.json();
  } catch {
    // Non-JSON response — server may rely entirely on cookies. That's fine.
  }
  const token = body?.access_token ?? body?.token ?? body?.data?.access_token ?? body?.data?.token;
  const refreshToken =
    body?.refresh_token ?? body?.data?.refresh_token ?? body?.refreshToken ?? body?.data?.refreshToken;

  if (token) {
    // The FE reads `token` and `refresh_token` cookies on its own domain
    // (staging.revhero.ai) via `getCookie("token")` in apiClient.ts.
    // Replicate the cookie writes that lib/auth.ts:setAuthCookie does after
    // a real form-driven login.
    const stagingHost = new URL(getAreaUrls().base).hostname;
    const oneDay = Math.floor(Date.now() / 1000) + 86_400;
    const cookies = [
      {
        name: "token",
        value: token,
        domain: stagingHost,
        path: "/",
        expires: oneDay,
        httpOnly: false,
        secure: true,
        sameSite: "Lax" as const
      }
    ];
    if (refreshToken) {
      cookies.push({
        name: "refresh_token",
        value: refreshToken,
        domain: stagingHost,
        path: "/",
        expires: oneDay,
        httpOnly: false,
        secure: true,
        sameSite: "Lax" as const
      });
    }
    await context.addCookies(cookies);

    // Also mirror to localStorage for any FE code paths that read from there.
    await context.addInitScript(
      ({ tokenValue }) => {
        try {
          localStorage.setItem("revhero_token", tokenValue);
          localStorage.setItem("access_token", tokenValue);
        } catch {
          // localStorage may be blocked in some contexts — ignore.
        }
      },
      { tokenValue: token }
    );
  }
}

export async function freshContext(): Promise<{ context: BrowserContext; page: Page }> {
  const b = await getBrowser();
  const context = await b.newContext({
    baseURL: getAreaUrls().base,
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();
  return { context, page };
}

export async function logout(context: BrowserContext): Promise<void> {
  await context.clearCookies();
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

export function invalidateSession(role: AuthRole): void {
  const sp = sessionPath(role);
  if (fs.existsSync(sp)) fs.unlinkSync(sp);
}
