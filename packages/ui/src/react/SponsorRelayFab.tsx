import React from "react";

import {
  formatDateTime,
  formatNumber,
  formatTierSpecLabel,
  joinMappedPorts,
  joinRequiredPortForwards,
  shortHash,
  type SponsorRelayProps,
  type SponsorRelayState,
} from "../shared/index";
import { useSponsorRelayController } from "./hooks/useSponsorRelayController";

const basePanelStyle: React.CSSProperties = {
  position: "fixed",
  zIndex: 9999,
  width: "min(28rem, calc(100vw - 2rem))",
  overflow: "auto",
  border:
    "1px solid var(--le-space-sponsor-relay-panel-border, rgba(199, 210, 254, 0.22))",
  borderRadius: "1.4rem",
  background:
    "var(--le-space-sponsor-relay-panel-bg, rgba(49, 46, 129, 0.94))",
  color: "#f8fafc",
  boxShadow:
    "var(--le-space-sponsor-relay-panel-shadow, 0 28px 80px rgba(49, 46, 129, 0.34))",
  padding: "1rem",
  fontFamily: '"DM Sans", "Inter", sans-serif',
};

const fieldStyle: React.CSSProperties = {
  width: "100%",
  borderRadius: "0.8rem",
  border: "1px solid rgba(255,255,255,0.16)",
  background: "rgba(248,250,252,0.98)",
  color: "#111827",
  padding: "0.7rem 0.85rem",
  fontFamily: '"DM Sans", "Inter", sans-serif',
  fontSize: "0.98rem",
  lineHeight: 1.45,
};

const themedLauncherBackground =
  "linear-gradient(135deg, var(--le-space-sponsor-relay-launcher-start, #4f46e5) 0%, var(--le-space-sponsor-relay-launcher-end, #6366f1) 100%)";
const themedLauncherBorder =
  "var(--le-space-sponsor-relay-launcher-border, rgba(199, 210, 254, 0.42))";
const themedLauncherBadgeBackground =
  "var(--le-space-sponsor-relay-launcher-badge-bg, rgba(49, 46, 129, 0.92))";
const themedLauncherBadgeBorder =
  "var(--le-space-sponsor-relay-launcher-badge-border, rgba(191, 219, 254, 0.24))";
const themedLauncherDot =
  "var(--le-space-sponsor-relay-launcher-dot, #f59e0b)";

function progressToneColor(
  status: "info" | "success" | "warning" | "error",
): string {
  switch (status) {
    case "success":
      return "#37d67a";
    case "warning":
      return "#ffc83f";
    case "error":
      return "#e91315";
    default:
      return "#0176ce";
  }
}

function progressBadgeLabel(stage: string): string {
  switch (stage) {
    case "building-delete-message":
    case "signing-delete-message":
    case "broadcasting-delete":
    case "delete-completed":
      return "DELETE";
    case "error":
      return "ERROR";
    case "completed":
      return "DONE";
    default:
      return "DEPLOY";
  }
}

const COMPLETED_PROGRESS_VISIBLE_MS = 12_000;

function isDeploymentProgressVisible(state: SponsorRelayState): boolean {
  const stage = state.deploymentProgress.stage;
  if (stage === "idle") {
    return false;
  }

  if (stage === "error") {
    return true;
  }

  if (stage === "completed") {
    return (
      Date.now() - state.deploymentProgress.timestamp <
      COMPLETED_PROGRESS_VISIBLE_MS
    );
  }

  return true;
}

function launcherIndicator(state: SponsorRelayState): {
  label: string;
  detail: string | null;
  tone: "info" | "success" | "warning" | "error";
} {
  if (
    state.deploymentProgress.stage !== "idle" &&
    state.deploymentProgress.stage !== "completed"
  ) {
    return {
      label:
        state.deploymentProgress.progress > 0
          ? `${Math.round(state.deploymentProgress.progress)}%`
          : progressBadgeLabel(state.deploymentProgress.stage),
      detail: state.deploymentProgress.label,
      tone: state.deploymentProgress.status,
    };
  }

  if (
    state.deploymentProgress.stage === "completed" &&
    isDeploymentProgressVisible(state)
  ) {
    return {
      label: "DONE",
      detail: state.deploymentProgress.label,
      tone: state.deploymentProgress.status === "error" ? "error" : "success",
    };
  }

  if (state.errorText) {
    return {
      label: "ERR",
      detail: state.errorText,
      tone: "error",
    };
  }

  if (!state.wallet.connected) {
    return {
      label: "WALLET",
      detail: "Connect MetaMask",
      tone: "warning",
    };
  }

  if (state.rootfsHealth.tone === "error") {
    return {
      label: "ROOTFS",
      detail: state.rootfsHealth.label,
      tone: "error",
    };
  }

  if (state.rootfsHealth.tone === "caution") {
    return {
      label: "CHECK",
      detail: state.rootfsHealth.label,
      tone: "warning",
    };
  }

  if (state.busy.refreshing) {
    return {
      label: "SYNC",
      detail: "Refreshing relay state",
      tone: "info",
    };
  }

  return {
    label: "READY",
    detail: state.selectedCrn?.name ?? "Ready to deploy",
    tone: "success",
  };
}

export function SponsorRelayFab(props: SponsorRelayProps) {
  const { controller, state } = useSponsorRelayController(props);
  const launcherMode = props.launcherMode ?? "floating";
  const indicator = launcherIndicator(state);
  const [successFlash, setSuccessFlash] = React.useState(false);
  const [hovered, setHovered] = React.useState(false);
  const launcherRef = React.useRef<HTMLButtonElement | null>(null);
  const [inlinePanelStyle, setInlinePanelStyle] =
    React.useState<React.CSSProperties | null>(null);
  const [compactInlineLabel, setCompactInlineLabel] = React.useState(false);

  React.useEffect(() => {
    if (
      state.deploymentProgress.stage !== "completed" ||
      state.deploymentProgress.status !== "success"
    ) {
      return;
    }

    setSuccessFlash(true);
    const timeout = window.setTimeout(() => {
      setSuccessFlash(false);
    }, 1400);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [
    state.deploymentProgress.stage,
    state.deploymentProgress.status,
    state.deploymentProgress.timestamp,
  ]);

  React.useEffect(() => {
    if (state.deploymentProgress.stage !== "completed") {
      return;
    }

    const timeout = window.setTimeout(() => {
      setSuccessFlash(false);
    }, COMPLETED_PROGRESS_VISIBLE_MS);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [state.deploymentProgress.stage, state.deploymentProgress.timestamp]);

  React.useEffect(() => {
    if (launcherMode !== "inline" || !state.open) {
      return;
    }

    const updateInlinePanelStyle = () => {
      const launcher = launcherRef.current;
      if (launcher == null) {
        return;
      }

      const rect = launcher.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const anchorRight = Math.max(16, viewportWidth - rect.right);
      const top = Math.max(72, rect.bottom + 12);

      setInlinePanelStyle({
        ...basePanelStyle,
        top,
        right: anchorRight,
        maxHeight: `calc(100vh - ${Math.min(viewportHeight - 16, top + 16)}px)`,
        width: "min(30rem, calc(100vw - 1.5rem))",
      });
    };

    updateInlinePanelStyle();
    window.addEventListener("resize", updateInlinePanelStyle);
    window.addEventListener("scroll", updateInlinePanelStyle, true);

    return () => {
      window.removeEventListener("resize", updateInlinePanelStyle);
      window.removeEventListener("scroll", updateInlinePanelStyle, true);
    };
  }, [launcherMode, state.open]);

  React.useEffect(() => {
    if (launcherMode !== "inline") {
      setCompactInlineLabel(false);
      return;
    }

    const updateCompactInlineLabel = () => {
      setCompactInlineLabel(window.innerWidth < 1240);
    };

    updateCompactInlineLabel();
    window.addEventListener("resize", updateCompactInlineLabel);

    return () => {
      window.removeEventListener("resize", updateCompactInlineLabel);
    };
  }, [launcherMode]);

  const progressActive =
    state.deploymentProgress.stage !== "idle" &&
    state.deploymentProgress.stage !== "completed" &&
    state.deploymentProgress.stage !== "error";
  const deploymentProgressVisible = isDeploymentProgressVisible(state);
  const pulseScale = progressActive ? 1.03 : hovered ? 1.015 : 1;
  const pulseShadow = progressActive
    ? `0 0 0 4px ${progressToneColor(indicator.tone)}22, 0 12px 28px rgba(15, 23, 42, 0.22)`
    : successFlash
      ? `0 0 0 5px rgba(55, 214, 122, 0.22), 0 14px 32px rgba(55, 214, 122, 0.22)`
      : launcherMode === "inline"
        ? hovered
          ? "var(--le-space-sponsor-relay-launcher-hover-shadow, 0 14px 30px rgba(79, 70, 229, 0.28))"
          : "var(--le-space-sponsor-relay-launcher-shadow, 0 10px 24px rgba(99, 102, 241, 0.22))"
        : undefined;
  const inlineButtonBackground = themedLauncherBackground;
  const inlineButtonBorder = `1px solid ${themedLauncherBorder}`;
  const inlineBadgeBackground = themedLauncherBadgeBackground;
  const inlineBadgeBorder = `1px solid ${themedLauncherBadgeBorder}`;
  const panelStyle =
    launcherMode === "inline"
      ? (inlinePanelStyle ?? {
          ...basePanelStyle,
          top: "4.75rem",
          right: "1rem",
          maxHeight: "calc(100vh - 6rem)",
          width: "min(30rem, calc(100vw - 1.5rem))",
        })
      : {
          ...basePanelStyle,
          right: "1.4rem",
          bottom: "11.5rem",
          maxHeight: "calc(100vh - 12.5rem)",
        };
  const launcherLabel =
    launcherMode === "inline" && compactInlineLabel ? "Relay" : "Sponsor Relay";

  return (
    <>
      <button
        ref={launcherRef}
        type="button"
        onClick={() => controller.toggleOpen()}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        title={indicator.detail ?? "Sponsor Relay"}
        style={{
          position: launcherMode === "floating" ? "fixed" : "relative",
          right: launcherMode === "floating" ? "1.4rem" : undefined,
          bottom: launcherMode === "floating" ? "5.8rem" : undefined,
          zIndex: launcherMode === "floating" ? 10000 : "auto",
          borderRadius: "999px",
          border:
            launcherMode === "floating"
              ? `2px solid ${themedLauncherBorder}`
              : inlineButtonBorder,
          background:
            launcherMode === "floating"
              ? themedLauncherBackground
              : inlineButtonBackground,
          color: "white",
          minHeight: launcherMode === "floating" ? undefined : "2.25rem",
          padding:
            launcherMode === "floating"
              ? "0.9rem 1.2rem"
              : "0.42rem 0.56rem 0.42rem 0.76rem",
          fontFamily: '"Epilogue", sans-serif',
          fontWeight: 700,
          fontSize: launcherMode === "floating" ? "0.84rem" : "0.73rem",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: launcherMode === "floating" ? "0.45rem" : "0.34rem",
          boxShadow: pulseShadow,
          transform: `translateY(${hovered && !progressActive ? "-1px" : "0"}) scale(${pulseScale})`,
          transition:
            "transform 180ms ease, box-shadow 220ms ease, background 220ms ease, border-color 220ms ease",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.36rem",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: launcherMode === "floating" ? "0.5rem" : "0.42rem",
              height: launcherMode === "floating" ? "0.5rem" : "0.42rem",
              borderRadius: "999px",
              background:
                launcherMode === "floating"
                  ? "rgba(255,255,255,0.96)"
                  : themedLauncherDot,
              boxShadow:
                launcherMode === "floating"
                  ? "0 0 0 3px rgba(255,255,255,0.22)"
                  : "0 0 0 3px var(--le-space-sponsor-relay-launcher-dot-ring, rgba(245, 158, 11, 0.18))",
            }}
          />
          <span>{launcherLabel}</span>
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.36rem",
            padding:
              launcherMode === "floating" ? "0.2rem 0.42rem" : "0.21rem 0.5rem",
            minWidth: launcherMode === "floating" ? undefined : "3.8rem",
            borderRadius: "999px",
            background:
              launcherMode === "floating"
                ? "rgba(15, 23, 42, 0.18)"
                : inlineBadgeBackground,
            border:
              launcherMode === "floating"
                ? "1px solid rgba(255,255,255,0.18)"
                : inlineBadgeBorder,
            fontSize: launcherMode === "floating" ? "0.62rem" : "0.61rem",
            fontWeight: launcherMode === "floating" ? 700 : 800,
            lineHeight: 1,
            letterSpacing: "0.08em",
            justifyContent: "center",
            boxShadow:
              launcherMode === "floating"
                ? undefined
                : `inset 0 1px 0 rgba(255,255,255,0.08), 0 6px 16px ${progressToneColor(indicator.tone)}22`,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: "0.42rem",
              height: "0.42rem",
              borderRadius: "999px",
              background: progressToneColor(indicator.tone),
              boxShadow: `0 0 0 ${progressActive ? "4px" : "3px"} ${progressToneColor(indicator.tone)}22`,
              transform: `scale(${progressActive ? 1.12 : successFlash ? 1.18 : 1})`,
              transition: "transform 180ms ease, box-shadow 220ms ease",
            }}
          />
          <span>{indicator.label}</span>
        </span>
      </button>

      {state.open ? (
        <div>
          <div
            onClick={() => controller.setOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 9998,
              background:
                "radial-gradient(circle at 88% 82%, var(--le-space-sponsor-relay-backdrop-accent, rgba(79, 70, 229, 0.2)), transparent 34%)",
            }}
          />
          <aside style={panelStyle}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: "0.75rem",
                alignItems: "center",
              }}
            >
              <div>
                <div
                  style={{
                    color: "#9fb2ca",
                    fontSize: "0.72rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                  }}
                >
                  Aleph VM credit deployer
                </div>
                <h2
                  style={{
                    margin: "0.2rem 0 0",
                    fontFamily: '"Epilogue", sans-serif',
                  }}
                >
                  Sponsor Relay
                </h2>
              </div>
              <button type="button" onClick={() => void controller.refresh()}>
                {state.busy.refreshing ? "Syncing" : "Refresh"}
              </button>
            </div>

            <p style={{ color: "#9fb2ca" }}>{state.statusText}</p>
            {state.errorText ? (
              <p style={{ color: "#ffd9d9" }}>{state.errorText}</p>
            ) : null}

            {deploymentProgressVisible ? (
              <div
                style={{
                  marginTop: "0.85rem",
                  padding: "0.75rem 0.8rem",
                  borderRadius: "1rem",
                  border: "1px solid rgba(255,255,255,0.1)",
                  background:
                    "linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.03))",
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "0.75rem",
                    alignItems: "center",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: "0.5rem",
                      alignItems: "center",
                      minWidth: 0,
                    }}
                  >
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        minWidth: "3.9rem",
                        padding: "0.22rem 0.45rem",
                        borderRadius: "999px",
                        background: `${progressToneColor(state.deploymentProgress.status)}22`,
                        color: progressToneColor(
                          state.deploymentProgress.status,
                        ),
                        fontSize: "0.64rem",
                        fontWeight: 800,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                      }}
                    >
                      {progressBadgeLabel(state.deploymentProgress.stage)}
                    </span>
                    <strong
                      style={{
                        fontSize: "0.84rem",
                        lineHeight: 1.2,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {state.deploymentProgress.label}
                    </strong>
                  </div>
                  <span
                    style={{
                      fontSize: "0.72rem",
                      color: "#9fb2ca",
                      fontFamily: '"DM Mono", monospace',
                    }}
                  >
                    {String(
                      Math.round(state.deploymentProgress.progress),
                    ).padStart(3, " ")}
                    %
                  </span>
                </div>
                <div
                  style={{
                    marginTop: "0.5rem",
                    width: "100%",
                    height: "0.34rem",
                    borderRadius: "999px",
                    background: "rgba(255,255,255,0.08)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${Math.max(0, Math.min(100, state.deploymentProgress.progress))}%`,
                      height: "100%",
                      borderRadius: "999px",
                      background: progressToneColor(
                        state.deploymentProgress.status,
                      ),
                      transition: "width 180ms ease",
                    }}
                  />
                </div>
                <div
                  style={{
                    marginTop: "0.45rem",
                    display: "grid",
                    gap: "0.28rem",
                  }}
                >
                  {state.deploymentProgress.itemHash ? (
                    <div
                      style={{
                        color: "#9fb2ca",
                        fontSize: "0.7rem",
                        fontFamily: '"DM Mono", monospace',
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      hash {shortHash(state.deploymentProgress.itemHash, 10, 8)}
                    </div>
                  ) : null}
                  {state.deploymentProgress.detail ? (
                    <div
                      style={{
                        color: "#9fb2ca",
                        fontSize: "0.72rem",
                        lineHeight: 1.3,
                        fontFamily:
                          state.deploymentProgress.detail.includes("0x") ||
                          state.deploymentProgress.detail.includes("Qm")
                            ? '"DM Mono", monospace'
                            : undefined,
                      }}
                    >
                      {state.deploymentProgress.detail}
                    </div>
                  ) : null}
                  {state.deploymentProgress.error ? (
                    <div
                      style={{
                        color: "#ffd9d9",
                        fontSize: "0.72rem",
                        lineHeight: 1.3,
                      }}
                    >
                      {state.deploymentProgress.error}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div
              style={{ display: "grid", gap: "0.75rem", marginTop: "0.9rem" }}
            >
              <input
                style={fieldStyle}
                value={state.instanceName}
                onChange={(event) =>
                  controller.setInstanceName(event.currentTarget.value)
                }
                placeholder="Instance name"
              />
              <select
                style={fieldStyle}
                value={state.pricingSummary.tier?.id ?? state.tierId}
                onChange={(event) =>
                  controller.setTierId(event.currentTarget.value)
                }
              >
                {(
                  state.pricingSummary.pricing?.tiers?.length
                    ? state.pricingSummary.pricing.tiers
                    : [{ id: state.tierId, compute_units: 1 }]
                ).map((tier) => {
                  const unit = state.pricingSummary.pricing?.compute_unit;
                  const vcpus = unit ? unit.vcpus * tier.compute_units : null;
                  const memoryMiB = unit
                    ? unit.memory_mib * tier.compute_units
                    : null;
                  const diskMiB = unit
                    ? unit.disk_mib * tier.compute_units
                    : null;

                  return (
                    <option key={tier.id} value={tier.id}>
                      {`${tier.id} ${formatTierSpecLabel(vcpus, memoryMiB, diskMiB)}`}
                    </option>
                  );
                })}
              </select>
              <div
                style={{
                  color: "#9fb2ca",
                  fontSize: "0.74rem",
                  lineHeight: 1.35,
                  marginTop: "-0.15rem",
                }}
              >
                {formatTierSpecLabel(
                  state.pricingSummary.vcpus,
                  state.pricingSummary.memoryMiB,
                  state.pricingSummary.diskMiB,
                )}
              </div>
              <details
                open={state.showAdvanced}
                onToggle={(event) =>
                  controller.setShowAdvanced(
                    (event.currentTarget as HTMLDetailsElement).open,
                  )
                }
              >
                <summary>Advanced</summary>
                <div
                  style={{
                    display: "grid",
                    gap: "0.75rem",
                    marginTop: "0.65rem",
                  }}
                >
                  <input
                    style={fieldStyle}
                    value={state.manifestUrl}
                    onChange={(event) =>
                      controller.setManifestUrl(event.currentTarget.value)
                    }
                    placeholder="Manifest URL"
                  />
                  <textarea
                    style={fieldStyle}
                    rows={3}
                    value={state.sshPublicKey}
                    onChange={(event) =>
                      controller.setSshPublicKey(event.currentTarget.value)
                    }
                    placeholder="SSH public key"
                  />
                  <details
                    open={state.showPasteManifest}
                    onToggle={(event) =>
                      controller.setShowPasteManifest(
                        (event.currentTarget as HTMLDetailsElement).open,
                      )
                    }
                  >
                    <summary>Paste Manifest</summary>
                    <textarea
                      style={{ ...fieldStyle, marginTop: "0.65rem" }}
                      rows={7}
                      value={state.manifestJson}
                      onChange={(event) =>
                        controller.setManifestJson(event.currentTarget.value)
                      }
                    />
                  </details>
                </div>
              </details>
            </div>

            <div style={{ display: "grid", gap: "0.55rem", marginTop: "1rem" }}>
              <div>
                {formatNumber(state.pricingSummary.availableCredits, 0)} credits
                available
              </div>
              <div>
                {formatNumber(state.pricingSummary.requiredCredits, 0)} credits
                required
              </div>
              <div>{state.rootfsHealth.label}</div>
              <div>
                {state.selectedCrn?.name ?? shortHash(state.selectedCrn?.hash)}
              </div>
              <div>
                Ports{" "}
                {joinRequiredPortForwards(
                  state.manifest?.requiredPortForwards ?? [],
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() =>
                void (state.wallet.connected
                  ? controller.deploy()
                  : controller.connectWallet())
              }
              style={{ width: "100%", marginTop: "1rem" }}
            >
              {state.wallet.connected
                ? state.busy.deploying
                  ? "Deploying…"
                  : "Deploy Relay"
                : "Connect MetaMask"}
            </button>

            {state.lastDeploymentHash ? (
              <p>Latest deployment: {shortHash(state.lastDeploymentHash)}</p>
            ) : null}

            {state.showInstances ? (
              <div
                style={{ marginTop: "1rem", display: "grid", gap: "0.7rem" }}
              >
                {state.instances.map((entry) => (
                  <details key={entry.instance.item_hash} open>
                    <summary>
                      {(entry.instance.content?.metadata?.name ?? "relay") +
                        " · " +
                        shortHash(entry.instance.item_hash)}
                    </summary>
                    <div
                      style={{
                        display: "grid",
                        gap: "0.35rem",
                        marginTop: "0.55rem",
                      }}
                    >
                      <div>Status: {entry.details.messageStatus}</div>
                      <div>Host IPv4: {entry.details.hostIpv4 ?? "-"}</div>
                      <div>IPv6: {entry.details.ipv6 ?? "-"}</div>
                      <div>VM IPv4: {entry.details.vmIpv4 ?? "-"}</div>
                      <div>SSH: {entry.details.sshCommand ?? "-"}</div>
                      <div>
                        Ports: {joinMappedPorts(entry.details.mappedPorts)}
                      </div>
                      <div>
                        Submitted:{" "}
                        {formatDateTime(
                          entry.instance.reception_time ?? entry.instance.time,
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          void controller.deleteInstance(
                            entry.instance.item_hash,
                          )
                        }
                      >
                        {state.busy.deletingInstanceHash ===
                        entry.instance.item_hash
                          ? "Deleting…"
                          : "Delete"}
                      </button>
                    </div>
                  </details>
                ))}
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}
    </>
  );
}

export default SponsorRelayFab;
