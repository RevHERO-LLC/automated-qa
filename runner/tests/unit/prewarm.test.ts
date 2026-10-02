import { describe, expect, it } from "vitest";
import { prewarmAllRoles } from "../../lib/prewarm.js";
import type { AuthRole } from "../../fixtures/auth.js";

const ROLES: readonly AuthRole[] = ["ADMIN", "PAID_ADMIN", "MEMBER", "SUPER_ADMIN"];

describe("prewarmAllRoles (fail-open global pre-warm)", () => {
  it("warms every role, serially and in order, when all succeed", async () => {
    const calls: AuthRole[] = [];
    const res = await prewarmAllRoles(ROLES, async (r) => {
      calls.push(r);
    }, () => {});
    expect(calls).toEqual(ROLES);
    expect(res).toEqual({ warmed: [...ROLES], skipped: [] });
  });

  it("skips a role with no configured credentials instead of aborting the suite (2026-10-02 regression)", async () => {
    const warnings: string[] = [];
    const res = await prewarmAllRoles(
      ROLES,
      async (r) => {
        if (r === "SUPER_ADMIN") throw new Error("SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD not set");
      },
      (m) => warnings.push(m)
    );
    expect(res.warmed).toEqual(["ADMIN", "PAID_ADMIN", "MEMBER"]);
    expect(res.skipped).toEqual(["SUPER_ADMIN"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("prewarmLogin(SUPER_ADMIN) skipped");
    expect(warnings[0]).toContain("not set");
  });

  it("keeps going after an early role fails (e.g. 429 budget exhausted)", async () => {
    const calls: AuthRole[] = [];
    const res = await prewarmAllRoles(
      ROLES,
      async (r) => {
        calls.push(r);
        if (r === "ADMIN") throw new Error("could not log in within the 16-minute budget");
      },
      () => {}
    );
    expect(calls).toEqual(ROLES);
    expect(res.skipped).toEqual(["ADMIN"]);
    expect(res.warmed).toEqual(["PAID_ADMIN", "MEMBER", "SUPER_ADMIN"]);
  });
});
