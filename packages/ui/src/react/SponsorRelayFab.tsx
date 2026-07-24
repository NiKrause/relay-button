import React from "react";

import {
  UI_PACKAGE_VERSION,
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

/*
 * Relay Button widget theme — Le-Space brand system (Style Guide V1.0).
 * Dark ("Deep Space") is the default; light mode activates below any
 * ancestor with `data-theme="light"` or `data-relay-theme="light"`.
 * Host pages may still override via the public
 * `--le-space-sponsor-relay-*` custom properties.
 */
const THEME_CSS = `
:root {
  --rb-font-body: "Inter", -apple-system, "Segoe UI", Roboto, sans-serif;
  --rb-font-heading: var(--rb-font-body);
  --rb-font-mono: "JetBrains Mono", ui-monospace, "SFMono-Regular", "Noto Sans Mono", Menlo, monospace;
  --rb-border: #232b3d;
  --rb-text: #edf1f8;
  --rb-muted: #a8b3c7;
  --rb-comet: #6b7690;
  --rb-coral: #ff6b5b;
  --rb-cyan: #58c7f3;
  --rb-success: #3edc97;
  --rb-warning: #ffc24b;
  --rb-danger: #ff4d6a;
  --rb-panel-bg: rgba(20, 25, 38, 0.97);
  --rb-panel-shadow: 0 28px 80px rgba(4, 6, 12, 0.55);
  --rb-surface: rgba(11, 14, 21, 0.55);
  --rb-field-bg: rgba(11, 14, 21, 0.85);
  --rb-accent: var(--rb-coral);
  --rb-accent-contrast: #0b0e15;
  --rb-link: var(--rb-cyan);
  --rb-launcher-start: #10151f;
  --rb-launcher-end: #0b0e15;
  --rb-launcher-text: #edf1f8;
  --rb-launcher-badge-bg: rgba(20, 25, 38, 0.92);
  --rb-backdrop-accent: rgba(255, 107, 91, 0.14);
}
[data-theme="light"],
[data-relay-theme="light"] {
  --rb-border: #d9e0ec;
  --rb-text: #141b2e;
  --rb-muted: #4d5a74;
  --rb-comet: #6b7690;
  --rb-coral: #e8503f;
  --rb-cyan: #0e86c4;
  --rb-success: #0f9d6a;
  --rb-warning: #a8690a;
  --rb-danger: #d5365a;
  --rb-panel-bg: rgba(255, 255, 255, 0.98);
  --rb-panel-shadow: 0 28px 80px rgba(20, 27, 46, 0.18);
  --rb-surface: rgba(20, 27, 46, 0.04);
  --rb-field-bg: #ffffff;
  --rb-accent-contrast: #ffffff;
  --rb-launcher-start: #ffffff;
  --rb-launcher-end: #f2f5fa;
  --rb-launcher-text: #141b2e;
  --rb-launcher-badge-bg: rgba(20, 27, 46, 0.05);
  --rb-backdrop-accent: rgba(232, 80, 63, 0.1);
}
@keyframes leSpaceRelayPulse { 0%, 100% { transform: scale(1); opacity: 0.74; } 50% { transform: scale(1.22); opacity: 1; } }
`;

const basePanelStyle: React.CSSProperties = {
  position: "fixed",
  zIndex: 9999,
  width: "min(28rem, calc(100vw - 2rem))",
  maxWidth: "calc(100vw - 2rem)",
  minWidth: 0,
  boxSizing: "border-box",
  overflowX: "hidden",
  overflowY: "auto",
  overflowWrap: "anywhere",
  wordBreak: "break-word",
  border:
    "1px solid var(--le-space-sponsor-relay-panel-border, var(--rb-border))",
  borderRadius: "0.625rem",
  background:
    "var(--le-space-sponsor-relay-panel-bg, var(--rb-panel-bg))",
  color: "var(--rb-text)",
  boxShadow:
    "var(--le-space-sponsor-relay-panel-shadow, var(--rb-panel-shadow))",
  padding: "1rem",
  fontFamily: "var(--rb-font-body)",
  fontSize: "0.8125rem",
  lineHeight: 1.5,
};

const fieldStyle: React.CSSProperties = {
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  borderRadius: "0.5rem",
  border: "1px solid var(--rb-border)",
  background: "var(--rb-field-bg)",
  color: "var(--rb-text)",
  padding: "0.65rem 0.8rem",
  fontFamily: "var(--rb-font-body)",
  fontSize: "0.8125rem",
  lineHeight: 1.4,
};

const secondaryButtonStyle: React.CSSProperties = {
  borderRadius: "0.5rem",
  border: "1px solid var(--rb-border)",
  background: "var(--rb-surface)",
  color: "var(--rb-text)",
  padding: "0.65rem 0.9rem",
  fontFamily: "var(--rb-font-body)",
  fontSize: "0.8125rem",
  fontWeight: 600,
  lineHeight: 1.1,
  cursor: "pointer",
};

const primaryButtonStyle: React.CSSProperties = {
  boxSizing: "border-box",
  borderRadius: "0.5rem",
  border: "1px solid transparent",
  background: "var(--rb-accent)",
  color: "var(--rb-accent-contrast)",
  padding: "0.78rem 1rem",
  fontFamily: "var(--rb-font-body)",
  fontSize: "0.875rem",
  fontWeight: 700,
  lineHeight: 1.1,
  cursor: "pointer",
  boxShadow: "0 10px 24px rgba(255, 107, 91, 0.22)",
};

const containedContentStyle: React.CSSProperties = {
  minWidth: 0,
  maxWidth: "100%",
  boxSizing: "border-box",
  overflowWrap: "anywhere",
  wordBreak: "break-word",
  whiteSpace: "normal",
};

const dangerButtonStyle: React.CSSProperties = {
  borderRadius: "0.5rem",
  border: "1px solid rgba(255, 77, 106, 0.45)",
  background: "transparent",
  color: "var(--rb-danger)",
  padding: "0.65rem 0.9rem",
  fontFamily: "var(--rb-font-body)",
  fontSize: "0.8125rem",
  fontWeight: 600,
  lineHeight: 1.1,
  cursor: "pointer",
};

const warningButtonStyle: React.CSSProperties = {
  borderRadius: "0.5rem",
  border: "1px solid rgba(255, 194, 75, 0.45)",
  background: "transparent",
  color: "var(--rb-warning)",
  padding: "0.65rem 0.9rem",
  fontFamily: "var(--rb-font-body)",
  fontSize: "0.8125rem",
  fontWeight: 600,
  lineHeight: 1.1,
  cursor: "pointer",
};

const themedLauncherBackground =
  "linear-gradient(135deg, var(--le-space-sponsor-relay-launcher-start, var(--rb-launcher-start)) 0%, var(--le-space-sponsor-relay-launcher-end, var(--rb-launcher-end)) 100%)";
const themedLauncherBorder =
  "var(--le-space-sponsor-relay-launcher-border, var(--rb-border))";
const themedLauncherBadgeBackground =
  "var(--le-space-sponsor-relay-launcher-badge-bg, var(--rb-launcher-badge-bg))";
const themedLauncherBadgeBorder =
  "var(--le-space-sponsor-relay-launcher-badge-border, var(--rb-border))";

function progressToneColor(
  status: "info" | "success" | "warning" | "error",
): string {
  switch (status) {
    case "success":
      return "#3edc97";
    case "warning":
      return "#ffc24b";
    case "error":
      return "#ff4d6a";
    default:
      return "#58c7f3";
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
const POLLING_STAGES = new Set([
  "waiting-for-aleph",
  "deployment-confirmed",
  "publishing-bootstrap",
  "refreshing-instances",
]);

function stateDeploymentProfile(
  state: SponsorRelayState,
): "ucan-store" | "relay" {
  return state.manifest?.profile === "ucan-store" ? "ucan-store" : "relay";
}

function supportsBootstrapUi(state: SponsorRelayState): boolean {
  return stateDeploymentProfile(state) !== "ucan-store";
}

function deploymentPanelTitle(state: SponsorRelayState): string {
  return stateDeploymentProfile(state) === "ucan-store"
    ? "Sponsor Service"
    : "Relay Button";
}

function deploymentLauncherLabel(
  state: SponsorRelayState,
  compactInlineLabel: boolean,
  launcherMode: "floating" | "inline",
): string {
  if (launcherMode === "inline" && compactInlineLabel) {
    return stateDeploymentProfile(state) === "ucan-store" ? "Service" : "Relay";
  }
  return deploymentPanelTitle(state);
}

function deploymentInstanceFallbackLabel(state: SponsorRelayState): string {
  return stateDeploymentProfile(state) === "ucan-store" ? "service" : "relay";
}

function deploymentButtonLabel(state: SponsorRelayState): string {
  return stateDeploymentProfile(state) === "ucan-store"
    ? "Deploy Service"
    : "Deploy Relay";
}

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

function pollingIndicator(state: SponsorRelayState): {
  label: string;
  detail: string;
} | null {
  if (state.busy.refreshing) {
    const isService = stateDeploymentProfile(state) === "ucan-store";
    return {
      label: isService ? "Checking deployment state" : "Checking relay state",
      detail:
        state.statusText ||
        (isService
          ? "Refreshing service deployment data from Aleph and the selected CRN."
          : "Refreshing relay deployment data from Aleph and the selected CRN."),
    };
  }

  if (!POLLING_STAGES.has(state.deploymentProgress.stage)) {
    return null;
  }

  const isService = stateDeploymentProfile(state) === "ucan-store";
  return {
    label:
      state.deploymentProgress.label ||
      (isService ? "Polling deployment state" : "Polling relay state"),
    detail:
      state.deploymentProgress.detail ||
      state.statusText ||
      (isService
        ? "Waiting for the next confirmed deployment state from Aleph."
        : "Waiting for the next confirmed relay state from Aleph."),
  };
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
      detail:
        stateDeploymentProfile(state) === "ucan-store"
          ? "Refreshing deployment state"
          : "Refreshing relay state",
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
  const explicitVersion = typeof props.version === "string" ? props.version.trim() : "";
  const resolvedVersion = explicitVersion || UI_PACKAGE_VERSION;
  const versionLabel = resolvedVersion.startsWith("v") ? resolvedVersion : `v${resolvedVersion}`;
  const launcherMode = props.launcherMode ?? "floating";
  const indicator = launcherIndicator(state);
  const bootstrapUiEnabled = supportsBootstrapUi(state);
  const confirmedRegistrationByInstanceHash = new Map(
    (state.bootstrapRegistrations ?? [])
      .filter((entry) => entry.confirmed && entry.instanceItemHash)
      .map((entry) => [entry.instanceItemHash as string, entry]),
  );
  const orphanRegistrations = state.orphanBootstrapRegistrations ?? [];
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
  const pollingState = pollingIndicator(state);
  const pulseScale = progressActive ? 1.03 : hovered ? 1.015 : 1;
  const pulseShadow = progressActive
    ? `0 0 0 4px ${progressToneColor(indicator.tone)}22, 0 12px 28px rgba(15, 23, 42, 0.22)`
    : successFlash
      ? `0 0 0 5px rgba(55, 214, 122, 0.22), 0 14px 32px rgba(55, 214, 122, 0.22)`
      : launcherMode === "inline"
        ? hovered
          ? "var(--le-space-sponsor-relay-launcher-hover-shadow, 0 14px 30px rgba(4, 6, 12, 0.5))"
          : "var(--le-space-sponsor-relay-launcher-shadow, 0 10px 24px rgba(4, 6, 12, 0.4))"
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
    deploymentLauncherLabel(state, compactInlineLabel, launcherMode);
  const rootfsBlocked = state.rootfsHealth.tone === "error";
  const deployCallToAction = state.wallet.connected
    ? state.busy.deploying
      ? "Deploying…"
      : rootfsBlocked
        ? "Deployment blocked — Rootfs unavailable"
        : deploymentButtonLabel(state)
    : "Connect MetaMask";

  return (
    <>
      <style>{THEME_CSS}</style>
      <button
        ref={launcherRef}
        type="button"
        onClick={() => controller.toggleOpen()}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        title={indicator.detail ?? deploymentPanelTitle(state)}
        style={{
          position: launcherMode === "floating" ? "fixed" : "relative",
          right: launcherMode === "floating" ? "1.4rem" : undefined,
          bottom: launcherMode === "floating" ? "5.8rem" : undefined,
          zIndex: launcherMode === "floating" ? 10000 : "auto",
          borderRadius: "999px",
          border:
            launcherMode === "floating"
              ? `1px solid ${themedLauncherBorder}`
              : inlineButtonBorder,
          background:
            launcherMode === "floating"
              ? themedLauncherBackground
              : inlineButtonBackground,
          color: "var(--rb-launcher-text)",
          minHeight: launcherMode === "floating" ? undefined : "2.25rem",
          padding:
            launcherMode === "floating"
              ? "0.8rem 1.15rem"
              : "0.42rem 0.56rem 0.42rem 0.76rem",
          fontFamily: "var(--rb-font-mono)",
          fontWeight: 700,
          fontSize: launcherMode === "floating" ? "0.78rem" : "0.7rem",
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
          <svg
            aria-hidden="true"
            viewBox="0 0 32 32"
            style={{
              width: launcherMode === "floating" ? "1.1rem" : "0.95rem",
              height: launcherMode === "floating" ? "1.1rem" : "0.95rem",
              flex: "none",
            }}
          >
            <line
              x1="17"
              y1="15.4"
              x2="19.6"
              y2="13"
              stroke="var(--rb-cyan)"
              strokeWidth={2.4}
              strokeLinecap="round"
            />
            <circle cx="11.5" cy="20.5" r="7" fill="var(--rb-coral)" />
            <circle
              cx="23.5"
              cy="9.5"
              r="4.2"
              fill="none"
              stroke="var(--rb-cyan)"
              strokeWidth={2.8}
            />
          </svg>
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
                ? "var(--rb-launcher-badge-bg)"
                : inlineBadgeBackground,
            border:
              launcherMode === "floating"
                ? "1px solid var(--rb-border)"
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
              animation: pollingState ? "leSpaceRelayPulse 1.6s ease-in-out infinite" : undefined,
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
                "radial-gradient(circle at 88% 82%, var(--le-space-sponsor-relay-backdrop-accent, var(--rb-backdrop-accent)), transparent 34%)",
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
                    display: "flex",
                    alignItems: "center",
                    gap: "0.45rem",
                    color: "var(--rb-accent)",
                    fontFamily: "var(--rb-font-mono)",
                    fontWeight: 700,
                    fontSize: "0.6563rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                  }}
                >
                  <span>Aleph VM credit deployer</span>
                  <span
                    style={{
                      fontWeight: 400,
                      fontSize: "0.625rem",
                      letterSpacing: "0.04em",
                      textTransform: "none",
                      color: "var(--rb-comet)",
                    }}
                  >
                    {versionLabel}
                  </span>
                </div>
                <h2
                  style={{
                    margin: "0.2rem 0 0",
                    fontFamily: "var(--rb-font-heading)",
                    fontSize: "1.125rem",
                    fontWeight: 700,
                  }}
                >
                  {deploymentPanelTitle(state)}
                </h2>
              </div>
              <button
                type="button"
                style={secondaryButtonStyle}
                onClick={() => void controller.refresh()}
              >
                {state.busy.refreshing ? "Syncing" : "Refresh"}
              </button>
            </div>

            <p style={{ color: "var(--rb-muted)" }}>{state.statusText}</p>
            {state.errorText ? (
              <p style={{ color: "var(--rb-danger)" }}>{state.errorText}</p>
            ) : null}

            {pollingState ? (
              <div
                aria-live="polite"
                style={{
                  marginTop: "0.25rem",
                  marginBottom: "0.8rem",
                  padding: "0.7rem 0.8rem",
                  borderRadius: "1rem",
                  border: "1px solid rgba(88, 199, 243, 0.22)",
                  background:
                    "rgba(88, 199, 243, 0.08)",
                  display: "grid",
                  gap: "0.28rem",
                }}
              >
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.45rem",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: "0.62rem",
                      height: "0.62rem",
                      borderRadius: "999px",
                      background: progressToneColor("info"),
                      boxShadow: `0 0 0 3px ${progressToneColor("info")}22`,
                      animation: "leSpaceRelayPulse 1.6s ease-in-out infinite",
                    }}
                  />
                  <strong style={{ fontSize: "0.88rem" }}>{pollingState.label}</strong>
                </div>
                <small style={{ color: "var(--rb-muted)", lineHeight: 1.35 }}>
                  {pollingState.detail}
                </small>
              </div>
            ) : null}

            {deploymentProgressVisible ? (
              <div
                style={{
                  marginTop: "0.85rem",
                  padding: "0.75rem 0.8rem",
                  borderRadius: "1rem",
                  border: "1px solid var(--rb-border)",
                  background:
                    "var(--rb-surface)",
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
                      color: "var(--rb-muted)",
                      fontFamily: "var(--rb-font-mono)",
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
                    background: "rgba(168, 179, 199, 0.18)",
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
                        color: "var(--rb-muted)",
                        fontSize: "0.7rem",
                        fontFamily: "var(--rb-font-mono)",
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
                        color: "var(--rb-muted)",
                        fontSize: "0.72rem",
                        lineHeight: 1.3,
                        fontFamily:
                          state.deploymentProgress.detail.includes("0x") ||
                          state.deploymentProgress.detail.includes("Qm")
                            ? "var(--rb-font-mono)"
                            : undefined,
                      }}
                    >
                      {state.deploymentProgress.detail}
                    </div>
                  ) : null}
                  {state.deploymentProgress.error ? (
                    <div
                      style={{
                        color: "var(--rb-danger)",
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
                  color: "var(--rb-muted)",
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
                  {stateDeploymentProfile(state) === "ucan-store" ? (
                    <details open>
                      <summary>UCAN Store Bootstrap</summary>
                      <div
                        style={{
                          display: "grid",
                          gap: "0.75rem",
                          marginTop: "0.65rem",
                        }}
                      >
                        <input
                          style={fieldStyle}
                          value={state.ucanStoreBootstrap.adminDid}
                          onChange={(event) =>
                            controller.setUcanStoreBootstrapField(
                              "adminDid",
                              event.currentTarget.value,
                            )
                          }
                          placeholder="Admin DID"
                        />
                        <input
                          style={fieldStyle}
                          value={state.ucanStoreBootstrap.serviceDid}
                          onChange={(event) =>
                            controller.setUcanStoreBootstrapField(
                              "serviceDid",
                              event.currentTarget.value,
                            )
                          }
                          placeholder="Service DID override (optional)"
                        />
                        <input
                          style={fieldStyle}
                          value={state.ucanStoreBootstrap.spaceDid}
                          onChange={(event) =>
                            controller.setUcanStoreBootstrapField(
                              "spaceDid",
                              event.currentTarget.value,
                            )
                          }
                          placeholder="Space DID"
                        />
                        <textarea
                          style={fieldStyle}
                          rows={5}
                          value={state.ucanStoreBootstrap.rootDelegationProof}
                          onChange={(event) =>
                            controller.setUcanStoreBootstrapField(
                              "rootDelegationProof",
                              event.currentTarget.value,
                            )
                          }
                          placeholder="Root delegation proof"
                        />
                        <textarea
                          style={fieldStyle}
                          rows={4}
                          value={state.ucanStoreBootstrap.allowedCapabilities}
                          onChange={(event) =>
                            controller.setUcanStoreBootstrapField(
                              "allowedCapabilities",
                              event.currentTarget.value,
                            )
                          }
                          placeholder={"Allowed capabilities, one per line or comma-separated\nspace/blob/add\nspace/blob/list"}
                        />
                        <div
                          style={{
                            display: "grid",
                            gap: "0.75rem",
                            gridTemplateColumns:
                              "repeat(auto-fit, minmax(10rem, 1fr))",
                          }}
                        >
                          <input
                            style={fieldStyle}
                            value={
                              state.ucanStoreBootstrap
                                .defaultUserDelegationExpiration
                            }
                            onChange={(event) =>
                              controller.setUcanStoreBootstrapField(
                                "defaultUserDelegationExpiration",
                                event.currentTarget.value,
                              )
                            }
                            placeholder="Default expiration (seconds)"
                          />
                          <input
                            style={fieldStyle}
                            value={
                              state.ucanStoreBootstrap.maxUserDelegationExpiration
                            }
                            onChange={(event) =>
                              controller.setUcanStoreBootstrapField(
                                "maxUserDelegationExpiration",
                                event.currentTarget.value,
                              )
                            }
                            placeholder="Max expiration (seconds)"
                          />
                        </div>
                        <input
                          style={fieldStyle}
                          value={state.ucanStoreBootstrap.pwaOrigin}
                          onChange={(event) =>
                            controller.setUcanStoreBootstrapField(
                              "pwaOrigin",
                              event.currentTarget.value,
                            )
                          }
                          placeholder="PWA origin override (optional, defaults to current page origin)"
                        />
                        <input
                          style={fieldStyle}
                          value={state.ucanStoreBootstrap.serviceOrigin}
                          onChange={(event) =>
                            controller.setUcanStoreBootstrapField(
                              "serviceOrigin",
                              event.currentTarget.value,
                            )
                          }
                          placeholder="Service origin override (optional, defaults to runtime proxy URL)"
                        />
                        <div
                          style={{
                            color: "var(--rb-muted)",
                            fontSize: "0.74rem",
                            lineHeight: 1.35,
                            marginTop: "-0.15rem",
                          }}
                        >
                          Operator address comes from the connected MetaMask
                          account. If you leave service origin empty,
                          `relay-button` will use the runtime proxy URL during
                          guest configuration.
                        </div>
                      </div>
                    </details>
                  ) : null}
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

            {rootfsBlocked ? (
              <div
                role="alert"
                id="relay-rootfs-deployment-blocker"
                style={{
                  display: "grid",
                  gap: "0.55rem",
                  marginTop: "1rem",
                  padding: "0.9rem",
                  borderRadius: "1rem",
                  border: "1px solid rgba(255, 77, 106, 0.5)",
                  background: "rgba(255, 77, 106, 0.1)",
                  color: "var(--rb-text)",
                }}
              >
                <strong>Rootfs unavailable — deployment blocked</strong>
                <span style={{ fontSize: "0.82rem", lineHeight: 1.45 }}>
                  {state.rootfsHealth.detail}
                </span>
                <span style={{ fontSize: "0.75rem", lineHeight: 1.4 }}>
                  This is separate from the connected MetaMask balance. The manifest must reference an Aleph rootfs STORE with status <code>processed</code>.
                </span>
                {state.manifest?.rootfsItemHash ? (
                  <code style={{ fontSize: "0.7rem", overflowWrap: "anywhere" }}>
                    Rootfs: {state.manifest.rootfsItemHash}
                    {state.rootfsResolution?.messageStatus ? ` · Aleph status: ${state.rootfsResolution.messageStatus}` : ""}
                  </code>
                ) : null}
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                  <button type="button" onClick={() => void controller.refresh()} disabled={state.busy.refreshing} style={{ ...secondaryButtonStyle, padding: "0.55rem 0.7rem" }}>
                    {state.busy.refreshing ? "Checking…" : "Retry validation"}
                  </button>
                  <button type="button" onClick={() => controller.setShowAdvanced(true)} style={{ ...secondaryButtonStyle, padding: "0.55rem 0.7rem" }}>
                    Edit manifest URL
                  </button>
                  {/^https?:\/\//.test(state.manifestUrl) ? (
                    <a href={state.manifestUrl} target="_blank" rel="noreferrer" style={{ color: "var(--rb-link)", alignSelf: "center", fontSize: "0.78rem" }}>
                      Open manifest
                    </a>
                  ) : null}
                </div>
              </div>
            ) : null}

            <button
              type="button"
              onClick={() =>
                void (state.wallet.connected
                  ? controller.deploy()
                  : controller.connectWallet())
              }
              disabled={
                state.wallet.connected
                  ? state.busy.deploying || state.rootfsHealth.tone !== "ok"
                  : state.busy.connectingWallet
              }
              aria-describedby={rootfsBlocked ? "relay-rootfs-deployment-blocker" : undefined}
              style={{
                ...primaryButtonStyle,
                width: "100%",
                marginTop: "1rem",
                ...(rootfsBlocked ? { background: "var(--rb-surface)", borderColor: "rgba(255, 77, 106, 0.45)", color: "var(--rb-text)", boxShadow: "none", cursor: "not-allowed" } : {}),
              }}
            >
              {deployCallToAction}
            </button>

            {state.lastDeploymentHash ? (
              <p>Latest deployment: {shortHash(state.lastDeploymentHash)}</p>
            ) : null}

            {state.showInstances ? (
              <div
                style={{
                  ...containedContentStyle,
                  marginTop: "1rem",
                  display: "grid",
                  gap: "0.7rem",
                }}
              >
                {state.instances.map((entry) => {
                  const confirmedRegistration =
                    confirmedRegistrationByInstanceHash.get(
                      entry.instance.item_hash,
                    ) ?? null;
                  return (
                    <details
                      key={entry.instance.item_hash}
                      open
                      style={containedContentStyle}
                    >
                      <summary style={containedContentStyle}>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.55rem",
                            flexWrap: "wrap",
                          }}
                        >
                          {(entry.instance.content?.metadata?.name ??
                            deploymentInstanceFallbackLabel(state)) +
                            " · " +
                            shortHash(entry.instance.item_hash)}
                          {bootstrapUiEnabled && confirmedRegistration ? (
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.32rem",
                                padding: "0.16rem 0.45rem",
                                borderRadius: "999px",
                                background: "rgba(62, 220, 151, 0.14)",
                                color: "var(--rb-success)",
                                fontSize: "0.7rem",
                                fontWeight: 700,
                              }}
                            >
                              <span
                                aria-hidden="true"
                                style={{
                                  width: "0.45rem",
                                  height: "0.45rem",
                                  borderRadius: "999px",
                                  background: "var(--rb-success)",
                                  boxShadow:
                                    "0 0 0 3px rgba(62, 220, 151, 0.18)",
                                }}
                              />
                              Aleph bootstrap registered
                            </span>
                          ) : null}
                        </span>
                      </summary>
                      <div
                        style={{
                          ...containedContentStyle,
                          display: "grid",
                          gap: "0.35rem",
                          marginTop: "0.55rem",
                        }}
                      >
                        <div>Status: {entry.details.messageStatus}</div>
                        {bootstrapUiEnabled && confirmedRegistration ? (
                          <div>
                            Bootstrap registration:{" "}
                            {shortHash(
                              confirmedRegistration.messageHash ??
                                confirmedRegistration.content?.registrationId ??
                                "confirmed",
                              14,
                              8,
                            )}
                          </div>
                        ) : null}
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
                          style={dangerButtonStyle}
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
                  );
                })}
                {bootstrapUiEnabled && orphanRegistrations.length > 0 ? (
                  <div
                    style={{
                      ...containedContentStyle,
                      display: "grid",
                      gap: "0.7rem",
                      padding: "0.85rem",
                      borderRadius: "1rem",
                      border: "1px solid rgba(255, 77, 106, 0.3)",
                      background:
                        "rgba(255, 77, 106, 0.06)",
                    }}
                  >
                    <div style={{ display: "grid", gap: "0.2rem" }}>
                      <strong>Orphan bootstrap registrations</strong>
                      <small style={{ color: "var(--rb-muted)", lineHeight: 1.35 }}>
                        Current-wallet registrations without a matching instance.
                        Forget them directly from here.
                      </small>
                    </div>
                    {orphanRegistrations.map((entry) => {
                      const registrationHash =
                        entry.messageHash ?? entry.hash ?? null;
                      return (
                        <div
                          key={
                            registrationHash ??
                            entry.content?.registrationId ??
                            `orphan-${entry.content?.peerId ?? "unknown"}`
                          }
                          style={{
                            ...containedContentStyle,
                            display: "grid",
                            gap: "0.35rem",
                            padding: "0.75rem",
                            borderRadius: "0.9rem",
                            background: "var(--rb-surface)",
                            border: "1px solid var(--rb-border)",
                          }}
                        >
                          <div
                            style={{
                              ...containedContentStyle,
                              fontWeight: 700,
                            }}
                          >
                            {(entry.content?.registrationId ?? "registration") +
                              " · " +
                              shortHash(registrationHash ?? "unknown")}
                          </div>
                          <div>Peer: {entry.content?.peerId ?? "-"}</div>
                          <div>
                            Linked instance:{" "}
                            {entry.instanceItemHash
                              ? shortHash(entry.instanceItemHash)
                              : "missing"}
                          </div>
                          <div>
                            Browser multiaddrs:{" "}
                            {String(entry.content?.browserMultiaddrs?.length ?? 0)}
                          </div>
                          <div>
                            Updated:{" "}
                            {formatDateTime(entry.content?.updatedAt ?? entry.time)}
                          </div>
                          <button
                            type="button"
                            style={warningButtonStyle}
                            disabled={
                              !registrationHash ||
                              state.busy.deletingRegistrationHash ===
                                registrationHash
                            }
                            onClick={() =>
                              registrationHash
                                ? void controller.deleteBootstrapRegistration(
                                    registrationHash,
                                  )
                                : undefined
                            }
                          >
                            {state.busy.deletingRegistrationHash ===
                            registrationHash
                              ? "Forgetting…"
                              : "Forget registration"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}
    </>
  );
}

export default SponsorRelayFab;
