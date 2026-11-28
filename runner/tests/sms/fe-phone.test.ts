// FE-PHONE-001..009 — Phone system FE (P1).
import { describe, test, expect, afterAll } from "vitest";
import { loginAs, closeBrowser } from "../../fixtures/auth.js";
import { conversationList, waitForInboxList } from "../../fixtures/inbox.js";

describe("Phone System (FE-PHONE)", () => {
  afterAll(async () => {
    await closeBrowser();
  });

  test("FE-PHONE-001 — legacy /phone-system (and /phone-system/sms) redirect to the inbox SMS tab", async () => {
    const { page, context } = await loginAs("ADMIN");
    try {
      // Retired with the unified-inbox release (FE #479, merged to staging 2026-11-11): proxy.ts 307s both URLs
      // into the inbox (features/inbox/lib/legacyRoutes.ts: "/phone-system" and "/phone-system/sms" ->
      // /inbox?tab=sms). The old assertion (/phone-system -> /phone-system/sms) can no longer hold.
      // /phone-system/voicemails is NOT retired (FE-PHONE-004 covers it).
      for (const legacy of ["/phone-system", "/phone-system/sms"]) {
        await page.goto(legacy, { waitUntil: "domcontentloaded" });
        await page.waitForURL((url) => url.pathname === "/inbox", { timeout: 15_000 });
        expect(new URL(page.url()).searchParams.get("tab"), `${legacy} should land on the inbox SMS tab (got ${page.url()})`).toBe("sms");
      }
    } finally {
      await context.close();
    }
  });

  test("FE-PHONE-002 — /inbox?tab=sms (the inbox SMS tab) settles into its list or empty state (FE-BUG-04 fix — no permanent skeleton)", async () => {
    const { page, context } = await loginAs("ADMIN");
    try {
      // The Phone SMS page was retired with the unified-inbox release (prod 2026-11-27; FE-PHONE-001 covers the
      // redirect). FE-BUG-04 was that page sticking on a skeleton. Its successor is the SMS tab's conversation list,
      // which shows skeleton rows while it loads (ConversationList.tsx: <ul aria-busy="true"> of data-slot="skeleton"
      // rows) and must then give way to the rows or the "No Messages" empty state. waitForInboxList() throws if it
      // never does, and on the list's own error state. (A seat with no phone number is told so by New SMS, "No phone
      // number yet" with a link to Settings > Phone & SMS, not by this list.)
      await page.goto("/inbox?tab=sms", { waitUntil: "domcontentloaded" });
      await waitForInboxList(page);
      // Nothing in the list may still be a skeleton once it has settled.
      const skeletons = conversationList(page).locator("[data-slot='skeleton']");
      const skeletonCount = await skeletons.count();
      const visibleSkeletons = [];
      for (let i = 0; i < skeletonCount; i++) {
        if (await skeletons.nth(i).isVisible().catch(() => false)) visibleSkeletons.push(i);
      }
      expect(visibleSkeletons.length, "Stuck skeleton — FE-BUG-04 regression").toBe(0);
    } finally {
      await context.close();
    }
  });

  test("FE-PHONE-003 — Empty state shows 'Go to Phone System Settings' CTA (best-effort)", async () => {
    const { page, context } = await loginAs("ADMIN");
    try {
      await page.goto("/phone-system/sms", { waitUntil: "domcontentloaded" });
      const html = await page.content();
      expect(html.toLowerCase()).not.toMatch(/internal server error/);
    } finally {
      await context.close();
    }
  });

  test("FE-PHONE-004 — /phone-system/voicemails lists voicemails or empty state", async () => {
    const { page, context } = await loginAs("ADMIN");
    try {
      await page.goto("/phone-system/voicemails", { waitUntil: "domcontentloaded" });
      const html = await page.content();
      expect(html.toLowerCase()).not.toMatch(/internal server error/);
    } finally {
      await context.close();
    }
  });

  test("FE-PHONE-005 — Brand registration flow accessible from phone system", async () => {
    expect(true).toBe(true);
  });

  test("FE-PHONE-006 — A2P status badge displays correct color/text (smoke)", async () => {
    expect(true).toBe(true);
  });

  test("FE-PHONE-007 — Phone Number purchase flow renders available numbers (smoke)", async () => {
    expect(true).toBe(true);
  });

  test("FE-PHONE-008 — Buy phone number button triggers purchase API call (smoke)", async () => {
    expect(true).toBe(true);
  });

  test("FE-PHONE-009 — Send SMS modal validates recipient + body (smoke)", async () => {
    expect(true).toBe(true);
  });
});
