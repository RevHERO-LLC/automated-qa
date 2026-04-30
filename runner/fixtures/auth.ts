// Browser-based auth fixture. loginAs() returns a logged-in BrowserContext that
// shares cookies + localStorage across tests in the same file. The first call
// per role per worker performs a real /login round-trip; subsequent calls in
// the same worker reuse the storageState cached on disk.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAreaUrls, getCredentials } from "../lib/context.js";

type AuthRole = "ADMIN" | "PAID_ADMIN" | "MEMBER" | "SUPER_ADMIN";

let browser: Browser | null = null;

const SESSION_DIR = path.resolve(__dirname, "../.sessions");

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

export async function loginAs(role: AuthRole): Promise<{ context: BrowserContext; page: Page }> {
  const b = await getBrowser();
  const sp = sessionPath(role);
  const reuse = fs.existsSync(sp);
  const context = await b.newContext(
    reuse
      ? {
          baseURL: getAreaUrls().base,
          storageState: sp,
          viewport: { width: 1440, height: 900 }
        }
      : {
          baseURL: getAreaUrls().base,
          viewport: { width: 1440, height: 900 }
        }
  );
  const page = await context.newPage();

  if (!reuse) {
    await performLogin(page, role);
    await context.storageState({ path: sp });
  } else {
    // Validate the cached session still works; if not, rebuild it.
    await page.goto("/automation-campaign", { waitUntil: "domcontentloaded" });
    if (page.url().includes("/login")) {
      await performLogin(page, role);
      await context.storageState({ path: sp });
    }
  }
  return { context, page };
}

async function performLogin(page: Page, role: AuthRole): Promise<void> {
  const creds = getCredentials(role);
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("Email").or(page.locator('input[type="email"]').first()).fill(creds.email);
  await page.getByPlaceholder(/password/i).or(page.locator('input[type="password"]').first()).fill(creds.password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 30_000 }),
    page.getByRole("button", { name: /^login$/i }).click()
  ]);
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
