// Parses the markdown registry at qa-test-cases/test-registry.md and emits registry.json.
// Drops LinkedIn-related cases per scope decision (FE-LINK, FE-ACT-LIC, FE-ACT-LIM, FE-LIN, /admin/linkedIn admin cases).
// Run with: pnpm build:registry
//
// Usage:
//   tsx scripts/build-registry.ts <path-to-test-registry.md> <out-path>

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type Severity = "critical" | "high" | "medium" | "low";
type Role = "ADMIN" | "MEMBER" | "SUPER_ADMIN" | "ANY" | "PAID_ADMIN";
type TestType = "page-load" | "functional" | "destructive" | "security" | "performance" | "regression";

type RegistryEntry = {
  id: string;
  description: string;
  area: string;
  role: Role;
  type: TestType;
  severity: Severity;
  destructive: boolean;
  deps: string[];
  tags: string[];
  file: string | null;
  expected?: string;
  notes?: string;
  last_audited_at: string | null;
};

const LINKEDIN_PREFIXES = ["FE-LINK-", "FE-ACT-LIC-", "FE-ACT-LIM-", "FE-LIN-"];
const LINKEDIN_ADMIN_IDS = new Set(["FE-ADM-009", "FE-ADM-010", "FE-ADM-011"]);

const P0_AREAS = new Set(["FE-AUTH", "FE-REG", "FE-SETUP"]);

const SECTION_REGEX = /^###\s+(.+?)(?:\s+\((FE-[A-Z0-9-]+)\))?\s*$/;
const TEST_REGEX = /^-\s+\*\*(FE-[A-Z]+(?:-[A-Z]+)*-\d{3})\*\*\s+—\s+(.+)$/;
const TEST_REGEX_FALLBACK = /^-\s+\*\*(FE-[A-Z]+(?:-[A-Z]+)*-\d{3})\*\*\s+[—–-]\s+(.+)$/;
const E2E_REGEX = /^-\s+\*\*(FE-E2E-\d{3})\s+—\s+(.+?)\*\*\s*$/;
const E2E_REGEX_FALLBACK = /^-\s+\*\*(FE-E2E-\d{3})\s+[—–-]\s+(.+?)\*\*\s*$/;

function inferType(id: string, description: string): TestType {
  const idPrefix = id.replace(/-\d{3}$/, "");
  if (idPrefix === "FE-SEC" || idPrefix === "FE-ROLE") return "security";
  if (idPrefix === "FE-PERF") return "performance";
  if (idPrefix === "FE-CROSS") return "regression";
  if (/^renders|^lists|^shows|loads <|page renders|empty state shows/i.test(description)) {
    return "page-load";
  }
  if (/delete|cancel|disconnect|destructive|drop|wipe/i.test(description)) {
    return "destructive";
  }
  return "functional";
}

function inferSeverity(id: string): Severity {
  const idPrefix = id.replace(/-\d{3}$/, "");
  // CRITICAL: paths whose failure blocks deploys per the plan.
  if (idPrefix === "FE-AUTH" || idPrefix === "FE-SEC" || idPrefix === "FE-ROLE") return "critical";
  if (idPrefix === "FE-CRED" || idPrefix === "FE-E2E") return "critical";
  if (idPrefix === "FE-CROSS") return "high";
  if (idPrefix === "FE-REG" || idPrefix === "FE-SETUP") return "high";
  if (idPrefix === "FE-CAMP" || idPrefix === "FE-DEAL" || idPrefix === "FE-EMAIL") return "high";
  if (idPrefix === "FE-SMS-TW" || idPrefix === "FE-SMS-TOKY" || idPrefix === "FE-AI") return "high";
  if (idPrefix === "FE-PERF") return "medium";
  return "medium";
}

function inferRole(id: string, description: string): Role {
  if (id.startsWith("FE-ROLE-")) {
    if (/MEMBER/i.test(description)) return "MEMBER";
    return "ANY";
  }
  if (/as MEMBER|MEMBER role|MEMBER attempts/i.test(description)) return "MEMBER";
  if (/SUPER_ADMIN|super admin|super-admin/i.test(description)) return "SUPER_ADMIN";
  if (/paid plan|paid user|growth tier|paid admin/i.test(description)) return "PAID_ADMIN";
  return "ADMIN";
}

function inferDestructive(description: string): boolean {
  return /delete|cancel|disconnect|revoke|wipe|drop\s|reset/i.test(description);
}

function inferTags(id: string, description: string): string[] {
  const tags: string[] = [];
  const idPrefix = id.replace(/-\d{3}$/, "");
  if (P0_AREAS.has(idPrefix)) tags.push("p0");
  else if (
    ["FE-CAMP", "FE-DEAL-SEARCH", "FE-EMAIL", "FE-PHONE", "FE-SMS-TW", "FE-SMS-TOKY", "FE-DEAL", "FE-NOTIF", "FE-HELP", "FE-LAY", "FE-CROSS"].includes(idPrefix)
  ) {
    tags.push("p1");
  } else if (["FE-AI", "FE-E2E", "FE-ACT", "FE-CRM", "FE-CRED"].includes(idPrefix)) {
    tags.push("p2");
  } else if (idPrefix.startsWith("FE-ACT-")) {
    tags.push("p3");
  } else if (["FE-VM", "FE-CSV"].includes(idPrefix)) {
    tags.push("p4");
  } else if (["FE-ADM", "FE-ADM-PLAN", "FE-ADM-ADDON", "FE-ADM-PROMO"].includes(idPrefix)) {
    tags.push("p5");
  } else if (
    ["FE-SET-G", "FE-SET-S", "FE-SET-M", "FE-USER", "FE-SEAT", "FE-AH", "FE-SIG", "FE-MISC", "FE-PUR"].includes(idPrefix)
  ) {
    tags.push("p6");
  } else if (["FE-PERF", "FE-SEC", "FE-ROLE"].includes(idPrefix)) {
    tags.push("p7");
  }

  // Paid-plan flows — defer behind @paid tag per Phase 1 spec.
  if (id === "FE-REG-005" || id === "FE-REG-006" || id === "FE-REG-007" || id === "FE-REG-008") {
    // Plan-selection step needs the wizard to advance from step 1.
  }
  if (
    id >= "FE-REG-014" && id <= "FE-REG-020" ||
    /paid plan|paid user|growth tier|payment form|card number|stripe/i.test(description)
  ) {
    tags.push("paid");
  }

  if (/unsubscribe|negative sentiment|bounce|webhook/i.test(description)) tags.push("slow");
  if (/Toky/i.test(description)) tags.push("needs-toky");
  if (/Pipedrive|HubSpot|CRM/i.test(description)) tags.push("needs-pipedrive");
  if (/Microsoft|Outlook/i.test(description)) tags.push("needs-microsoft-oauth");
  if (/Google OAuth|fresh.*OAuth|consent flow/i.test(description)) tags.push("needs-google-oauth");
  if (/SUPER_ADMIN/i.test(description)) tags.push("needs-superadmin");

  return Array.from(new Set(tags));
}

function isLinkedInDropped(id: string): boolean {
  if (LINKEDIN_ADMIN_IDS.has(id)) return true;
  return LINKEDIN_PREFIXES.some((prefix) => id.startsWith(prefix));
}

function deriveArea(sectionName: string, prefix: string | undefined): string {
  if (sectionName) return sectionName.split(" (")[0]!.trim();
  return prefix ?? "Unknown";
}

async function main() {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error("Usage: tsx scripts/build-registry.ts <test-registry.md> <out.json>");
    process.exit(1);
  }
  const md = await readFile(inPath, "utf8");
  const lines = md.split(/\r?\n/);

  const allEntries: RegistryEntry[] = [];
  let descopedCount = 0;
  let currentArea = "";
  let currentPrefix: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const sectionMatch = line.match(SECTION_REGEX);
    if (sectionMatch) {
      currentArea = (sectionMatch[1] ?? "").trim();
      currentPrefix = sectionMatch[2];
      continue;
    }

    let id: string | undefined;
    let description: string | undefined;

    const e2eMatch = line.match(E2E_REGEX) ?? line.match(E2E_REGEX_FALLBACK);
    if (e2eMatch) {
      id = e2eMatch[1];
      const title = e2eMatch[2] ?? "";
      // E2E descriptions span multiple sub-bullets; use the title plus the first 2 step lines.
      const steps: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s+\d+\./.test(lines[j] ?? "")) {
        if (steps.length < 3) steps.push((lines[j] ?? "").trim());
        j++;
      }
      description = `${title}${steps.length ? " :: " + steps.join(" / ") : ""}`;
      i = j - 1;
    } else {
      const m = line.match(TEST_REGEX) ?? line.match(TEST_REGEX_FALLBACK);
      if (m) {
        id = m[1];
        description = m[2];
      }
    }

    if (!id || !description) continue;

    if (isLinkedInDropped(id)) {
      descopedCount++;
      continue;
    }

    const entry: RegistryEntry = {
      id,
      description: description.trim(),
      area: deriveArea(currentArea, currentPrefix),
      role: inferRole(id, description),
      type: inferType(id, description),
      severity: inferSeverity(id),
      destructive: inferDestructive(description),
      deps: [],
      tags: inferTags(id, description),
      file: null,
      last_audited_at: null
    };
    allEntries.push(entry);
  }

  // Dedupe by id (markdown sometimes references the same id twice).
  const byId = new Map<string, RegistryEntry>();
  for (const e of allEntries) {
    if (!byId.has(e.id)) byId.set(e.id, e);
  }
  const entries = Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));

  const total = entries.length + descopedCount;
  const out = {
    version: 1 as const,
    generated_at: new Date().toISOString(),
    source: path.basename(inPath),
    total,
    active: entries.length,
    descoped: descopedCount,
    entries
  };

  await writeFile(outPath, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`Wrote ${entries.length} active entries (${descopedCount} descoped) to ${outPath}`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
