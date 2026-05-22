import type { CompactInstanceRecord } from './types'

export function shortHash(value: string | null | undefined, head = 8, tail = 6): string {
  if (!value) return '-'
  if (value.length <= head + tail + 3) return value
  return `${value.slice(0, head)}...${value.slice(-tail)}`
}

export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits === 0 ? 0 : Math.min(2, digits)
  }).format(value)
}

export function formatDateTime(value: string | number | null | undefined): string {
  if (!value) return '-'
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString()
}

export function buildSshCommand(hostIpv4: string | null, mappedPorts: CompactInstanceRecord['details']['mappedPorts']): string | null {
  if (!hostIpv4) return null
  const sshPort = mappedPorts.find((entry) => entry.label.startsWith('22/'))?.hostPort ?? 22
  return `ssh root@${hostIpv4}${sshPort && sshPort !== 22 ? ` -p ${sshPort}` : ''}`
}

export function joinMappedPorts(mappedPorts: CompactInstanceRecord['details']['mappedPorts']): string {
  if (mappedPorts.length === 0) return '-'
  return mappedPorts
    .map((entry) => `${entry.label}->${entry.hostPort ?? '?'}`)
    .join(' · ')
}
