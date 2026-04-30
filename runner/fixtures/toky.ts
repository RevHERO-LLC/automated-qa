// Toky BYOC inbound-webhook replay helper.
//
// The sms-service receives Toky inbound SMS via a webhook protected by HTTP
// Basic auth, where the password is decrypted from the carrier_credentials
// row (column basic_auth_password, AES-encrypted via ENCRYPTION_KEY). Real
// Toky doesn't deliver to staging from the public internet, so the test
// path is to fetch the carrier credential, decrypt the password, and POST
// a synthetic Toky payload to /v1/messages/webhook/toky/incoming with the
// right Authorization header.
import { createDecipheriv } from "node:crypto";
import { getAreaUrls, getEnv } from "../lib/context.js";
import { query } from "./db.js";
import axios, { AxiosResponse } from "axios";

export type TokyInboundPayload = {
  data: {
    direction: "inbound";
    from: string;
    to: string;
    message: string;
    ts: number;
    sms_id: string;
    phone_id: string;
  };
};

export function buildTokyInboundPayload(args: {
  from: string;
  to: string;
  message: string;
  smsId?: string;
  phoneId?: string;
  ts?: number;
}): TokyInboundPayload[] {
  return [
    {
      data: {
        direction: "inbound",
        from: args.from,
        to: args.to,
        message: args.message,
        ts: args.ts ?? Math.floor(Date.now() / 1000),
        sms_id: args.smsId ?? `sms-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        phone_id: args.phoneId ?? "phone-test-1"
      }
    }
  ];
}

export async function fetchTokyBasicAuth(carrierCredentialId: number): Promise<{
  username: string;
  password: string;
}> {
  const env = getEnv();
  if (!env.ENCRYPTION_KEY) {
    throw new Error("ENCRYPTION_KEY not set — cannot decrypt Toky webhook auth");
  }
  const rows = await query<{
    basic_auth_username: string;
    basic_auth_password_encrypted: Buffer;
  }>(
    `SELECT basic_auth_username, basic_auth_password_encrypted
     FROM carrier_credentials WHERE id = $1 LIMIT 1`,
    [carrierCredentialId]
  );
  if (rows.length === 0) {
    throw new Error(`carrier_credentials id=${carrierCredentialId} not found`);
  }
  const row = rows[0]!;
  const password = aes256Decrypt(row.basic_auth_password_encrypted, env.ENCRYPTION_KEY);
  return { username: row.basic_auth_username, password };
}

export async function replayTokyInbound(args: {
  carrierCredentialId: number;
  payload: TokyInboundPayload[];
}): Promise<AxiosResponse> {
  const { username, password } = await fetchTokyBasicAuth(args.carrierCredentialId);
  const url = `${getAreaUrls().smsService}/v1/messages/webhook/toky/incoming`;
  return axios.post(url, args.payload, {
    auth: { username, password },
    timeout: 30_000,
    validateStatus: () => true
  });
}

function aes256Decrypt(blob: Buffer, key: string): string {
  // The Go services use AES-256-GCM with a 12-byte nonce prepended to
  // the ciphertext. The key is hex-encoded (32 bytes = 64 hex chars).
  const keyBytes = Buffer.from(key, "hex");
  if (keyBytes.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must be 32-byte hex (got ${keyBytes.length} bytes)`);
  }
  const nonce = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(12, blob.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", keyBytes, nonce);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return dec.toString("utf8");
}
