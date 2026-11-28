// Helpers for the unified inbox (/inbox) that replaced the Email, Phone and LinkedIn pages. The FE unified-inbox
// release reached prod 2026-11-27: one /inbox with channel tabs, and the old /email-system/email, /phone-system/sms
// and /linkedin-system/messages URLs 307 into it (proxy.ts, features/inbox/lib/legacyRoutes.ts).
//
// Every selector and every piece of visible text below is read from the front end's own source (RevHero-FE-New,
// origin/main @ 9561f998, 2026-11-28; first written against 883f5959 and re-read in full), cited next to it, so a rename
// there is one grep away from here. Roles and accessible names
// are preferred; the two `section[aria-label]` / `[data-row-open]` hooks are the inbox's own, used because the list has
// no better handle.
import type { Locator, Page, Response, Route } from "playwright";

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

type InboxListDom = { present: boolean; busy: boolean; rows: number; empty: boolean; alert: string | null };

/** What the conversation list shows right now (ConversationList.tsx), read in one go so the parts agree with each other. */
async function readInboxList(page: Page): Promise<InboxListDom> {
  return page
    .evaluate((): InboxListDom => {
      const list = document.querySelector('section[aria-label="Conversations"]');
      if (!list) return { present: false, busy: false, rows: 0, empty: false, alert: null };
      const alert = list.querySelector('[role="alert"]');
      return {
        present: true,
        busy: list.querySelector('[aria-busy="true"]') !== null,
        rows: list.querySelectorAll("[data-row-open]").length,
        empty: Array.from(list.querySelectorAll("p")).some((p) => (p.textContent ?? "").trim() === "No Messages"),
        alert: alert ? (alert.textContent ?? "").replace(/\s+/g, " ").trim() : null
      };
    })
    .catch(() => ({ present: false, busy: false, rows: 0, empty: false, alert: null }));
}

/**
 * waitForInboxList for a list that was already showing something and has been asked for something else (a folder, a filter,
 * a search, a page). While the new answer is in flight ConversationList keeps the old rows on screen, dimmed, with
 * `aria-busy="true"` on the <ul> (its `isStale`), and the very first load is the skeleton <ul aria-busy="true">; neither has
 * the attribute once the answer is in. This waits for the attribute to go, then for rows or "No Messages", and throws on the
 * list's own error state.
 *
 * One case has no such flag: when the old answer was an EMPTY list, "No Messages" stays on screen while the new answer is in
 * flight, so a list that looks settled may still be the old one. A caller that knows what the new answer must be (back from a
 * search nothing matched: rows) passes `state`, and this waits until the list shows exactly that. Change the address (or click)
 * BEFORE calling it: until the new request is made the old list is at rest.
 */
export async function waitForInboxSettled(
  page: Page,
  opts: { timeout?: number; state?: InboxListState } = {}
): Promise<InboxListState> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  let last = "no list yet";
  for (;;) {
    const dom = await readInboxList(page);
    if (dom.alert !== null) throw new Error(`the inbox list failed to load: ${dom.alert}`);
    if (dom.present && !dom.busy && (dom.rows > 0 || dom.empty)) {
      const state: InboxListState = dom.rows > 0 ? "rows" : "empty";
      if (opts.state === undefined || opts.state === state) return state;
      last = `${state}, while waiting for ${opts.state}`;
    } else {
      last = !dom.present ? "no list yet" : dom.busy ? "a loading state (stale rows or a skeleton)" : "neither rows nor the empty state";
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(100);
  }
  throw new Error(`the inbox list did not settle${opts.state ? ` on ${opts.state}` : ""} within ${timeout} ms (it showed ${last})`);
}

/**
 * The BFF's answer to the next inbox list call (GET /inbox/conversations?...) whose address holds `needle`
 * ("folder=sent", "q=abc", "email_type=campaign"), or satisfies it when it is a function of the full address
 * (app/api/inbox/inbox.ts getInboxConversations). Start it BEFORE the click that causes the call. A failed wait is handled
 * here as well, so an abandoned one never ends the run with an unhandled rejection.
 */
export function waitForInboxListResponse(
  page: Page,
  needle: string | ((address: string) => boolean),
  opts: { timeout?: number } = {}
): Promise<Response> {
  const matches = typeof needle === "string" ? (address: string) => address.includes(needle) : needle;
  const answer = page.waitForResponse(
    (res) => res.request().method() === "GET" && /\/inbox\/conversations\?/.test(res.url()) && matches(res.url()),
    { timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS }
  );
  answer.catch(() => {});
  return answer;
}

/**
 * Waits for the address to carry `name=expected` (`null`: the parameter is absent). The inbox keeps its filters in the URL and
 * leaves out a parameter that equals its default (features/inbox/lib/filters.ts filtersToUrlUpdates), so a folder, a filter,
 * a search or a page change shows up there first, and "back to the default" means the parameter goes away.
 */
export async function waitForQueryParam(
  page: Page,
  name: string,
  expected: string | null,
  opts: { timeout?: number } = {}
): Promise<void> {
  const timeout = opts.timeout ?? 15_000;
  try {
    await page.waitForURL((url) => url.searchParams.get(name) === expected, { timeout });
  } catch {
    throw new Error(`the address never showed ${name}=${expected ?? "(absent)"} within ${timeout} ms (it is ${page.url()})`);
  }
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

/**
 * Clicks `target`, first closing any dialog that covers it; retries when a modal that opened late intercepts the click. Use it
 * for every click on a page that has just loaded (the welcome modal is back on each load). Do NOT use it while a dialog of your own
 * is open (the New Message sheet, the Email Connection modal): closing "any dialog" would close that one.
 */
export async function clickPastBlockingDialogs(page: Page, target: Locator, timeout: number = DEFAULT_TIMEOUT_MS): Promise<void> {
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

/**
 * Clicks New Message (the button with the "+", top right of the inbox's tab row) and returns the menu it opens.
 * NewMessageMenu.tsx: a Radix dropdown (role "menu") holding exactly two items, "New Email" and "New SMS"; an item whose
 * channel cannot be used yet carries a second line saying what is missing (lib/newMessage.ts SendBlock.title).
 */
export async function openNewMessageMenu(page: Page, opts: { timeout?: number } = {}): Promise<Locator> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  await clickPastBlockingDialogs(page, page.getByRole("button", { name: /^new message$/i }).first(), timeout);
  const menu = page.getByRole("menu");
  await menu.waitFor({ state: "visible", timeout });
  return menu;
}

/**
 * Answers an intercepted call from the app to the BFF with JSON, plus the CORS headers the browser needs to accept it: the app
 * is on staging.revhero.ai and calls api.staging.revhero.ai with credentials, so a fulfilled response without them is refused
 * by the page's own fetch. A CORS preflight that reaches the handler is answered as well. Use it only for a call that must not
 * reach the real service (a send, or a list the test wants empty).
 */
export async function fulfillBffJson(route: Route, status: number, body: unknown): Promise<void> {
  const request = route.request();
  const origin = request.headers()["origin"];
  const cors: Record<string, string> = origin
    ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" }
    : {};
  if (request.method() === "OPTIONS") {
    await route.fulfill({
      status: 204,
      headers: {
        ...cors,
        "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "access-control-allow-headers": request.headers()["access-control-request-headers"] ?? "content-type"
      }
    });
    return;
  }
  await route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
}
