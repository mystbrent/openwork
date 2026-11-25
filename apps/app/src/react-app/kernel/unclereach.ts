import type { AutomationDesktopRunnerRegistration } from "@openwork/types/automations";

export const DEFAULT_UNCLEREACH_BASE_URL = "https://app.unclereach.com/api/openwork";
export const uncleReachConfigChangedEvent = "openwork-unclereach-config-changed";

const STORAGE_KEY = "openwork.unclereach.runner";
const STORAGE_REJECTED_KEY = "openwork.unclereach.rejected";

export type UncleReachConfig = { baseUrl: string; token: string; runnerId: string };

export class UncleReachError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "UncleReachError";
    this.status = status;
  }
}

export function normalizeUncleReachBaseUrl(value: string): string | null {
  let parsed: URL;
  try { parsed = new URL(String(value).trim()); } catch { return null; }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)
    || parsed.hostname.endsWith(".localhost");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return null;
  if (parsed.username || parsed.password) return null;
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}

async function postToken(baseUrl: string, body: unknown, bearer?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const response = await fetch(`${baseUrl}/v1/session-runners/token`, { method: "POST", headers, body: JSON.stringify(body) });
  const json: unknown = await response.json().catch(() => null);
  const record = json instanceof Object ? json : {};
  if (!response.ok) {
    throw new UncleReachError("error" in record && typeof record.error === "string" ? record.error : `http_${response.status}`, response.status);
  }
  if (!("token" in record) || typeof record.token !== "string" || !record.token) throw new UncleReachError("invalid_response", response.status);
  return record.token;
}

function requireBaseUrl(baseUrl: string) {
  const normalized = normalizeUncleReachBaseUrl(baseUrl);
  if (!normalized) throw new UncleReachError("Base URL must be https (http only for localhost).", 0);
  return normalized;
}

export async function pairWithUncleReach(
  baseUrl: string,
  pairingCode: string,
  registration: AutomationDesktopRunnerRegistration,
): Promise<{ token: string; runnerId: string }> {
  const token = await postToken(requireBaseUrl(baseUrl), { pairingCode, registration });
  return { token, runnerId: registration.runnerId };
}

export function refreshUncleReachToken(config: UncleReachConfig): Promise<string> {
  return postToken(
    requireBaseUrl(config.baseUrl),
    { registration: { runnerId: config.runnerId } },
    config.token,
  );
}

function notifyChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(uncleReachConfigChangedEvent));
}

export function loadUncleReachConfig(): UncleReachConfig | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (parsed && typeof parsed.baseUrl === "string" && typeof parsed.token === "string" && typeof parsed.runnerId === "string") {
      return { baseUrl: parsed.baseUrl, token: parsed.token, runnerId: parsed.runnerId };
    }
  } catch {
    return null;
  }
  return null;
}

export function saveUncleReachConfig(config: UncleReachConfig, opts: { notify?: boolean } = {}) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  localStorage.removeItem(STORAGE_REJECTED_KEY);
  if (opts.notify !== false) notifyChanged();
}

export function clearUncleReachConfig() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(STORAGE_REJECTED_KEY);
  notifyChanged();
}

export function markUncleReachRejected() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.setItem(STORAGE_REJECTED_KEY, "1");
  notifyChanged();
}

export function wasUncleReachRejected() {
  try { return localStorage.getItem(STORAGE_REJECTED_KEY) === "1"; } catch { return false; }
}

export function subscribeUncleReachConfig(onChange: () => void) {
  window.addEventListener(uncleReachConfigChangedEvent, onChange);
  return () => window.removeEventListener(uncleReachConfigChangedEvent, onChange);
}

export type UncleReachStatus = "connected" | "rejected" | "not_paired";

export function readUncleReachStatus(): UncleReachStatus {
  if (loadUncleReachConfig()) return "connected";
  return wasUncleReachRejected() ? "rejected" : "not_paired";
}
