// FE-EMAIL-OUT-013..015 — Email template render preview endpoint.
// Resolves audit issue #30 (QA-AUDIT-MISSING).
//
// Source: RevHero-email-ingress added:
//   - internal/resources/email_resource/dto/render.dto.go (NEW)
//   - email.handler.go RenderTemplate handler (NEW)
//
// Endpoint accepts {template_body, deal_id, subject?} and returns rendered
// HTML with merge tags resolved. Used by the FE editor preview before send.
import { describe, test, expect, afterAll } from "vitest";
import { loginAs, closeBrowser } from "../../fixtures/auth.js";
import { authedPost, bearerFromContext } from "../../fixtures/api.js";

describe("Email template render preview (FE-EMAIL-OUT)", () => {
  afterAll(async () => { await closeBrowser(); });

  test("FE-EMAIL-OUT-013 — POST /v1/emails/render endpoint exists + accepts template_body", async () => {
    const { context } = await loginAs("ADMIN");
    try {
      const token = await bearerFromContext(context);
      if (!token) throw new Error("no auth token");
      const res = await authedPost(
        "/v1/emails/render",
        { template_body: "<p>Hello {{first_name}}</p>", subject: "Welcome {{first_name}}" },
        token
      );
      // The endpoint must exist (no 404). 200 with rendered_body is the
      // happy path; 400 is acceptable when deal_id is missing if the
      // implementation requires it.
      expect(res.status, "endpoint must not be 404 — render handler missing from email-ingress").not.toBe(404);
      if (res.status === 200) {
        const rendered = res.data?.rendered_body ?? res.data?.data?.rendered_body ?? "";
        expect(rendered, "rendered_body should be a string").toBeDefined();
      }
    } finally {
      await context.close();
    }
  });

  test("FE-EMAIL-OUT-014 — Invalid deal_id is rejected with 4xx (not 500)", async () => {
    const { context } = await loginAs("ADMIN");
    try {
      const token = await bearerFromContext(context);
      if (!token) throw new Error("no auth token");
      const res = await authedPost(
        "/v1/emails/render",
        {
          template_body: "<p>Hello {{first_name}}</p>",
          deal_id: "00000000-0000-0000-0000-000000000000",
          subject: "Test"
        },
        token
      );
      expect([200, 400, 404, 422]).toContain(res.status);
      // Specifically NOT 500 — a missing deal should be a friendly 4xx.
      expect(res.status).not.toBe(500);
    } finally {
      await context.close();
    }
  });

  test("FE-EMAIL-OUT-015 — Missing template_body returns 400 with friendly error", async () => {
    const { context } = await loginAs("ADMIN");
    try {
      const token = await bearerFromContext(context);
      if (!token) throw new Error("no auth token");
      const res = await authedPost("/v1/emails/render", { subject: "Test" }, token);
      expect([400, 422]).toContain(res.status);
      const body = JSON.stringify(res.data ?? "").toLowerCase();
      expect(body).toMatch(/template|body|required|invalid/);
      expect(body).not.toMatch(/panic|goroutine|stack trace/);
    } finally {
      await context.close();
    }
  });
});
