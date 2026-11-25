/** @jsxImportSource react */
import { useState, useSyncExternalStore } from "react";
import {
  REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY,
  REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY,
  REMOTE_SESSION_RECOVERY_RUNNER_CAPABILITY,
  type AutomationDesktopRunnerRegistration,
} from "@openwork/types/automations";
import {
  clearUncleReachConfig,
  DEFAULT_UNCLEREACH_BASE_URL,
  normalizeUncleReachBaseUrl,
  pairWithUncleReach,
  readUncleReachStatus,
  saveUncleReachConfig,
  subscribeUncleReachConfig,
  type UncleReachStatus,
} from "@/react-app/kernel/unclereach";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LayoutStack, LayoutSection, LayoutSectionHeader, LayoutSectionTitle } from "../settings-layout";

const STATUS_LABEL: Record<UncleReachStatus, string> = {
  connected: "Connected",
  rejected: "Rejected. Pair again.",
  not_paired: "Not paired",
};

export function UncleReachView({ getRunnerId }: { getRunnerId: () => string }) {
  const status = useSyncExternalStore(subscribeUncleReachConfig, readUncleReachStatus);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_UNCLEREACH_BASE_URL);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pair = async () => {
    setBusy(true);
    setError(null);
    try {
      const build = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("appBuildInfo");
      const registration: AutomationDesktopRunnerRegistration = {
        runnerId: getRunnerId(),
        protocolVersion: 1,
        supportedExecutionTargets: ["desktop"],
        capabilities: [
          REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY,
          REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY,
          REMOTE_SESSION_RECOVERY_RUNNER_CAPABILITY,
        ],
        appVersion: String(build?.version ?? "unknown"),
        platform: /Mac/i.test(navigator.userAgent) ? "darwin" : /Win/i.test(navigator.userAgent) ? "win32" : "linux",
        concurrency: 1,
      };
      const trimmed = baseUrl.trim();
      const paired = await pairWithUncleReach(trimmed, code.trim(), registration);
      saveUncleReachConfig({ baseUrl: normalizeUncleReachBaseUrl(trimmed) ?? trimmed, ...paired });
      setCode("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pairing failed.");
    } finally {
      setBusy(false);
    }
  };

  return <LayoutStack>
    <LayoutSection>
      <LayoutSectionHeader><LayoutSectionTitle>UncleReach</LayoutSectionTitle></LayoutSectionHeader>
      <p role="status" data-testid="unclereach-status" className="text-sm">{STATUS_LABEL[status]}</p>
      {status === "connected" ? <div>
        <Button size="sm" variant="outline" onClick={() => clearUncleReachConfig()}>Unpair</Button>
      </div> : <div className="flex max-w-md flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="unclereach-base-url">Base URL</Label>
          <Input id="unclereach-base-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={busy} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="unclereach-code">Pairing code</Label>
          <Input id="unclereach-code" value={code} placeholder="ABCD-EFGH" onChange={(e) => setCode(e.target.value)} disabled={busy} />
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div><Button size="sm" onClick={pair} disabled={busy || !code.trim() || !baseUrl.trim()}>{busy ? "Pairing..." : "Pair"}</Button></div>
      </div>}
    </LayoutSection>
  </LayoutStack>;
}
