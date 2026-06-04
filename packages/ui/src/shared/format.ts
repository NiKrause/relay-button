import type { RootfsRequiredPortForward } from "../../../shared-types/src/manifest.ts";
import type { CompactInstanceRecord } from "./types";

export function shortHash(
  value: string | null | undefined,
  head = 8,
  tail = 6,
): string {
  if (!value) return "-";
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

export function formatNumber(
  value: number | null | undefined,
  digits = 0,
): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits === 0 ? 0 : Math.min(2, digits),
  }).format(value);
}

export function formatDateTime(
  value: string | number | null | undefined,
): string {
  if (!value) return "-";
  const normalizedValue =
    typeof value === "number" && value > 0 && value < 10_000_000_000
      ? value * 1000
      : value;
  const date =
    typeof normalizedValue === "number"
      ? new Date(normalizedValue)
      : new Date(normalizedValue);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

export function formatTierSpecLabel(
  vcpus: number | null | undefined,
  memoryMiB: number | null | undefined,
  diskMiB: number | null | undefined,
): string {
  if (
    vcpus == null ||
    !Number.isFinite(vcpus) ||
    memoryMiB == null ||
    !Number.isFinite(memoryMiB) ||
    diskMiB == null ||
    !Number.isFinite(diskMiB)
  ) {
    return "-";
  }

  return `(${formatNumber(vcpus, 0)} vCPU · ${formatNumber(memoryMiB / 1024, 1)} GiB RAM · ${formatNumber(diskMiB / 1024, 0)} GiB disk)`;
}

export function buildSshCommand(
  hostIpv4: string | null,
  mappedPorts: CompactInstanceRecord["details"]["mappedPorts"],
): string | null {
  if (!hostIpv4) return null;
  const sshPort =
    mappedPorts.find((entry) => entry.label.startsWith("22/"))?.hostPort ?? 22;
  return `ssh root@${hostIpv4}${sshPort && sshPort !== 22 ? ` -p ${sshPort}` : ""}`;
}

export function joinMappedPorts(
  mappedPorts: CompactInstanceRecord["details"]["mappedPorts"],
): string {
  if (mappedPorts.length === 0) return "-";
  return mappedPorts
    .map((entry) => `${entry.label}->${entry.hostPort ?? "?"}`)
    .join(" · ");
}

export function joinRequiredPortForwards(
  portForwards: ReadonlyArray<RootfsRequiredPortForward> | null | undefined,
): string {
  if (!portForwards || portForwards.length === 0) return "-";
  return portForwards
    .map((entry) => {
      const protocols = [
        entry.tcp === true ? "tcp" : null,
        entry.udp === true ? "udp" : null,
      ]
        .filter((value): value is string => Boolean(value))
        .join("/");
      return `${entry.port}/${protocols}`;
    })
    .join(" · ");
}
