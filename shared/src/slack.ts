import type { RunSummary } from "./registry-schema.js";

export type SlackBlock = {
  type: string;
  [key: string]: unknown;
};

export type SlackMessage = {
  text: string;
  blocks?: SlackBlock[];
};

export async function postSlack(webhookUrl: string, message: SlackMessage): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(`Slack webhook returned ${res.status}: ${body}`);
  }
}

export function buildQaSummaryMessage(summary: RunSummary, reportUrl?: string): SlackMessage {
  const emoji = summary.failed > 0 ? ":x:" : ":white_check_mark:";
  const headline =
    summary.failed > 0
      ? `${emoji} QA run failed: ${summary.failed}/${summary.total} CRITICAL`
      : `${emoji} QA run passed: ${summary.passed}/${summary.total}`;

  return {
    text: headline,
    blocks: [
      { type: "header", text: { type: "plain_text", text: headline } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Run:* \`${summary.run_id}\`` },
          { type: "mrkdwn", text: `*Duration:* ${humanDuration(summary.started_at, summary.finished_at)}` },
          { type: "mrkdwn", text: `*Pass:* ${summary.passed}` },
          { type: "mrkdwn", text: `*Fail:* ${summary.failed}` },
          { type: "mrkdwn", text: `*Skip:* ${summary.skipped}` },
          { type: "mrkdwn", text: `*Not exec:* ${summary.not_exec}` }
        ]
      },
      ...(reportUrl
        ? [
            {
              type: "section",
              text: { type: "mrkdwn", text: `<${reportUrl}|Open report>` }
            }
          ]
        : [])
    ]
  };
}

export type DeployStatus = "healthy" | "failed" | "timeout";

export function buildDeployMessage(args: {
  status: DeployStatus;
  repo: string;
  sha: string;
  prTitle: string;
  author: string;
  durationMs: number;
  serviceUrl?: string;
  runUrl: string;
}): SlackMessage {
  const sha = args.sha.slice(0, 7);
  if (args.status === "healthy") {
    return {
      text: `:white_check_mark: ${args.repo} @ ${sha} deployed`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:white_check_mark: *${args.repo}* @ \`${sha}\` "${args.prTitle}" deployed by ${args.author} in ${humanMs(args.durationMs)}`
          }
        },
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: `<${args.runUrl}|GitHub Actions run>` },
            ...(args.serviceUrl ? [{ type: "mrkdwn", text: `<${args.serviceUrl}|Service URL>` }] : [])
          ]
        }
      ]
    };
  }
  if (args.status === "failed") {
    return {
      text: `:x: ${args.repo} @ ${sha} deploy FAILED`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:x: *${args.repo}* @ \`${sha}\` deploy FAILED at Dokploy step`
          }
        },
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: `<${args.runUrl}|GitHub Actions run>` },
            { type: "mrkdwn", text: "Action: retry via `gh workflow run` or roll back via Dokploy UI" }
          ]
        }
      ]
    };
  }
  return {
    text: `:warning: ${args.repo} @ ${sha} deploy TIMEOUT`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:warning: *${args.repo}* @ \`${sha}\` deploy TIMEOUT — may still be rolling`
        }
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `<${args.runUrl}|GitHub Actions run>` },
          { type: "mrkdwn", text: "Check Dokploy UI and `docker service ps <swarm-name>`" }
        ]
      }
    ]
  };
}

function humanDuration(startIso: string, endIso: string): string {
  return humanMs(new Date(endIso).getTime() - new Date(startIso).getTime());
}

function humanMs(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem === 0 ? `${minutes}m` : `${minutes}m${rem}s`;
}
