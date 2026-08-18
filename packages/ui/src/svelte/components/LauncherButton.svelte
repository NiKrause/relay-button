<script>
  import { dragExceedsThreshold } from '../../shared/index'

  export let open = false
  export let onToggle = () => {}
  export let mode = 'floating'
  /** Absolute placement from the parent, or null to use the CSS corner default. */
  export let placement = null
  export let draggable = false
  /** Called with the pointer position while dragging; the parent owns the maths. */
  export let onDragStart = () => {}
  export let onDragMove = () => {}
  export let onDragEnd = () => {}
  /** Bound by the parent so it can measure the launcher to anchor the panel. */
  export let element = null

  let dragging = false
  let pressOrigin = null

  function handlePointerDown(event) {
    if (!draggable || mode !== 'floating' || event.button > 0) return
    pressOrigin = { x: event.clientX, y: event.clientY }
    dragging = false
    event.currentTarget.setPointerCapture?.(event.pointerId)
    onDragStart(pressOrigin)
  }

  function handlePointerMove(event) {
    if (!pressOrigin) return
    const point = { x: event.clientX, y: event.clientY }
    // Only become a drag once the pointer has travelled far enough; below the
    // threshold this is still a press that should open the panel.
    if (!dragging && !dragExceedsThreshold(pressOrigin, point)) return
    dragging = true
    onDragMove(point)
  }

  function handlePointerUp(event) {
    if (!pressOrigin) return
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    const wasDragging = dragging
    pressOrigin = null
    dragging = false
    onDragEnd(wasDragging)
    // A drag must not also toggle the panel; a tap must.
    if (!wasDragging) onToggle()
  }

  $: placementStyle =
    placement && mode === 'floating'
      ? `left:${placement.left}px;top:${placement.top}px;right:auto;bottom:auto;`
      : ''
</script>

<button
  bind:this={element}
  class={`launcher ${mode} ${open ? 'open' : ''} ${draggable ? 'draggable' : ''}`}
  style={placementStyle}
  type="button"
  on:pointerdown={handlePointerDown}
  on:pointermove={handlePointerMove}
  on:pointerup={handlePointerUp}
  on:pointercancel={handlePointerUp}
  on:click={draggable ? undefined : onToggle}
>
  <svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <line x1="17" y1="15.4" x2="19.6" y2="13" class="mark-link" stroke-width="2.4" stroke-linecap="round" />
    <circle cx="11.5" cy="20.5" r="7" class="mark-node" />
    <circle cx="23.5" cy="9.5" r="4.2" fill="none" class="mark-peer" stroke-width="2.8" />
  </svg>
  <span>Relay Button</span>
</button>

<style>
  .launcher {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    border: 1px solid var(--relay-launcher-border);
    border-radius: 999px;
    padding: 0.75rem 1.1rem;
    background: var(--relay-launcher-bg);
    color: var(--relay-launcher-text);
    box-shadow: var(--relay-launcher-shadow);
    font: 700 0.78rem/1 var(--relay-font-mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;
    transition: transform 180ms ease, border-color 180ms ease;
  }

  .mark {
    width: 1.15rem;
    height: 1.15rem;
    flex: none;
  }

  .mark-node {
    fill: var(--relay-coral);
  }

  .mark-peer,
  .mark-link {
    stroke: var(--relay-cyan);
  }

  .launcher.floating {
    position: fixed;
    right: 1.4rem;
    bottom: 5.8rem;
    z-index: 10000;
  }

  .launcher.draggable {
    /* Without this the browser scrolls the page instead of moving the button. */
    touch-action: none;
    user-select: none;
  }

  .launcher.inline {
    position: relative;
    z-index: auto;
    padding: 0.5rem 0.85rem;
    font-size: 0.72rem;
  }

  .launcher:hover,
  .launcher.open {
    transform: translateY(-2px) scale(1.02);
    border-color: var(--relay-cyan);
  }
  </style>
