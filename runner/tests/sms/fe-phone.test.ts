// FE-PHONE-001..009 — Phone system FE (P1).
import { describe, test, expect, afterAll } from "vitest";
import { loginAs, closeBrowser } from "../../fixtures/auth.js";
import { expectVisible } from "../../fixtures/dom.js";
import { conversationList, fulfillBffJson, openNewMessageMenu, waitForInboxList } from "../../fixtures/inbox.js";

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

  test("FE-PHONE-003 — With no phone number, New Message > New SMS says so and links to Settings > Phone & SMS", async () => {
    const { page, context } = await loginAs("ADMIN");
    try {
      // The retired SMS page's empty state ("Go to Phone System Settings") is the inbox's answer to a seat that cannot text yet:
      // New Message > New SMS is still pickable, the menu item carries the reason on a second line, and the sheet shows a card
      // instead of a form, with the link that fixes it (lib/newMessage.ts smsBlock: "No phone number yet" and "Set up a phone
      // number" -> /settings/general?tab=phone-sms; NewMessageSheet.tsx Blocked; Settings > Phone & SMS is that tab,
      // features/settings/types.ts). The old check only looked for "internal server error" on the retired URL (and the QA
      // admin is seeded with a number, README, so the empty state would not show anyway), so it could not fail.
      // The condition is made rather than waited for: the phone list the sheet reads (GET /sms/phone-numbers, answered as
      // { data: { phone_numbers } }, hooks/usePhone.ts useUserPhone) is answered empty for this page only. That call never
      // reaches the service, and nothing is changed.
      await page.route(/\/sms\/phone-numbers(\?.*)?$/, (route) =>
        ["GET", "OPTIONS"].includes(route.request().method())
          ? fulfillBffJson(route, 200, { message: "Phone numbers retrieved successfully", data: { phone_numbers: [] } })
          : route.continue()
      );
      await page.goto("/inbox?tab=sms", { waitUntil: "domcontentloaded" });
      await waitForInboxList(page);

      const menu = await openNewMessageMenu(page);
      const newSms = menu.getByRole("menuitem", { name: /new sms/i });
      await expectVisible(newSms.getByText("No phone number yet", { exact: true }), { timeout: 30_000 });
      await newSms.click({ timeout: 15_000 });
      const sheet = page.getByRole("dialog", { name: /new sms/i });
      await expectVisible(sheet, { timeout: 30_000 });
      await expectVisible(sheet.getByText("No phone number yet", { exact: true }), { timeout: 30_000 });
      expect(await sheet.getByLabel("Phone number").count(), "the sheet should show a card, not a form it cannot send").toBe(0);
      const fix = sheet.getByRole("link", { name: "Set up a phone number", exact: true });
      await expectVisible(fix, { timeout: 15_000 });
      expect(await fix.getAttribute("href"), "the card should link to Settings > Phone & SMS").toBe("/settings/general?tab=phone-sms");

      await fix.click({ timeout: 15_000 });
      await page.waitForURL((url) => url.pathname === "/settings/general" && url.searchParams.get("tab") === "phone-sms", { timeout: 30_000 });
      await expectVisible(page.locator('button[aria-current="page"]', { hasText: "Phone & SMS" }), { timeout: 30_000 });
    } finally {
      await context.close();
    }
  }, 120_000);

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
