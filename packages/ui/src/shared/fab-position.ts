/**
 * Geometry for a launcher the consumer can place and the user can drag.
 *
 * Kept free of DOM access on purpose: the framework layers read rects and write
 * styles, this module only does the arithmetic, which is what makes the awkward
 * parts — the tap/drag threshold, staying on screen after a rotation — testable
 * without a browser.
 */

export type FabCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

export interface FabPoint {
  x: number
  y: number
}

export interface FabSize {
  width: number
  height: number
}

export interface FabViewport {
  width: number
  height: number
}

/** Absolute top-left of the launcher, in viewport coordinates. */
export interface FabPlacement {
  left: number
  top: number
}

export const DEFAULT_FAB_CORNER: FabCorner = 'bottom-right'

/** Distance from the viewport edge, matching the previous `1.4rem` inset. */
export const FAB_EDGE_MARGIN = 22

/**
 * Pointer travel, in pixels, before a press becomes a drag.
 *
 * Not zero: fingers are not steady, so a strict zero turns every tap into a
 * one-pixel drag and the click never fires.
 */
export const FAB_DRAG_THRESHOLD = 6

export function dragExceedsThreshold(
  start: FabPoint,
  current: FabPoint,
  threshold: number = FAB_DRAG_THRESHOLD,
): boolean {
  const dx = current.x - start.x
  const dy = current.y - start.y
  return Math.hypot(dx, dy) >= threshold
}

/** Where a named corner puts a launcher of this size in this viewport. */
export function resolveCornerPlacement(
  corner: FabCorner,
  size: FabSize,
  viewport: FabViewport,
  margin: number = FAB_EDGE_MARGIN,
): FabPlacement {
  const left = corner.endsWith('left') ? margin : viewport.width - size.width - margin
  const top = corner.startsWith('top') ? margin : viewport.height - size.height - margin
  return clampToViewport({ left, top }, size, viewport, margin)
}

/**
 * Keep the launcher reachable. A viewport that shrinks — rotation, a desktop
 * window dragged narrow, a mobile keyboard — would otherwise strand a dragged
 * button off-screen with no way to bring it back.
 */
export function clampToViewport(
  placement: FabPlacement,
  size: FabSize,
  viewport: FabViewport,
  margin: number = FAB_EDGE_MARGIN,
): FabPlacement {
  // A viewport narrower than the button plus its margins has no valid range;
  // pin to the near edge rather than letting max() overshoot past min().
  const maxLeft = Math.max(margin, viewport.width - size.width - margin)
  const maxTop = Math.max(margin, viewport.height - size.height - margin)
  return {
    left: Math.min(Math.max(placement.left, margin), maxLeft),
    top: Math.min(Math.max(placement.top, margin), maxTop),
  }
}

/** Which way the panel should open, given where the launcher sits. */
export type FabPanelSide = 'above' | 'below'

export interface FabPanelPlacement extends FabPlacement {
  side: FabPanelSide
  maxHeight: number
}

/**
 * Hang the panel off the launcher instead of off its own hardcoded corner.
 *
 * The panel opens away from the nearer edge, so a launcher dragged to the top
 * of the screen drops its panel downward rather than off-screen upward.
 */
export function anchorPanelToLauncher(
  launcher: FabPlacement & FabSize,
  panel: FabSize,
  viewport: FabViewport,
  gap = 12,
  margin: number = FAB_EDGE_MARGIN,
): FabPanelPlacement {
  const launcherCentre = launcher.top + launcher.height / 2
  const side: FabPanelSide = launcherCentre < viewport.height / 2 ? 'below' : 'above'

  const top =
    side === 'below' ? launcher.top + launcher.height + gap : launcher.top - gap - panel.height

  // Align the panel's near edge with the launcher's, so the two read as one
  // object however far the launcher has been dragged.
  const preferredLeft =
    launcher.left + launcher.width / 2 < viewport.width / 2
      ? launcher.left
      : launcher.left + launcher.width - panel.width

  const clamped = clampToViewport({ left: preferredLeft, top }, panel, viewport, margin)

  const available =
    side === 'below'
      ? viewport.height - clamped.top - margin
      : launcher.top - gap - margin

  return {
    ...clamped,
    side,
    maxHeight: Math.max(0, available),
  }
}

interface StoredPosition extends FabPlacement {
  /** Viewport the position was captured in, so a resize can be detected. */
  viewport?: FabViewport
}

/**
 * Persistence is opt-in through a consumer-supplied key: a library that writes
 * to localStorage unasked is a library that collides with its host.
 */
export function readStoredPosition(key: string | null | undefined): StoredPosition | null {
  if (!key) return null
  try {
    const raw = globalThis.localStorage?.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredPosition
    return Number.isFinite(parsed?.left) && Number.isFinite(parsed?.top) ? parsed : null
  } catch {
    // Private-mode denials, quota, corrupt JSON — a stored position is a nicety
    // and must never take the widget down with it.
    return null
  }
}

export function writeStoredPosition(
  key: string | null | undefined,
  placement: FabPlacement,
  viewport?: FabViewport,
): void {
  if (!key) return
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify({ ...placement, viewport }))
  } catch {
    // See above.
  }
}
