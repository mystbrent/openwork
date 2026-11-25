import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  clearUncleReachConfig,
  loadUncleReachConfig,
  normalizeUncleReachBaseUrl,
  pairWithUncleReach,
  refreshUncleReachToken,
  saveUncleReachConfig,
  UncleReachError,
} from "../src/react-app/kernel/unclereach";

const registration = {
  runnerId: "runner-12345678",
  protocolVersion: 1,
  supportedExecutionTargets: ["desktop"],
  capabilities: [],
  appVersion: "1.0.0",
  platform: "darwin",
  concurrency: 1,
} as never;

const BASE = "https://app.unclereach.com/api/openwork";
const realFetch = globalThis.fetch;
const store = new Map<string, string>();
let calls: Array<{ url: string; init: RequestInit }> = [];

function stubFetch(status: number, body: unknown) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  store.clear();
  calls = [];
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("pairWithUncleReach posts the code and registration and returns the token", async () => {
  stubFetch(200, { token: "tok.sig", expiresAt: 1, eventsPath: "/v1/automation-runners/events" });
  const out = await pairWithUncleReach(`${BASE}/`, "abcd-efgh", registration);
  expect(out).toEqual({ token: "tok.sig", runnerId: "runner-12345678" });
  expect(calls[0].url).toBe(`${BASE}/v1/session-runners/token`);
  expect(calls[0].init.method).toBe("POST");
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ pairingCode: "abcd-efgh", registration });
});

test("pairWithUncleReach throws the server error on a non-2xx response", async () => {
  stubFetch(401, { error: "invalid_pairing_code" });
  const error = await pairWithUncleReach(BASE, "nope", registration).catch((e) => e);
  expect(error).toBeInstanceOf(UncleReachError);
  expect(error.message).toBe("invalid_pairing_code");
  expect(error.status).toBe(401);
});

test("rejects base URLs the desktop runner would refuse", async () => {
  expect(normalizeUncleReachBaseUrl("http://app.unclereach.com/api/openwork")).toBeNull();
  expect(normalizeUncleReachBaseUrl("not a url")).toBeNull();
  expect(normalizeUncleReachBaseUrl("http://localhost:3001/api/openwork/")).toBe("http://localhost:3001/api/openwork");
  expect(normalizeUncleReachBaseUrl(`${BASE}//`)).toBe(BASE);
  await expect(pairWithUncleReach("http://evil.example/x", "c", registration)).rejects.toThrow(/https/);
  expect(calls).toHaveLength(0);
});

test("refreshUncleReachToken uses the bearer and no pairing code", async () => {
  stubFetch(200, { token: "new.sig", expiresAt: 2, eventsPath: "/e" });
  const out = await refreshUncleReachToken({ baseUrl: BASE, token: "old.sig", runnerId: "runner-12345678" });
  expect(out).toBe("new.sig");
  expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer old.sig");
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ registration: { runnerId: "runner-12345678" } });
});

// In the desktop app the renderer's origin is null (or the Vite dev origin), so a renderer fetch to
// UncleReach is a CORS preflight the server refuses. Pairing and refresh must go through the main process.
function installDesktopBridge() {
  const ipc: Array<{ command: string; url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  const originalWindow = (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    __OPENWORK_ELECTRON__: { invokeDesktop: async (command: string, url: string, init: typeof ipc[number]["init"]) => {
      ipc.push({ command, url, init });
      return { status: 200, statusText: "OK", headers: [["content-type", "application/json"]], body: JSON.stringify({ token: "main.sig", expiresAt: 1, eventsPath: "/e" }) };
    } },
  } });
  globalThis.fetch = (async () => { throw new Error("renderer fetch must not be used on desktop"); }) as unknown as typeof fetch;
  return { ipc, restore: () => Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow }) };
}

test("on desktop, pairing goes through the main-process fetch, not the renderer's", async () => {
  const bridge = installDesktopBridge();
  try {
    const out = await pairWithUncleReach(BASE, "abcd-efgh", registration);
    expect(out).toEqual({ token: "main.sig", runnerId: "runner-12345678" });
    expect(bridge.ipc).toHaveLength(1);
    expect(bridge.ipc[0].command).toBe("__fetch");
    expect(bridge.ipc[0].url).toBe(`${BASE}/v1/session-runners/token`);
    expect(bridge.ipc[0].init.method).toBe("POST");
    expect(JSON.parse(String(bridge.ipc[0].init.body))).toEqual({ pairingCode: "abcd-efgh", registration });
  } finally { bridge.restore(); }
});

test("on desktop, token refresh goes through the main-process fetch with the bearer", async () => {
  const bridge = installDesktopBridge();
  try {
    const out = await refreshUncleReachToken({ baseUrl: BASE, token: "old.sig", runnerId: "runner-12345678" });
    expect(out).toBe("main.sig");
    expect(bridge.ipc).toHaveLength(1);
    expect(bridge.ipc[0].command).toBe("__fetch");
    expect(bridge.ipc[0].init.headers?.authorization).toBe("Bearer old.sig");
  } finally { bridge.restore(); }
});

test("config round-trips through storage and clears", () => {
  expect(loadUncleReachConfig()).toBeNull();
  saveUncleReachConfig({ baseUrl: BASE, token: "t.s", runnerId: "runner-12345678" });
  expect(loadUncleReachConfig()).toEqual({ baseUrl: BASE, token: "t.s", runnerId: "runner-12345678" });
  clearUncleReachConfig();
  expect(loadUncleReachConfig()).toBeNull();
});
