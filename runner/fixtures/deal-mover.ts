// Deal-mover sweeper trigger + worker poll helpers.
import axios, { AxiosResponse } from "axios";
import { getAreaUrls, getEnv } from "../lib/context.js";
import { query } from "./db.js";
import { pollUntil } from "../lib/retry.js";

export type SweepResponse = {
  jobs_scheduled: number;
};

export async function triggerSweep(): Promise<AxiosResponse> {
  const env = getEnv();
  const url = `${getAreaUrls().dealMover}/v1/sweeper/run`;
  const headers: Record<string, string> = {};
  if (env.INTERNAL_SERVICES_WEBHOOK_SECRET) {
    headers.authorization = `Bearer ${env.INTERNAL_SERVICES_WEBHOOK_SECRET}`;
  }
  return axios.get(url, {
    headers,
    timeout: 60_000,
    validateStatus: () => true
  });
}

export async function getScheduledStages(): Promise<AxiosResponse> {
  const url = `${getAreaUrls().dealMover}/v1/stages/scheduled`;
  return axios.get(url, { timeout: 30_000, validateStatus: () => true });
}

export async function getMovedStages(): Promise<AxiosResponse> {
  const url = `${getAreaUrls().dealMover}/v1/stages/moved`;
  return axios.get(url, { timeout: 30_000, validateStatus: () => true });
}

// Wait for a deal to advance past `fromStageId` to a different stage.
// Resolves with the new stage_id or rejects on timeout.
export async function waitForDealMoved(args: {
  dealId: number;
  fromStageId: number;
  timeoutMs?: number;
}): Promise<{ stage_id: number; entered_stage_at: string } | null> {
  return pollUntil(
    async () => {
      const rows = await query<{ stage_id: number; entered_stage_at: string }>(
        "SELECT stage_id, entered_stage_at FROM deals WHERE id = $1 LIMIT 1",
        [args.dealId]
      );
      if (rows.length === 0) return null;
      const row = rows[0]!;
      if (row.stage_id !== args.fromStageId) return row;
      return null;
    },
    {
      timeoutMs: args.timeoutMs ?? 30_000,
      intervalMs: 1_000,
      description: `deal ${args.dealId} moves from stage ${args.fromStageId}`
    }
  );
}
