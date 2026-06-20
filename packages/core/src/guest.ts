import type {
  DeploymentProgressListener,
  PortMapping,
} from "@le-space/shared-types";
import type { UcanStoreBootstrapPackage } from "@le-space/shared-types";

import type { FetchLike } from "./manifests.ts";

export type TcpProbeResult = {
  ok: boolean | null;
  error?: string;
};

export type HttpProbeResult = {
  ok: boolean;
  status?: number;
  url?: string;
  error?: string;
};

function proxyHostnameFromUrl(value: string | null | undefined): string | null {
  try {
    return value ? new URL(value).hostname : null;
  } catch {
    return null;
  }
}

async function defaultHttpProbe(
  fetch: FetchLike,
  url: string,
  timeoutMs = 10000,
): Promise<HttpProbeResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function notifyCrnAllocation(args: {
  crnUrl: string | null | undefined;
  itemHash: string;
  fetch: FetchLike;
}): Promise<{
  status: "confirmed" | "unconfirmed" | "skipped";
  reason?: string;
  payload?: unknown;
}> {
  const normalizedCrnUrl =
    typeof args.crnUrl === "string"
      ? args.crnUrl.trim().replace(/\/+$/, "")
      : "";
  if (!normalizedCrnUrl) {
    return {
      status: "skipped",
      reason: "No CRN URL available for allocation notification.",
    };
  }

  try {
    const response = await args.fetch(
      `${normalizedCrnUrl}/control/allocation/notify`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ instance: args.itemHash }),
      },
    );
    const payload = await response.json().catch(() => null);
    const responseText =
      payload == null
        ? ""
        : typeof payload === "string"
          ? payload
          : JSON.stringify(payload);

    if (!response.ok) {
      return {
        status: "unconfirmed",
        reason: `CRN allocation notify returned ${response.status}${responseText ? ` ${responseText}` : ""}.`,
        payload,
      };
    }

    return {
      status: "confirmed",
      payload,
    };
  } catch (error) {
    return {
      status: "unconfirmed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function isRetryableAllocationNotifyReason(
  reason: string | null | undefined,
): boolean {
  const normalized = String(reason ?? "").toLowerCase();

  return (
    normalized.includes("503") &&
    (normalized.includes("node hash not yet discovered") ||
      normalized.includes("cannot accept targeted allocations"))
  );
}

export async function notifyCrnAllocationWithRetry(args: {
  crnUrl: string | null | undefined;
  itemHash: string;
  fetch: FetchLike;
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: DeploymentProgressListener;
}): Promise<{
  status: "confirmed" | "unconfirmed" | "skipped";
  reason?: string;
  payload?: unknown;
}> {
  const attempts = Math.max(1, Number(args.attempts ?? 6));
  const delayMs = Math.max(0, Number(args.delayMs ?? 2000));
  const sleep =
    args.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  let lastResult: {
    status: "confirmed" | "unconfirmed" | "skipped";
    reason?: string;
    payload?: unknown;
  } | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    args.onProgress?.({
      stage: "notifying-crn",
      label: "Notifying selected CRN",
      progress: 84,
      status: "info",
      itemHash: args.itemHash,
      detail: `${attempt + 1}/${attempts} ${String(args.crnUrl ?? "").trim() || "selected CRN"}`,
      error: null,
      timestamp: Date.now(),
    });

    const result = await notifyCrnAllocation({
      crnUrl: args.crnUrl,
      itemHash: args.itemHash,
      fetch: args.fetch,
    });

    if (result.status === "confirmed" || result.status === "skipped") {
      return result;
    }

    lastResult = result;
    if (!isRetryableAllocationNotifyReason(result.reason)) {
      return result;
    }

    if (attempt < attempts - 1) {
      await sleep(delayMs);
    }
  }

  return (
    lastResult ?? {
      status: "unconfirmed",
      reason: "CRN allocation notify was not confirmed.",
    }
  );
}

export async function waitForSetupEndpoint(args: {
  hostIpv4: string;
  setupPort: number;
  fetch: FetchLike;
  attempts?: number;
  delayMs?: number;
  httpTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onAttempt?: (
    result: HttpProbeResult,
    attempt: number,
    attempts: number,
  ) => void;
}): Promise<HttpProbeResult> {
  const attempts = Math.max(1, Number(args.attempts ?? 15));
  const delayMs = Math.max(0, Number(args.delayMs ?? 4000));
  const sleep =
    args.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const url = `http://${args.hostIpv4}:${args.setupPort}/health`;

  let result = await defaultHttpProbe(
    args.fetch,
    url,
    Number(args.httpTimeoutMs ?? 10000),
  );
  args.onAttempt?.(result, 1, attempts);
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    if (result.ok) return result;
    await sleep(delayMs);
    result = await defaultHttpProbe(
      args.fetch,
      url,
      Number(args.httpTimeoutMs ?? 10000),
    );
    args.onAttempt?.(result, attempt + 1, attempts);
  }

  return result;
}

export async function configureUcGoPeer(args: {
  hostIpv4: string;
  setupPort: number;
  publicIpv6?: string | null;
  tcpPort?: number | null;
  wsPort?: number | null;
  udpPort?: number | null;
  quicPort?: number | null;
  webrtcPort?: number | null;
  proxyUrl?: string | null;
  bootstrapPublisherPrivateKey?: string | null;
  bootstrapPublisherLibp2pIdentityBase64?: string | null;
  bootstrapOwnerPrivateKey?: string | null;
  bootstrapOwnerAuthorizationBase64?: string | null;
  bootstrapRegistrationId?: string | null;
  noStart?: boolean;
  fetch: FetchLike;
  timeoutMs?: number;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Number(args.timeoutMs ?? 180000),
  );

  const payload = {
    public_ipv4: args.hostIpv4,
    public_ipv6: args.publicIpv6 ?? undefined,
    proxy_url: args.proxyUrl ?? undefined,
    tcp_port: args.tcpPort ?? undefined,
    ws_port: args.wsPort ?? undefined,
    udp_port: args.udpPort ?? undefined,
    quic_port: args.quicPort ?? undefined,
    webrtc_port: args.webrtcPort ?? undefined,
    bootstrap_publisher_private_key:
      args.bootstrapPublisherPrivateKey ?? undefined,
    bootstrap_publisher_libp2p_identity_b64:
      args.bootstrapPublisherLibp2pIdentityBase64 ?? undefined,
    bootstrap_owner_private_key: args.bootstrapOwnerPrivateKey ?? undefined,
    bootstrap_owner_authorization_b64:
      args.bootstrapOwnerAuthorizationBase64 ?? undefined,
    bootstrap_registration_id: args.bootstrapRegistrationId ?? undefined,
    no_start: args.noStart === true ? true : undefined,
  };

  try {
    const response = await args.fetch(
      `http://${args.hostIpv4}:${args.setupPort}/configure`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );
    const responsePayload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(
        `Relay setup request failed: ${response.status} ${typeof responsePayload === "string" ? responsePayload : JSON.stringify(responsePayload ?? {})}`,
      );
    }

    return responsePayload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function configureOrbitdbRelaySetup(args: {
  hostIpv4: string;
  setupPort: number;
  publicIpv6?: string | null;
  tcpPort: number;
  wsPort: number;
  metricsPort?: number | null;
  metricsHttpsPort?: number | null;
  webrtcPort?: number | null;
  quicPort?: number | null;
  proxyUrl?: string | null;
  bootstrapPublisherPrivateKey?: string | null;
  bootstrapPublisherLibp2pIdentityHex?: string | null;
  bootstrapOwnerPrivateKey?: string | null;
  bootstrapOwnerAuthorizationBase64?: string | null;
  bootstrapRegistrationId?: string | null;
  noStart?: boolean;
  fetch: FetchLike;
  timeoutMs?: number;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Number(args.timeoutMs ?? 180000),
  );

  const payload = {
    public_ipv4: args.hostIpv4,
    public_ipv6: args.publicIpv6 ?? undefined,
    tcp_port: args.tcpPort,
    ws_port: args.wsPort,
    proxy_url: args.proxyUrl ?? undefined,
    metrics_port: args.metricsPort ?? undefined,
    metrics_https_port: args.metricsHttpsPort ?? undefined,
    webrtc_port: args.webrtcPort ?? undefined,
    quic_port: args.quicPort ?? undefined,
    bootstrap_publisher_private_key:
      args.bootstrapPublisherPrivateKey ?? undefined,
    bootstrap_publisher_libp2p_identity_hex:
      args.bootstrapPublisherLibp2pIdentityHex ?? undefined,
    bootstrap_owner_private_key: args.bootstrapOwnerPrivateKey ?? undefined,
    bootstrap_owner_authorization_b64:
      args.bootstrapOwnerAuthorizationBase64 ?? undefined,
    bootstrap_registration_id: args.bootstrapRegistrationId ?? undefined,
    no_start: args.noStart === true ? true : undefined,
  };

  try {
    const response = await args.fetch(
      `http://${args.hostIpv4}:${args.setupPort}/configure`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );
    const responsePayload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(
        `Relay setup request failed: ${response.status} ${typeof responsePayload === "string" ? responsePayload : JSON.stringify(responsePayload ?? {})}`,
      );
    }

    return responsePayload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function configureUcanStore(args: {
  hostIpv4: string;
  setupPort: number;
  publicIpv6?: string | null;
  proxyUrl?: string | null;
  serviceDid?: string | null;
  serviceOrigin?: string | null;
  webauthnOrigin?: string | null;
  webauthnOriginFallbacks?: string | null;
  adminDid?: string | null;
  adminApiToken?: string | null;
  bootstrapPackage?: UcanStoreBootstrapPackage | null;
  noStart?: boolean;
  fetch: FetchLike;
  timeoutMs?: number;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Number(args.timeoutMs ?? 180000),
  );

  const payload = {
    public_ipv4: args.hostIpv4,
    public_ipv6: args.publicIpv6 ?? undefined,
    proxy_url: args.proxyUrl ?? undefined,
    service_did: args.serviceDid ?? undefined,
    service_origin: args.serviceOrigin ?? undefined,
    webauthn_origin: args.webauthnOrigin ?? undefined,
    webauthn_origin_fallbacks: args.webauthnOriginFallbacks ?? undefined,
    admin_did: args.adminDid ?? undefined,
    admin_api_token: args.adminApiToken ?? undefined,
    bootstrap_package: args.bootstrapPackage ?? undefined,
    no_start: args.noStart === true ? true : undefined,
  };

  try {
    const response = await args.fetch(
      `http://${args.hostIpv4}:${args.setupPort}/configure`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );
    const responsePayload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(
        `Service setup request failed: ${response.status} ${typeof responsePayload === "string" ? responsePayload : JSON.stringify(responsePayload ?? {})}`,
      );
    }

    return responsePayload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchUcGoPeerMetadata(args: {
  hostIpv4: string;
  setupPort: number;
  metadataUrl?: string | null;
  fetch: FetchLike;
  attempts?: number;
  delayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  isReady?: (result: {
    payload: unknown;
    ok: boolean;
    status: number | null;
    requestUrl: string;
  }) => boolean;
  onAttempt?: (result: {
    payload: unknown;
    ready: boolean;
    attempt: number;
    attempts: number;
    requestUrl: string;
    ok: boolean;
    status: number | null;
    error?: string | null;
  }) => void;
}): Promise<unknown> {
  const attempts = Math.max(1, Number(args.attempts ?? 60));
  const delayMs = Math.max(0, Number(args.delayMs ?? 3000));
  const sleep =
    args.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastPayload: unknown = null;
  let lastError: string | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Number(args.timeoutMs ?? 180000),
    );
    const requestUrl =
      args.metadataUrl && args.metadataUrl.trim()
        ? args.metadataUrl
        : `http://${args.hostIpv4}:${args.setupPort}/metadata`;
    try {
      const response = await args.fetch(
        requestUrl,
        {
          signal: controller.signal,
        },
      );
      const payload = await response.json().catch(() => null);
      lastPayload = payload;
      lastError = null;
      const ready = Boolean(
        args.isReady
          ? args.isReady({
              payload,
              ok: response.ok,
              status: response.status,
              requestUrl,
            })
          : response.ok &&
              payload &&
              typeof payload === "object" &&
              (payload as { status?: unknown }).status === "ready",
      );

      args.onAttempt?.({
        payload,
        ready,
        attempt: attempt + 1,
        attempts,
        requestUrl,
        ok: response.ok,
        status: response.status,
        error: null,
      });

      if (ready) {
        return payload;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      lastPayload = {
        error: lastError,
      };
      args.onAttempt?.({
        payload: null,
        ready: false,
        attempt: attempt + 1,
        attempts,
        requestUrl,
        ok: false,
        status: null,
        error: lastError,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < attempts - 1) {
      await sleep(delayMs);
    }
  }

  throw new Error(
    `Guest metadata did not become ready after ${attempts} attempts: ${
      lastError
        ? lastError
        : typeof lastPayload === "string"
          ? lastPayload
          : JSON.stringify(lastPayload ?? {})
    }`,
  );
}

export async function verifyUcGoPeerReachability(args: {
  hostIpv4?: string | null;
  mappedPorts?: Record<string, PortMapping>;
  proxyUrl?: string | null;
  verifyProxyHttp?: boolean;
  skipInternalPorts?: string[];
  tcpTimeoutMs?: number;
  httpTimeoutMs?: number;
  fetch: FetchLike;
  tcpProbe: (
    host: string,
    port: number,
    timeoutMs?: number,
  ) => Promise<TcpProbeResult>;
  httpProbe?: (url: string, timeoutMs?: number) => Promise<HttpProbeResult>;
}): Promise<{
  ok: boolean;
  checks: Record<string, Record<string, unknown>>;
}> {
  const checks: Record<string, Record<string, unknown>> = {};
  const mappedPorts = args.mappedPorts ?? {};
  const hostIpv4 = args.hostIpv4;
  const skippedInternalPorts = new Set(
    (args.skipInternalPorts ?? ["80"]).map((value) => String(value)),
  );
  const httpProbe =
    args.httpProbe ??
    ((url: string, timeoutMs?: number) =>
      defaultHttpProbe(args.fetch, url, timeoutMs));

  if (hostIpv4) {
    for (const [internalPort, mapping] of Object.entries(mappedPorts)) {
      if (skippedInternalPorts.has(String(internalPort))) continue;

      if (mapping?.tcp === true && mapping?.host) {
        checks[`tcp:${internalPort}`] = {
          host: hostIpv4,
          port: mapping.host,
          ...(await args.tcpProbe(
            hostIpv4,
            mapping.host,
            Number(args.tcpTimeoutMs ?? 5000),
          )),
        };
      } else if (mapping?.udp === true && mapping?.host) {
        checks[`udp:${internalPort}`] = {
          host: hostIpv4,
          port: mapping.host,
          ok: null,
          note: "UDP mapping published; CI does not perform an application-level UDP handshake probe.",
        };
      }
    }
  }

  if (args.proxyUrl && args.verifyProxyHttp !== false) {
    checks["https:proxy"] = await httpProbe(
      args.proxyUrl,
      Number(args.httpTimeoutMs ?? 10000),
    );
  }

  const proxyHostname = proxyHostnameFromUrl(args.proxyUrl);
  if (proxyHostname) {
    checks["tcp:proxy-443"] = await args.tcpProbe(
      proxyHostname,
      443,
      Number(args.tcpTimeoutMs ?? 5000),
    );
  }

  const failedChecks = Object.entries(checks).filter(
    ([, value]) => value?.ok === false,
  );
  return {
    ok: failedChecks.length === 0,
    checks,
  };
}
