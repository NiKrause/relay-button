import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FAB_DRAG_THRESHOLD,
  anchorPanelToLauncher,
  clampToViewport,
  dragExceedsThreshold,
  readStoredPosition,
  resolveCornerPlacement,
  writeStoredPosition,
} from '../dist/shared/index.js'

const LAUNCHER = { width: 180, height: 44 }
const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1440, height: 900 }

test('a small wobble is still a tap, a deliberate move is a drag', () => {
  const start = { x: 100, y: 100 }

  // Fingers are not steady. A zero threshold turns every press into a
  // one-pixel drag and the click never fires.
  assert.equal(dragExceedsThreshold(start, { x: 103, y: 102 }), false)
  assert.equal(dragExceedsThreshold(start, { x: 100, y: 107 }), true)

  // Diagonal travel is measured as distance, so 5px on each axis is a drag
  // even though neither axis alone reaches the threshold -- and 4px on each
  // is not, at 5.66px total.
  assert.equal(dragExceedsThreshold(start, { x: 105, y: 105 }), true)
  assert.equal(dragExceedsThreshold(start, { x: 104, y: 104 }), false)
  assert.equal(FAB_DRAG_THRESHOLD, 6)
})

test('each corner places the launcher against its own two edges', () => {
  const at = (corner) => resolveCornerPlacement(corner, LAUNCHER, DESKTOP)

  assert.deepEqual(at('bottom-right'), { left: 1440 - 180 - 22, top: 900 - 44 - 22 })
  assert.deepEqual(at('bottom-left'), { left: 22, top: 900 - 44 - 22 })
  assert.deepEqual(at('top-right'), { left: 1440 - 180 - 22, top: 22 })
  assert.deepEqual(at('top-left'), { left: 22, top: 22 })
})

test('a shrinking viewport cannot strand the launcher off-screen', () => {
  // Rotation, a narrowed window, a mobile keyboard: the stored position is
  // suddenly outside the viewport and the user has no way to reach it.
  const dragged = { left: 1300, top: 850 }
  const clamped = clampToViewport(dragged, LAUNCHER, PHONE)

  assert.equal(clamped.left, 390 - 180 - 22)
  assert.equal(clamped.top, 844 - 44 - 22)
})

test('a viewport narrower than the launcher pins it instead of inverting', () => {
  // max() and min() cross over here; without the guard the launcher would be
  // placed at a negative offset and disappear.
  const tiny = { width: 120, height: 200 }
  const clamped = clampToViewport({ left: 500, top: 500 }, LAUNCHER, tiny)

  assert.equal(clamped.left, 22)
  assert.equal(clamped.top, 134)
})

test('the panel opens away from the edge the launcher sits nearest', () => {
  const panel = { width: 420, height: 500 }

  const low = anchorPanelToLauncher({ left: 1200, top: 820, ...LAUNCHER }, panel, DESKTOP)
  assert.equal(low.side, 'above')

  const high = anchorPanelToLauncher({ left: 1200, top: 40, ...LAUNCHER }, panel, DESKTOP)
  assert.equal(high.side, 'below')
  assert.ok(high.top > 40, 'a panel opening below starts under the launcher')
})

test('the panel aligns its near edge with the launcher and stays on screen', () => {
  const panel = { width: 420, height: 300 }

  // Launcher on the right half: the panel's right edge lines up with it.
  const right = anchorPanelToLauncher({ left: 1200, top: 700, ...LAUNCHER }, panel, DESKTOP)
  assert.equal(right.left, 1200 + 180 - 420)

  // Launcher on the left half: left edges line up instead.
  const left = anchorPanelToLauncher({ left: 40, top: 700, ...LAUNCHER }, panel, DESKTOP)
  assert.equal(left.left, 40)

  // On a phone the panel is wider than the viewport allows, so it clamps.
  const phone = anchorPanelToLauncher({ left: 188, top: 760, ...LAUNCHER }, panel, PHONE)
  assert.ok(phone.left >= 22, 'never off the left edge')
  assert.ok(phone.maxHeight > 0, 'always given room to render')
})

test('a stored position survives a round trip and bad input does not throw', () => {
  const store = new Map()
  const original = globalThis.localStorage
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  }

  try {
    writeStoredPosition('relay-fab', { left: 120, top: 340 }, DESKTOP)
    assert.deepEqual(readStoredPosition('relay-fab'), {
      left: 120,
      top: 340,
      viewport: DESKTOP,
    })

    // No key means opt-out: nothing written, nothing read.
    writeStoredPosition(undefined, { left: 1, top: 2 })
    assert.equal(store.size, 1)
    assert.equal(readStoredPosition(undefined), null)

    store.set('corrupt', '{not json')
    assert.equal(readStoredPosition('corrupt'), null)

    store.set('partial', JSON.stringify({ left: 10 }))
    assert.equal(readStoredPosition('partial'), null, 'half a position is not a position')
  } finally {
    globalThis.localStorage = original
  }
})

test('storage that denies access degrades instead of breaking the widget', () => {
  // Safari private mode throws on setItem; a remembered position is a nicety
  // and must never take the button down with it.
  const original = globalThis.localStorage
  globalThis.localStorage = {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('quota')
    },
  }

  try {
    assert.doesNotThrow(() => writeStoredPosition('k', { left: 1, top: 2 }))
    assert.equal(readStoredPosition('k'), null)
  } finally {
    globalThis.localStorage = original
  }
})
