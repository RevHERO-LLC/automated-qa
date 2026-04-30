// Cross-cutting — internal-services webhook auth (Round-7 fix verification).
// QA-FULL-014: email-ingress, sms-service, and deal-mover all expose webhook
// endpoints. The round-7 fix added an internal-services-auth middleware that
// rejects requests without the INTERNAL_SERVICES_WEBHOOK_SECRET shared header.
//
// These tests probe each webhook from "outside" (no auth header) and assert
// rejection. They MUST PASS on staging. If any returns 200 without auth,
// that's a CRITICAL regression worth blocking the deploy.
import { describe, test, expect } from "vitest";
import axios from "axios";
import { getAreaUrls } from "../../lib/context.js";

describe("Internal-services webhook auth (cross-service)", () => {
  test("WEBHOOK-AUTH-001 — email-ingress sentiment-webhook rejects without auth", async () => {
    const url = `${getAreaUrls().emailIngress}/v1/emails/sentiment-webhook`;
    const res = await axios.post(
      url,
      { email_id: 1, sentiment: "NEGATIVE" },
      { timeout: 30_000, validateStatus: () => true }
    );
    expect(
      [401, 403, 404, 405],
      `expected webhook to reject unauthenticated request; got status ${res.status}`
    ).toContain(res.status);
  });

  test("WEBHOOK-AUTH-002 — sms-service sentiment-webhook rejects without auth", async () => {
    const url = `${getAreaUrls().smsService}/v1/messages/sentiment-webhook`;
    const res = await axios.post(
      url,
      { message_id: 1, sentiment: "NEGATIVE" },
      { timeout: 30_000, validateStatus: () => true }
    );
    expect(
      [401, 403, 404, 405],
      `sms-service webhook returned ${res.status} without auth`
    ).toContain(res.status);
  });

  test("WEBHOOK-AUTH-003 — deal-mover sweeper rejects without auth", async () => {
    const url = `${getAreaUrls().dealMover}/v1/sweeper/run`;
    const res = await axios.get(url, { timeout: 30_000, validateStatus: () => true });
    expect(
      [401, 403, 404, 405],
      `deal-mover sweeper returned ${res.status} without auth`
    ).toContain(res.status);
  });
});
