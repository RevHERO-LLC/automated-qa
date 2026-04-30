// Typed HTTP client for the staging BFF and downstream microservices.
// Uses axios with a shared base instance per service. Auth tokens are
// resolved from a logged-in browser context via context.cookies().
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import type { BrowserContext } from "playwright";
import { getAreaUrls, getEnv } from "../lib/context.js";

let bff: AxiosInstance | null = null;
let smsService: AxiosInstance | null = null;
let dealMover: AxiosInstance | null = null;
let emailIngress: AxiosInstance | null = null;

export function bffClient(): AxiosInstance {
  if (!bff) {
    bff = axios.create({
      baseURL: getAreaUrls().bff,
      timeout: 30_000,
      validateStatus: () => true
    });
  }
  return bff;
}

export function smsServiceClient(): AxiosInstance {
  if (!smsService) {
    smsService = axios.create({
      baseURL: getAreaUrls().smsService,
      timeout: 30_000,
      validateStatus: () => true
    });
  }
  return smsService;
}

export function dealMoverClient(): AxiosInstance {
  if (!dealMover) {
    dealMover = axios.create({
      baseURL: getAreaUrls().dealMover,
      timeout: 60_000,
      validateStatus: () => true
    });
  }
  return dealMover;
}

export function emailIngressClient(): AxiosInstance {
  if (!emailIngress) {
    emailIngress = axios.create({
      baseURL: getAreaUrls().emailIngress,
      timeout: 30_000,
      validateStatus: () => true
    });
  }
  return emailIngress;
}

export async function bearerFromContext(context: BrowserContext): Promise<string | undefined> {
  const cookies = await context.cookies();
  const token = cookies.find((c) => c.name === "revhero_token" || c.name === "access_token");
  return token?.value;
}

export type LoginResponse = {
  status: number;
  data: any;
  cookies: { name: string; value: string; httpOnly?: boolean; secure?: boolean; sameSite?: string }[];
};

export async function bffLogin(email: string, password: string): Promise<LoginResponse> {
  const res = await bffClient().post(
    "/v1/auth/login",
    { email, password },
    { withCredentials: true }
  );
  const setCookie = (res.headers["set-cookie"] ?? []) as string[];
  const cookies = setCookie.map(parseSetCookie);
  return { status: res.status, data: res.data, cookies };
}

export async function bffRegister(payload: {
  email: string;
  password: string;
  first_name?: string;
  last_name?: string;
  role?: string;
}): Promise<AxiosResponse> {
  return bffClient().post("/v1/auth/register", payload);
}

export async function bffForgotPassword(email: string): Promise<AxiosResponse> {
  return bffClient().post("/v1/auth/forgot-password", { email });
}

export async function bffResetPassword(token: string, password: string): Promise<AxiosResponse> {
  return bffClient().post("/v1/auth/reset-password", { token, password });
}

export async function bffWhoAmI(token: string): Promise<AxiosResponse> {
  return authedGet("/v1/user/profile", token);
}

export async function authedGet(path: string, token: string, config: AxiosRequestConfig = {}): Promise<AxiosResponse> {
  return bffClient().get(path, {
    ...config,
    headers: { ...(config.headers ?? {}), authorization: `Bearer ${token}` }
  });
}

export async function authedPost(
  path: string,
  body: unknown,
  token: string,
  config: AxiosRequestConfig = {}
): Promise<AxiosResponse> {
  return bffClient().post(path, body, {
    ...config,
    headers: { ...(config.headers ?? {}), authorization: `Bearer ${token}` }
  });
}

export function internalServicesAuthHeader(): { authorization: string } {
  const env = getEnv();
  if (!env.INTERNAL_SERVICES_WEBHOOK_SECRET) {
    throw new Error("INTERNAL_SERVICES_WEBHOOK_SECRET not set");
  }
  return { authorization: `Bearer ${env.INTERNAL_SERVICES_WEBHOOK_SECRET}` };
}

function parseSetCookie(line: string) {
  const [first, ...rest] = line.split(";");
  if (!first) {
    return { name: "", value: "" };
  }
  const eq = first.indexOf("=");
  const name = eq >= 0 ? first.slice(0, eq).trim() : first.trim();
  const value = eq >= 0 ? first.slice(eq + 1).trim() : "";
  const lowered = rest.map((s) => s.trim().toLowerCase());
  const httpOnly = lowered.includes("httponly");
  const secure = lowered.includes("secure");
  const sameSite = rest.find((s) => s.trim().toLowerCase().startsWith("samesite"))?.split("=")[1]?.trim();
  const cookie: {
    name: string;
    value: string;
    httpOnly: boolean;
    secure: boolean;
    sameSite?: string;
  } = { name, value, httpOnly, secure };
  if (sameSite !== undefined) {
    cookie.sameSite = sameSite;
  }
  return cookie;
}
