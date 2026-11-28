// Helpers for the unified inbox (/inbox) that replaced the Email, Phone and LinkedIn pages. The FE unified-inbox
// release reached prod 2026-11-27: one /inbox with channel tabs, and the old /email-system/email, /phone-system/sms
// and /linkedin-system/messages URLs 307 into it (proxy.ts, features/inbox/lib/legacyRoutes.ts).
//
// Every selector and every piece of visible text below is read from the front end's own source (RevHero-FE-New,
// origin/main @ 883f5959), cited next to it, so a rename there is one grep away from here. Roles and accessible names
// are preferred; the two `section[aria-label]` / `[data-row-open]` hooks are the inbox's own, used because the list has
// no better handle.
import type { Locator, Page } from "playwright";

// Staging has slow windows (2026-11-23 and 11-25: pages that normally render in ~6 s took 20 s or more), and the inbox shell
// is the slow part, so the waits below are generous. They only cost time when something is actually wrong.
const DEFAULT_TIMEOUT_MS = 30_000;

/** The conversation list column: features/inbox/components/ConversationList.tsx, `<section aria-label="Conversations">`. */
export function conversationList(page: Page): Locator {
  return page.locator('section[aria-label="Conversations"]');
}

/** The "1-25 of 83" / "0-0 of 0" range label above the list (features/inbox/lib/format.ts rangeLabel). */
export const RANGE_LABEL = /^\d+-\d+ of \d+$/;

export type InboxListState = "rows" | "empty";

/**
 * Waits for the conversation list to leave its loading skeleton and says what replaced it: conversation rows, or the
 * empty state. Throws when the list's own error state shows ("We couldn't load your conversations") and when nothing
 * settles in time (a skeleton that never goes away).
 *
 * ConversationList renders exactly one of: the loading `<ul aria-busy="true">` of skeleton rows, `role="alert"` for the
 * error state, the "No Messages" empty state, or the rows (each row's open button carries `data-row-open`).
 */
export async function waitForInboxList(page: Page, opts: { timeout?: number } = {}): Promise<InboxListState> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const list = conversationList(page);
  await list.waitFor({ state: "visible", timeout });

  const rows = list.locator("[data-row-open]");
  const empty = list.getByText("No Messages", { exact: true });
  const failed = list.getByRole("alert");
  try {
    await rows.first().or(empty).or(failed).first().waitFor({ state: "visible", timeout });
  } catch {
    throw new Error(`the inbox list did not leave its loading state within ${timeout} ms (a stuck skeleton?)`);
  }
  if ((await failed.count()) > 0) {
    const message = (await failed.first().innerText()).replace(/\s+/g, " ").trim();
    throw new Error(`the inbox list failed to load: ${message}`);
  }
  return (await rows.count()) > 0 ? "rows" : "empty";
}

/**
 * Closes a dialog that covers the page, if one is open: the "Welcome to RevHero" modal the QA account gets after login is a
 * fixed `bg-black/50 backdrop-blur-sm` overlay that intercepts every click under it. The first live run of the re-pointed
 * specs (staging, scheduled-20261128T112553) failed FE-EMAIL-007 and FE-EMAIL-OUT-007 on exactly that
 * ("<div ...> intercepts pointer events" while clicking New Message). A no-op when no dialog is open. The button pattern
 * closed that modal on staging on 2026-11-28; Escape is the fallback.
 */
export async function dismissBlockingDialog(page: Page, timeout = 5_000): Promise<void> {
  const dialog = page.getByRole("dialog").first();
  if (!(await dialog.isVisible().catch(() => false))) return;
  const close = dialog.getByRole("button", { name: /close|skip|got it|later|dismiss|continue|not now/i }).first();
  if (await close.isVisible().catch(() => false)) await close.click({ timeout });
  else await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden", timeout }).catch(() => {});
}

/** Clicks `target`, first closing any dialog that covers it; retries when a modal that opened late intercepts the click. */
async function clickPastBlockingDialogs(page: Page, target: Locator, timeout: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    await dismissBlockingDialog(page);
    try {
      await target.click({ timeout: attempt < 3 ? Math.min(timeout, 10_000) : timeout });
      return;
    } catch (err) {
      if (attempt >= 3) throw err;
    }
  }
}

export type NewEmailSheetState = "form" | "blocked";

/**
 * Opens the inbox's New Message > New Email sheet and waits until it has either its compose form or its explanation of
 * why there is none. The page must already be on /inbox.
 *
 * "New Message" is the top-right button (NewMessageMenu.tsx); its menu items are "New Email" / "New SMS"; the sheet is a
 * dialog titled "New Email" (NewMessageSheet.tsx). The sheet holds the composer
 * (features/email-system/components/email-composer.tsx, layout "sheet") when the seat can send, and otherwise a status
 * card ("No mailbox connected" / "Mailbox disconnected", lib/newMessage.ts emailBlock) with a link that fixes it
 * ("Connect a mailbox" / "Reconnect mailbox", to /settings/general?tab=email-accounts). Never a dead form.
 *
 * The composer is told apart by its Subject input (placeholder "Enter subject"), the blocked card by its link.
 */
export async function openNewEmailSheet(
  page: Page,
  opts: { timeout?: number } = {}
): Promise<{ sheet: Locator; state: NewEmailSheetState }> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  await clickPastBlockingDialogs(page, page.getByRole("button", { name: /^new message$/i }).first(), timeout);
  await page.getByRole("menuitem", { name: /new email/i }).click({ timeout });

  const sheet = page.getByRole("dialog", { name: /new email/i });
  await sheet.waitFor({ state: "visible", timeout });

  const subject = sheet.getByPlaceholder("Enter subject");
  const fixLink = sheet.getByRole("link", { name: /connect a mailbox|reconnect mailbox/i });
  await subject.or(fixLink).first().waitFor({ state: "visible", timeout });
  return { sheet, state: (await subject.count()) > 0 ? "form" : "blocked" };
}
