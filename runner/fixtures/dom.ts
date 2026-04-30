// DOM-helper shims that read like Playwright's `expect(loc).toBeVisible()`
// while staying compatible with Vitest as the test runner. Vitest's expect
// doesn't ship Playwright's locator matchers, so we wrap waitFor() calls.
import type { Locator } from "playwright";

export async function expectVisible(loc: Locator, opts: { timeout?: number } = {}): Promise<void> {
  await loc.waitFor({ state: "visible", timeout: opts.timeout ?? 10_000 });
}

export async function expectHidden(loc: Locator, opts: { timeout?: number } = {}): Promise<void> {
  await loc.waitFor({ state: "hidden", timeout: opts.timeout ?? 10_000 });
}

export async function isVisible(loc: Locator, timeout: number = 1_000): Promise<boolean> {
  try {
    await loc.waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

export async function countOf(loc: Locator): Promise<number> {
  return loc.count();
}

export async function expectCount(loc: Locator, expected: number): Promise<void> {
  const actual = await loc.count();
  if (actual !== expected) {
    throw new Error(`Expected count ${expected}, got ${actual} for ${loc.toString()}`);
  }
}

export async function expectMinCount(loc: Locator, min: number): Promise<void> {
  const actual = await loc.count();
  if (actual < min) {
    throw new Error(`Expected at least ${min}, got ${actual} for ${loc.toString()}`);
  }
}
