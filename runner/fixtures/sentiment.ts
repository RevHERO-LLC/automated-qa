// Async wait for AI sentiment to be applied to a message or email row.
import { query } from "./db.js";
import { pollUntil } from "../lib/retry.js";

export type Sentiment = "POSITIVE" | "NEGATIVE" | "NEUTRAL" | "" | null;

export async function waitForMessageSentiment(args: {
  messageId: number;
  timeoutMs?: number;
}): Promise<Sentiment> {
  return pollUntil(
    async () => {
      const rows = await query<{ sentiment: string | null }>(
        "SELECT sentiment FROM messages WHERE id = $1 LIMIT 1",
        [args.messageId]
      );
      if (rows.length === 0) return null;
      const s = rows[0]!.sentiment;
      // Empty string + null both mean "not yet scored". Wait for a real value.
      return s && s.length > 0 ? (s as Sentiment) : null;
    },
    {
      timeoutMs: args.timeoutMs ?? 90_000,
      intervalMs: 2_000,
      description: `messages.id=${args.messageId} sentiment scored`
    }
  );
}

export async function waitForEmailSentiment(args: {
  emailId: number;
  timeoutMs?: number;
}): Promise<Sentiment> {
  return pollUntil(
    async () => {
      const rows = await query<{ sentiment: string | null }>(
        "SELECT sentiment FROM emails WHERE id = $1 LIMIT 1",
        [args.emailId]
      );
      if (rows.length === 0) return null;
      const s = rows[0]!.sentiment;
      return s && s.length > 0 ? (s as Sentiment) : null;
    },
    {
      timeoutMs: args.timeoutMs ?? 90_000,
      intervalMs: 2_000,
      description: `emails.id=${args.emailId} sentiment scored`
    }
  );
}
