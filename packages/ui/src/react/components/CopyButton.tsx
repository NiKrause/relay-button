import React, { useEffect, useRef, useState } from 'react'

export interface CopyButtonProps {
  text: string
  label?: string
}

// The React build styles inline rather than with classes, so this mirrors the
// Svelte button's look through the React theme variables instead of its CSS.
const copyButtonStyle: React.CSSProperties = {
  borderRadius: '999px',
  border: '1px solid var(--rb-border)',
  background: 'transparent',
  color: 'var(--rb-muted)',
  padding: '0.28rem 0.7rem',
  fontFamily: 'var(--rb-font-mono, monospace)',
  fontSize: '0.6563rem',
  fontWeight: 700,
  lineHeight: 1,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  cursor: 'pointer',
  flexShrink: 0,
}

/**
 * React counterpart of svelte/components/CopyButton.svelte, down to the 1200 ms
 * "Copied" window, so the same deployment card reads the same in both builds.
 */
export function CopyButton({ text, label = 'Copy' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const handleCopy = async () => {
    if (!text) return
    await navigator.clipboard.writeText(text)
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1200)
  }

  return (
    <button type="button" style={copyButtonStyle} onClick={() => void handleCopy()}>
      {copied ? 'Copied' : label}
    </button>
  )
}

export default CopyButton
