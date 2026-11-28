// FE-EMAIL-001..012 — Email system FE (P1).
import { describe, test, expect, afterAll } from "vitest";
import { loginAs, closeBrowser } from "../../fixtures/auth.js";
import { authedPost, bearerFromContext } from "../../fixtures/api.js";
import { expectHidden, expectVisible, isVisible } from "../../fixtures/dom.js";
import {
  RANGE_LABEL,
  clickPastBlockingDialogs,
  conversationList,
  fulfillBffJson,
  openNewEmailSheet,
  openNewMessageMenu,
  waitForInboxList,
  waitForInboxListResponse,
  waitForInboxSettled,
  waitForQueryParam
} from "../../fixtures/inbox.js";

// The browser is sent to this address to start a Google mailbox connect. FE-EMAIL-003 stops the request before it leaves the machine.
const GOOGLE_SIGN_IN = /^https:\/\/accounts\.google\.com\//;

describe("Email System (FE-EMAIL)", () => {
  afterAll(async () => {
    await closeBrowser();
  });

  test("FE-EMAIL-001 — /inbox?tab=email (the inbox Email tab) lists conversations or its empty state", async () => {
    const { page, context } = await loginAs("ADMIN");
    try {
      // The legacy Email list was retired with the unified-inbox release (prod 2026-11-27; FE-EMAIL-002 covers the
      // redirect). Its successor is the Email tab of /inbox. waitForInboxList() settles on the conversation rows or the
      // "No Messages" empty state and throws on the list's own error state ("We couldn't load your conversations"), so
      // a list that failed to load cannot pass as an empty one.
      await page.goto("/inbox?tab=email", { waitUntil: "domcontentloaded" });
      await waitForInboxList(page);
      // The tab's name carries its Needs Reply badge ("Email 3 need reply"), so match the start of the name only: no
      // other channel tab ("All channels", "SMS", "LinkedIn") starts with it.
      await expectVisible(page.getByRole("tab", { name: /^email/i, selected: true }).first(), { timeout: 10_000 });
      // "1-25 of 83", or "0-0 of 0" for an empty list: not the "Loading…" or "—" a list that never settled would show.
      await expectVisible(conversationList(page).getByText(RANGE_LABEL).first(), { timeout: 10_000 });
      expect((await page.content()).toLowerCase()).not.toMatch(/internal server error/);
    } finally {
      await context.close();
    }
  });

  test("FE-EMAIL-002 — legacy /email-system/email lands on the inbox Email tab (list, or the no-mailbox state)", async () => {
    const { page, context } = await loginAs("ADMIN");
    try {
      // The legacy Email page was retired with the unified-inbox release (FE #479, merged to staging
      // 2026-11-11): proxy.ts answers the old URL with a 307 into the inbox (features/inbox/lib/legacyRoutes.ts:
      // /email-system/email -> /inbox?tab=email), so the old URL can never be the final URL again. The page's
      // "Mailbox not connected" + Connect CTA state now lives in the inbox's New Message menu/sheet ("No mailbox
      // connected" + "Connect a mailbox", features/inbox/lib/newMessage.ts emailBlock) and is shown only to a
      // seat with no mailbox. The QA admin has one, so the check is: redirect lands on the Email tab and the
      // inbox shell renders with its New Message entry point -- connected or not, it must not crash.
      await page.goto("/email-system/email", { waitUntil: "domcontentloaded" });
      await page.waitForURL((url) => url.pathname === "/inbox", { timeout: 15_000 });
      expect(new URL(page.url()).searchParams.get("tab"), `legacy email URL should land on the Email tab (got ${page.url()})`).toBe("email");
      await expectVisible(page.getByRole("button", { name: /new message/i }).first(), { timeout: 20_000 });
      expect((await page.content()).toLowerCase()).not.toMatch(/internal server error/);
    } finally {
      await context.close();
    }
  });

  test("FE-EMAIL-003 — Connecting a mailbox (Settings > Email accounts) offers the two providers and starts the sign-in", async () => {
    const { page, context } = await loginAs("ADMIN");
    try {
      // The legacy Email page's "Connect Mailbox" button went with the page (unified-inbox release, prod 2026-11-27); the old
      // check (`count() >= 0`) could not fail. A seat that has a mailbox is shown no connect button in the inbox: the inbox only
      // links to it, from New Email, when the seat has none (lib/newMessage.ts emailBlock: "Connect a mailbox" ->
      // /settings/general?tab=email-accounts). Connecting lives on Settings > Email accounts
      // (features/email-system/components/EmailSettings.tsx): under the "Email account" heading, "Do you want to connect an
      // email?" opens the "Email Connection" modal, whose two provider buttons are named by their image alt text ("Google",
      // "Microsoft"; components/email/EmailProviders.tsx). Choosing one runs hooks/useConnectEmail.ts: PUT /user/oauth/google/url
      // (user-fe-backend user.handler.go GetGoogleOAuthURL -> { message, data: { oauth_url } }), then
      // window.location.href = data.oauth_url.
      // Nothing is connected: the BFF call only BUILDS the sign-in address (users-service StartOauthFlow signs a state and writes
      // nothing), and the browser's request to Google is stopped before it leaves this machine, so the page never loads Google.
      await page.route(GOOGLE_SIGN_IN, (route) => route.abort());
      await page.goto("/settings/general?tab=email-accounts", { waitUntil: "domcontentloaded" });
      await expectVisible(page.getByRole("button", { name: "Email accounts", exact: true }), { timeout: 30_000 });
      await expectVisible(page.getByText("Email account", { exact: true }), { timeout: 30_000 });

      const connect = page
        .locator("p", { hasText: /^Do you want to\s+connect\s+an email\?$/ })
        .locator("span", { hasText: /^connect$/ });
      await clickPastBlockingDialogs(page, connect);
      const modal = page.getByRole("dialog").filter({ hasText: "Email Connection" });
      await expectVisible(modal, { timeout: 15_000 });
      const google = modal.getByRole("button", { name: "Google", exact: true });
      await expectVisible(google, { timeout: 15_000 });
      await expectVisible(modal.getByRole("button", { name: "Microsoft", exact: true }), { timeout: 15_000 });

      const answered = page.waitForResponse(
        (res) => res.request().method() === "PUT" && new URL(res.url()).pathname.endsWith("/user/oauth/google/url"),
        { timeout: 30_000 }
      );
      const toGoogle = page.waitForRequest(GOOGLE_SIGN_IN, { timeout: 30_000 });
      await google.click();
      expect((await answered).status(), "PUT /user/oauth/google/url should answer the sign-in address").toBe(200);
      // The browser really was sent to Google's sign-in, and it is the address the BFF built (the page only goes there with
      // data.oauth_url in hand; the answer's own body is gone once the page starts to leave), with the client and the signed state.
      const target = new URL((await toGoogle).url());
      expect(target.searchParams.get("client_id"), `Google's sign-in address should name the app: ${target.origin}${target.pathname}`).toBeTruthy();
      expect(target.searchParams.get("state"), "Google's sign-in address should carry the signed state").toBeTruthy();
    } finally {
      await context.close();
    }
  }, 120_000);

  test("FE-EMAIL-004 — the inbox Email tab's filters (Status, Email type, Campaign, Read state) apply to the list", async () => {
    const { page, context } = await loginAs("ADMIN");
    try {
      // The legacy Email page's three drop-downs ("All", "All Emails", "Select an option") are the filter row of the inbox now
      // (InboxTopBar.tsx FilterControls, laid out inline from 1024px; the runner's window is 1440 wide): Status (a menu), Email type
      // (a select, on the Email tab only), Campaign and Read state (selects). The old check (`count() >= 0`) could not fail. Each
      // choice is kept in the address (filters.ts URL_KEYS: status, email_type, campaign, read) and sent to the BFF as the query
      // parameter of the same name (toListParams; the campaign goes as campaign_id). Open on every status (status=all) so the
      // list has the most to filter. Whatever the QA seat holds, each answer must settle on rows or "No Messages", never on the
      // list's own error state (waitForInboxSettled throws on it).
      await page.goto("/inbox?tab=email&status=all", { waitUntil: "domcontentloaded" });
      await waitForInboxList(page);

      // Email type: All Emails <-> Campaign Emails (InboxTopBar.tsx EMAIL_TYPE_OPTIONS).
      const emailType = page.getByRole("combobox", { name: "Email type", exact: true });
      await expectVisible(emailType, { timeout: 15_000 });
      expect(await emailType.inputValue(), "Email type should start on All Emails").toBe("all");
      expect(await emailType.locator("option").allTextContents()).toEqual(["All Emails", "Campaign Emails"]);
      let answered = waitForInboxListResponse(page, "email_type=campaign");
      await emailType.selectOption("campaign");
      await waitForQueryParam(page, "email_type", "campaign");
      expect((await answered).status(), "the list call for Campaign Emails").toBe(200);
      await waitForInboxSettled(page);
      expect(await emailType.inputValue()).toBe("campaign");

      // Read state: Read and unread / Read / Unread (READ_OPTIONS).
      const read = page.getByRole("combobox", { name: "Read state", exact: true });
      expect(await read.inputValue(), "Read state should start on Read and unread").toBe("all");
      expect(await read.locator("option").allTextContents()).toEqual(["Read and unread", "Read", "Unread"]);
      answered = waitForInboxListResponse(page, "read=unread");
      await read.selectOption("unread");
      await waitForQueryParam(page, "read", "unread");
      expect((await answered).status(), "the list call for Unread").toBe(200);
      await waitForInboxSettled(page);
      expect(await read.inputValue()).toBe("unread");

      // Status: a menu (StatusMenu). Its button names the choice ("Status: All statuses"), and an item changes it.
      const status = page.getByRole("button", { name: /^Status: / });
      await expectVisible(status, { timeout: 15_000 });
      expect(await status.getAttribute("aria-label")).toBe("Status: All statuses");
      answered = waitForInboxListResponse(page, "status=no_reply_needed");
      await clickPastBlockingDialogs(page, status);
      await page.getByRole("menuitemradio", { name: "No Reply Needed", exact: true }).click({ timeout: 15_000 });
      await waitForQueryParam(page, "status", "no_reply_needed");
      expect((await answered).status(), "the list call for No Reply Needed").toBe(200);
      await waitForInboxSettled(page);
      await expectVisible(page.getByRole("button", { name: "Status: No Reply Needed", exact: true }), { timeout: 15_000 });

      // Campaign: "All campaigns" first, then the seat's own campaigns (options.ts campaignOptions). With one, choosing it filters by it.
      const campaign = page.getByRole("combobox", { name: "Campaign", exact: true });
      await expectVisible(campaign, { timeout: 15_000 });
      expect(await campaign.inputValue(), "Campaign should start on All campaigns").toBe("all");
      expect(await campaign.locator("option").first().textContent()).toBe("All campaigns");
      await campaign.locator("option").nth(1).waitFor({ state: "attached", timeout: 8_000 }).catch(() => {});
      const values = await campaign.locator("option").evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value));
      const firstCampaign = values.find((value) => value !== "all");
      if (firstCampaign) {
        answered = waitForInboxListResponse(page, `campaign_id=${firstCampaign}`);
        await campaign.selectOption(firstCampaign);
        await waitForQueryParam(page, "campaign", firstCampaign);
        expect((await answered).status(), `the list call for campaign ${firstCampaign}`).toBe(200);
        await waitForInboxSettled(page);
        expect(await campaign.inputValue()).toBe(firstCampaign);
      }
    } finally {
      await context.close();
    }
  }, 120_000);

  test("FE-EMAIL-005 — the inbox search box filters the Email tab's list by what is typed", async () => {
    const { page, context } = await loginAs("ADMIN");
    try {
      // The legacy Email page's "Search Emails" box is the inbox's "Search conversations" box (ConversationList.tsx; the legacy
      // ?q= link lands in it, legacyRoutes.ts). The old check (`count() >= 0`) could not fail. Typing is committed to the address
      // as `q` 300 ms after it settles (useInboxSearch SEARCH_DEBOUNCE_MS) and goes to the BFF as `q` (a search shorter than 2
      // characters is ignored). A search nothing can match must end on "No Messages" with the range "0-0 of 0", and clearing it
      // must bring back what was there. Open on every status (status=all) so the list starts with the most it can hold; the
      // empty answer only proves the filter bites when the list had rows, so that case is the one that cannot pass by accident.
      await page.goto("/inbox?tab=email&status=all", { waitUntil: "domcontentloaded" });
      const before = await waitForInboxSettled(page);
      const list = conversationList(page);
      const search = list.getByPlaceholder("Search conversations");
      await expectVisible(search, { timeout: 15_000 });

      const nothing = `zz-no-such-conversation-${Date.now().toString(36)}`;
      const answered = waitForInboxListResponse(page, `q=${nothing}`);
      await search.fill(nothing);
      await waitForQueryParam(page, "q", nothing);
      expect((await answered).status(), "the list call for the search").toBe(200);
      // (Throws if the list does not end empty: a search nothing can match must leave no conversations.)
      await waitForInboxSettled(page, { state: "empty" });
      await expectVisible(list.getByText("0-0 of 0", { exact: true }), { timeout: 10_000 });

      // Clearing it brings back what the list held. The list is empty now, which shows no busy flag while the new answer is in
      // flight, so the wait is for the state it must reach, not just for rest.
      const restored = waitForInboxListResponse(page, (address) => !address.includes("q="));
      await search.fill("");
      await waitForQueryParam(page, "q", null);
      expect((await restored).status(), "the list call after clearing the search").toBe(200);
      await waitForInboxSettled(page, { state: before });
    } finally {
      await context.close();
    }
  }, 120_000);

  test("FE-EMAIL-006 — the inbox's New Message (+) button opens its menu, and New Email opens the compose sheet", async () => {
    const { page, context } = await loginAs("ADMIN");
    try {
      // The legacy Email page's "+" button (compose / add) is the inbox's New Message button, the one with the "+" icon
      // (NewMessageMenu.tsx): a menu with exactly New Email and New SMS, and New Email opens the right-hand sheet, a dialog titled
      // "New Email" (NewMessageSheet.tsx). The old check (`count() >= 0`) could not fail. What the sheet holds (the form, or the
      // reason there is none) is FE-EMAIL-007's check; here it is that the entry point opens it and that Escape closes it
      // again (the sheet does not close on an outside click, so half a message is not lost to a stray tap).
      await page.goto("/inbox?tab=email", { waitUntil: "domcontentloaded" });
      await waitForInboxList(page);
      const menu = await openNewMessageMenu(page);
      const newEmail = menu.getByRole("menuitem", { name: /new email/i });
      await expectVisible(newEmail, { timeout: 15_000 });
      await expectVisible(menu.getByRole("menuitem", { name: /new sms/i }), { timeout: 15_000 });
      await newEmail.click({ timeout: 15_000 });
      const sheet = page.getByRole("dialog", { name: /new email/i });
      await expectVisible(sheet, { timeout: 30_000 });
      await page.keyboard.press("Escape");
      await expectHidden(sheet, { timeout: 15_000 });
    } finally {
      await context.close();
    }
  });

  test("FE-EMAIL-007 — inbox New Message > New Email renders the compose form (or says why it cannot)", async () => {
    const { page, context } = await loginAs("ADMIN");
    try {
      // The compose page /email-system/email/add was retired with the unified-inbox release: proxy.ts 307s it to
      // /inbox?tab=email, and New Email is now the inbox's New Message button, a sheet rather than a URL
      // (features/inbox/lib/legacyRoutes.ts). The sheet holds the same email-composer.tsx the page did (layout
      // "sheet"). A seat with no connected mailbox gets a card that says so, with a link to Settings > Email accounts,
      // instead of a dead form; that is the FE's designed answer for that seat, so it is accepted too.
      await page.goto("/inbox?tab=email", { waitUntil: "domcontentloaded" });
      const { sheet, state } = await openNewEmailSheet(page);
      if (state === "form") {
        // To: the sheet's recipient field is a chip control whose entry point is a button named "Add a To recipient", not a
        // text input with a placeholder (read live on staging 2026-11-28; the first live run failed waiting for "Enter email").
        await expectVisible(sheet.getByRole("button", { name: /add a to recipient/i }).first(), { timeout: 20_000 });
        await expectVisible(sheet.getByPlaceholder("Enter subject"), { timeout: 20_000 });
        await expectVisible(sheet.locator("[contenteditable='true']").first(), { timeout: 20_000 }); // the body editor (tiptap)
        await expectVisible(sheet.getByRole("button", { name: "Send", exact: true }), { timeout: 20_000 });
      } else {
        const fix = sheet.getByRole("link", { name: /connect a mailbox|reconnect mailbox/i });
        expect(await fix.getAttribute("href"), "the no-mailbox card should link to Settings > Email accounts").toContain(
          "/settings/general?tab=email-accounts"
        );
      }
      expect((await page.content()).toLowerCase()).not.toMatch(/internal server error/);
    } finally {
      await context.close();
    }
  });

  test("FE-EMAIL-008 — The send endpoint behind the New Email form refuses a request with no recipient or no body", async () => {
    const { context } = await loginAs("ADMIN");
    try {
      // The compose page this entry was written for (/email-system/email/add) went with the unified-inbox release, and its old
      // check ("trial" click, then `expect(true)`) asserted nothing. The rule "requires recipient + subject + body" is not in the
      // form, then or now: EmailComposer (features/email-system/components/email-composer.tsx, shared by the old page and the New
      // Email sheet) does not gate Send on any field. It lives in the endpoint the form calls: user-fe-backend
      // POST /v1/emails/send binds the request into revhero_email_ingress_client.SendEmailRequestDTO, where `to` and `html_body`
      // are `binding:"required"`, and answers a 400 ("Invalid request payload") before any mailbox check or send
      // (email.handler.go SendEmail). The subject is NOT required there (it carries no binding), so it is not asserted; the
      // only subject rule is Test Email's (FE-EMAIL-OUT-010).
      // Each probe is refused before anything happens, so nothing is sent. The one probe that names a recipient uses an
      // address on the reserved .invalid domain, which no mail server can ever deliver to.
      const token = await bearerFromContext(context);
      if (!token) throw new Error("no auth token after loginAs");
      const probes: Array<[string, Record<string, unknown>]> = [
        ["no recipient", { subject: "QA validation probe", html_body: "<p>QA validation probe</p>" }],
        ["no body", { to: ["qa-validation-probe@example.invalid"], subject: "QA validation probe" }],
        ["an empty request", {}]
      ];
      for (const [label, payload] of probes) {
        const res = await authedPost("/v1/emails/send", payload, token);
        expect(
          res.status,
          `POST /v1/emails/send with ${label} should be refused with a 400 (got ${res.status}: ${JSON.stringify(res.data).slice(0, 200)})`
        ).toBe(400);
      }
    } finally {
      await context.close();
    }
  });

  test("FE-EMAIL-009 — Send in the inbox's New Email sheet calls the BFF with what was typed and shows the success toast", async () => {
    const { page, context } = await loginAs("ADMIN");
    try {
      // This entry was only ever a marker (`expect(true)`, "network observation"). The compose page is retired; New Email is
      // the inbox's New Message sheet, whose Send posts the typed To / Subject / body to POST /emails/send
      // (email-composer.tsx handleSend: to, subject, html_body) and, once the BFF accepts it, shows the "Email sent" toast and
      // closes the sheet (hooks/useAfterNewMessageSend.ts: toast.success(`${noun} sent`)).
      // A real send would go out of the QA admin's own mailbox to a real address, which this suite never does (see
      // FE-EMAIL-OUT-008). So the BFF's answer is stubbed: the request is observed and answered with a 200, and it never reaches
      // the service. The recipient is on the reserved .invalid domain, so even if the stub ever failed to catch the call the
      // message could not be delivered anywhere.
      const address = "qa-send-probe@example.invalid";
      const subjectText = `QA send probe ${Date.now().toString(36)}`;
      const bodyText = "QA send probe body.";
      // (send-as, the admin's "send from a colleague's mailbox" call, is caught too, so no variant of the send can get through.)
      await page.route(/\/emails\/send(-as)?(\?.*)?$/, (route) =>
        fulfillBffJson(route, 200, { message: "Email sent successfully", data: null })
      );
      await page.goto("/inbox?tab=email", { waitUntil: "domcontentloaded" });
      await waitForInboxList(page);
      const { sheet, state } = await openNewEmailSheet(page);
      if (state !== "form") {
        throw new Error("the New Email sheet shows no compose form for the QA admin (no connected mailbox?), so Send cannot be exercised");
      }

      // To: the recipient field is a chip control; its entry point is the "Add a To recipient" button (read live on staging
      // 2026-11-28, FE-EMAIL-007), which turns into an input (placeholder "Enter email") that takes the address on Enter.
      await sheet.getByRole("button", { name: /add a to recipient/i }).first().click({ timeout: 20_000 });
      const to = sheet.getByPlaceholder("Enter email");
      await to.fill(address);
      await to.press("Enter");
      const chip = sheet.getByText(address, { exact: true }).first();
      // Enter adds the address (RecipientInput handleKeyPress); leaving the field adds it too (onBlur), the way in if the key
      // press were ever not seen as an Enter.
      if (!(await isVisible(chip, 3_000))) await to.blur({ timeout: 3_000 });
      await expectVisible(chip, { timeout: 15_000 });
      await sheet.getByPlaceholder("Enter subject").fill(subjectText);
      await sheet.locator("[contenteditable='true']").first().click();
      await page.keyboard.type(bodyText);

      // Send stays off while the sheet looks the recipient up (sendDisabled), so the click waits for it.
      const call = page.waitForRequest((req) => req.method() === "POST" && /\/emails\/send(\?.*)?$/.test(req.url()), { timeout: 30_000 });
      await sheet.getByRole("button", { name: "Send", exact: true }).click({ timeout: 30_000 });
      const payload = (await call).postDataJSON() as { to?: unknown; subject?: unknown; html_body?: unknown };
      expect(payload.to, "the BFF call should carry the typed recipient").toEqual([address]);
      expect(payload.subject, "the BFF call should carry the typed subject").toBe(subjectText);
      expect(String(payload.html_body ?? ""), "the BFF call should carry the typed body").toContain(bodyText);
      await expectVisible(page.getByText("Email sent", { exact: true }), { timeout: 15_000 });
      await expectHidden(sheet, { timeout: 15_000 });
    } finally {
      await context.close();
    }
  }, 120_000);

  test("FE-EMAIL-010 — legacy /email-system/email/<id> opens that email through the inbox bridge (unknown id: its not-found card)", async () => {
    const { page, context } = await loginAs("ADMIN");
    try {
      // The email detail page was retired with the unified-inbox release: proxy.ts answers /email-system/email/<id>
      // with a 307 to the bridge /inbox/open?source=email_in&id=<id> (?folder=sent means email_out), which asks the BFF
      // which conversation holds that message and replaces itself with /inbox?c=<conversation>
      // (features/inbox/lib/legacyRoutes.ts, openLink.ts). Links to the old URL are already out in the world
      // (email-ingress texts them to reps), so that redirect is the contract worth pinning.
      // As before, use a likely-nonexistent id: no data is assumed, and the route must still render cleanly. The
      // bridge asks again on a 404 for ~12 s (a new message can take ~10 s to reach the feed), then ends on its card.
      await page.goto("/email-system/email/999999999", { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.waitForURL((url) => url.pathname === "/inbox/open", { timeout: 15_000 });
      const bridge = new URL(page.url());
      expect(bridge.searchParams.get("source"), `legacy email detail should go to the bridge as email_in (got ${page.url()})`).toBe("email_in");
      expect(bridge.searchParams.get("id"), `legacy email detail should carry its id to the bridge (got ${page.url()})`).toBe("999999999");
      const card = page.getByRole("alert").filter({ hasText: /couldn.t find that conversation/i });
      await expectVisible(card, { timeout: 40_000 });
      await expectVisible(card.getByRole("link", { name: "Go to the inbox" }), { timeout: 5_000 });
      expect((await page.content()).toLowerCase()).not.toMatch(/internal server error/);
    } finally {
      await context.close();
    }
  });

  test("FE-EMAIL-011 — the inbox folder tabs (Inbox / Starred / Sent / Archived) switch the Email tab's list", async () => {
    const { page, context } = await loginAs("ADMIN");
    try {
      // The legacy Email page's category list (Inbox / Star / Sent / Archive) is the "Folder" tab strip above the inbox list
      // (ConversationList.tsx FOLDERS; the legacy ?view= link maps onto it, legacyRoutes.ts). The old check (`count() >= 0`)
      // could not fail. Each tab becomes the selected one, puts `folder=` in the address (`inbox`, the default, leaves it out:
      // filters.ts filtersToUrlUpdates), asks the BFF for that folder's conversations, and the list settles on rows or
      // "No Messages", never on the list's error state. Starred / Sent / Archived open on every status, which is why the
      // address needs no status for them.
      await page.goto("/inbox?tab=email&status=all", { waitUntil: "domcontentloaded" });
      await waitForInboxSettled(page);
      const folders = page.getByRole("tablist", { name: "Folder", exact: true });
      await expectVisible(folders, { timeout: 15_000 });
      await expectVisible(folders.getByRole("tab", { name: "Inbox", exact: true, selected: true }), { timeout: 10_000 });

      for (const [label, folder] of [
        ["Starred", "starred"],
        ["Sent", "sent"],
        ["Archived", "archived"]
      ] as const) {
        const answered = waitForInboxListResponse(page, `folder=${folder}`);
        await clickPastBlockingDialogs(page, folders.getByRole("tab", { name: label, exact: true }));
        await waitForQueryParam(page, "folder", folder);
        await expectVisible(folders.getByRole("tab", { name: label, exact: true, selected: true }), { timeout: 10_000 });
        expect((await answered).status(), `the list call for the ${label} folder`).toBe(200);
        await waitForInboxSettled(page);
      }

      // Back to Inbox: the parameter goes away again.
      await clickPastBlockingDialogs(page, folders.getByRole("tab", { name: "Inbox", exact: true }));
      await waitForQueryParam(page, "folder", null);
      await expectVisible(folders.getByRole("tab", { name: "Inbox", exact: true, selected: true }), { timeout: 10_000 });
      await waitForInboxSettled(page);
    } finally {
      await context.close();
    }
  }, 120_000);

  test("FE-EMAIL-012 — the inbox list's range (X-Y of Z) matches the rows shown and moves with the page", async () => {
    const { page, context } = await loginAs("ADMIN");
    try {
      // The legacy Email page's pagination ("1-25 of 83", top right) is the range label in the inbox list's header, with
      // Previous / Next page buttons that only exist when there is more than one page (ConversationList.tsx; lib/format.ts
      // rangeLabel; a page holds INBOX_PAGE_SIZE = 25 conversations). The old entry was `expect(true)`. Open on every status
      // (status=all) so the list holds the most it can. Whatever the QA seat holds, the label must agree with the rows on screen;
      // with more than 25 conversations the buttons must exist and page 2 must read "26-N of the same total", and with
      // fewer they must not exist at all.
      await page.goto("/inbox?tab=email&status=all", { waitUntil: "domcontentloaded" });
      await waitForInboxSettled(page);
      const list = conversationList(page);
      const label = list.getByText(RANGE_LABEL).first();
      await expectVisible(label, { timeout: 15_000 });
      const range = async () => {
        const text = ((await label.textContent()) ?? "").trim();
        const m = /^(\d+)-(\d+) of (\d+)$/.exec(text);
        return { text, start: Number(m?.[1]), end: Number(m?.[2]), total: Number(m?.[3]) };
      };
      const first = await range();
      const rows = await list.locator("[data-row-open]").count();
      if (first.total === 0) {
        expect(first.text, "an empty list reads 0-0 of 0").toBe("0-0 of 0");
        expect(rows).toBe(0);
      } else {
        expect(first.start, `the first page should start at 1 (${first.text})`).toBe(1);
        expect(first.end, `the range should end at the number of rows shown (${first.text}, ${rows} rows)`).toBe(rows);
        expect(first.total, `the total should not be below the rows shown (${first.text})`).toBeGreaterThanOrEqual(first.end);
        expect(rows, "a page holds at most 25 conversations").toBeLessThanOrEqual(25);
      }

      const next = list.getByRole("button", { name: "Next page", exact: true });
      const previous = list.getByRole("button", { name: "Previous page", exact: true });
      if (first.total > 25) {
        expect(await next.isEnabled(), "Next page should be live on page 1 of several").toBe(true);
        expect(await previous.isDisabled(), "Previous page should be off on page 1").toBe(true);
        const answered = waitForInboxListResponse(page, "page=2");
        await clickPastBlockingDialogs(page, next);
        await waitForQueryParam(page, "page", "2");
        expect((await answered).status(), "the list call for page 2").toBe(200);
        await waitForInboxSettled(page);
        const second = await range();
        expect(second.text, `page 2 should read 26-N of the total (page 1 read ${first.text})`).toMatch(/^26-\d+ of \d+$/);
        expect(await previous.isEnabled(), "Previous page should be live on page 2").toBe(true);
        await clickPastBlockingDialogs(page, previous);
        await waitForQueryParam(page, "page", null);
        await waitForInboxSettled(page);
        expect((await range()).text, "Previous page should return to the first page").toMatch(/^1-\d+ of \d+$/);
      } else {
        expect(await next.count(), "a single page has no Next page button").toBe(0);
        expect(await previous.count(), "a single page has no Previous page button").toBe(0);
      }
    } finally {
      await context.close();
    }
  }, 120_000);
});
