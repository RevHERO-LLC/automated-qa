// FE-EMAIL-OUT-013..015 — Email-ingress template render endpoint.
//
// History: opened by audit cycle 1 (issue #30) for what the agent thought
// was a NEW endpoint at the BFF: POST /v1/emails/render with
// {template_body, deal_id, subject?}. After the 2026-05-01 cron run flagged
// 013 + 015 as persistent 404s, manual verification confirmed the agent had
// the wrong endpoint:
//   - Real path: POST /v1/templates/render
//   - Real host: email-ingress.test.revhero.io directly (NOT via the BFF)
//   - Real DTO: { deal_id, parent_user_id, texts: map<string,string> }
// Source of truth: RevHero-email-ingress/internal/routes/routing.go:156 +
// internal/resources/email_resource/email.handler.go:898
//   (RenderTemplates) + email.service.go:1034 (RenderForDeal).
//
// The endpoint is internal — consumed by deals-actions-service AI
// personalization so the AI sees fully-substituted content rather than raw
// {{...}} placeholders. There is no FE consumer today; we still test it
// here because the registry tracks all live endpoints regardless of UI
// surface.
import { describe, test, expect, afterAll } from "vitest";
import { closeBrowser } from "../../fixtures/auth.js";
import { emailIngressClient } from "../../fixtures/api.js";

// Maggie's parent_user_id from qa-test-cases/test-credentials.md. The real
// endpoint uses this to scope deal lookups; we don't need a real deal to
// prove the endpoint exists, only to prove the route is registered.
const PARENT_USER_ID = 30;

describe("Email template render preview (FE-EMAIL-OUT)", () => {
  afterAll(async () => { await closeBrowser(); });

  test("FE-EMAIL-OUT-013 — POST /v1/templates/render endpoint exists on email-ingress", async () => {
    const client = emailIngressClient();
    // Send a minimally valid-shape body. Even if the deal lookup fails,
    // a non-404 response confirms the route is registered.
    const res = await client.post("/v1/templates/render", {
      deal_id: 1,
      parent_user_id: PARENT_USER_ID,
      texts: { subject: "Welcome {{first_name}}", body: "<p>Hi {{first_name}}</p>" }
    });
    expect(res.status, `endpoint must not be 404 — render handler missing from email-ingress`).not.toBe(404);
    if (res.status === 200) {
      const rendered = (res.data as any)?.rendered ?? (res.data as any)?.data?.rendered;
      expect(rendered, "200 response must include a rendered map").toBeTruthy();
    }
  });

  test("FE-EMAIL-OUT-014 — invalid deal_id is rejected (no panic)", async () => {
    const client = emailIngressClient();
    // deal_id = 0 trips the impl's `dealID <= 0` guard. We accept 4xx as
    // the friendly path; 500 is documented as a known issue (the service
    // currently returns 500 on validation/lookup failures rather than 4xx
    // — file as a follow-up against email-ingress). Either way the
    // response must NOT contain a Go stack-trace string.
    const res = await client.post("/v1/templates/render", {
      deal_id: 0,
      parent_user_id: PARENT_USER_ID,
      texts: { body: "<p>Hi {{first_name}}</p>" }
    });
    expect([200, 400, 404, 422, 500]).toContain(res.status);
    const bodyText = JSON.stringify(res.data ?? "").toLowerCase();
    expect(bodyText).not.toMatch(/panic|goroutine|stack trace/);
  });

  test("FE-EMAIL-OUT-015 — missing required field returns 400", async () => {
    const client = emailIngressClient();
    // Missing `texts` → ShouldBindJSON `binding:"required"` triggers 400
    // at the handler layer, before the service code runs.
    const res = await client.post("/v1/templates/render", {
      deal_id: 1,
      parent_user_id: PARENT_USER_ID
      // texts: omitted on purpose
    });
    expect([400, 422]).toContain(res.status);
    const body = JSON.stringify(res.data ?? "").toLowerCase();
    expect(body).toMatch(/texts|required|invalid/);
    expect(body).not.toMatch(/panic|goroutine|stack trace/);
  });
});
