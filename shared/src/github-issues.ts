import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type IssueParams = {
  repo: string;
  title: string;
  body: string;
  labels?: string[];
};

export type IssueRef = {
  number: number;
  url: string;
  state: "open" | "closed";
};

export async function findIssueByTitle(repo: string, title: string): Promise<IssueRef | null> {
  const { stdout } = await exec("gh", [
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "all",
    "--search",
    `in:title "${title}"`,
    "--json",
    "number,url,state,title",
    "--limit",
    "10"
  ]);
  const list = JSON.parse(stdout) as Array<{
    number: number;
    url: string;
    state: string;
    title: string;
  }>;
  const exact = list.find((i) => i.title === title);
  if (!exact) return null;
  return { number: exact.number, url: exact.url, state: exact.state.toLowerCase() as "open" | "closed" };
}

export async function ensureIssueOpen(params: IssueParams): Promise<IssueRef> {
  const existing = await findIssueByTitle(params.repo, params.title);
  if (existing && existing.state === "open") {
    await exec("gh", [
      "issue",
      "comment",
      String(existing.number),
      "--repo",
      params.repo,
      "--body",
      `Reopened by automated QA run: still failing.\n\n${params.body}`
    ]);
    return existing;
  }
  if (existing && existing.state === "closed") {
    await exec("gh", ["issue", "reopen", String(existing.number), "--repo", params.repo]);
    await exec("gh", [
      "issue",
      "comment",
      String(existing.number),
      "--repo",
      params.repo,
      "--body",
      `Reopened — failure recurred.\n\n${params.body}`
    ]);
    return { ...existing, state: "open" };
  }
  const args = [
    "issue",
    "create",
    "--repo",
    params.repo,
    "--title",
    params.title,
    "--body",
    params.body
  ];
  if (params.labels && params.labels.length > 0) {
    args.push("--label", params.labels.join(","));
  }
  const { stdout } = await exec("gh", args);
  const url = stdout.trim();
  const numberMatch = url.match(/\/issues\/(\d+)/);
  const number = numberMatch ? Number(numberMatch[1]) : 0;
  return { number, url, state: "open" };
}

export async function closeIssueIfOpen(repo: string, title: string, comment: string): Promise<void> {
  const existing = await findIssueByTitle(repo, title);
  if (!existing || existing.state !== "open") return;
  await exec("gh", [
    "issue",
    "comment",
    String(existing.number),
    "--repo",
    repo,
    "--body",
    comment
  ]);
  await exec("gh", ["issue", "close", String(existing.number), "--repo", repo]);
}

export function failureIssueTitle(testId: string, description: string): string {
  return `[QA-FAIL] ${testId}: ${description.slice(0, 120)}`;
}
