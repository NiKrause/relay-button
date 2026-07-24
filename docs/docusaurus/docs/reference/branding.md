# Branding

Relay Button uses the **Le-Space brand system** (Le-Space Brand Style Guide
V1.0). The product name shown in UI, docs, and demos is **Relay Button**; the
npm scope stays `@le-space/*` (renaming published packages would be a breaking
change).

## Logo

The lockup combines the Le-Space mark ("Der erste Knoten" — the filled Signal
Coral node is your device, the hollow rings are peers) with a "Relay Button"
wordmark set in JetBrains Mono Bold, converted to paths. The trailing
underscore cursor in Signal Coral is the terminal motif that replaces the
Le-Space hyphen accent.

Assets in `docs/docusaurus/static/img/`:

| File | Use |
| --- | --- |
| `relay-button-logo-horizontal-{dark,light}.svg` | Primary lockup (headers, docs) |
| `relay-button-mark-{dark,light}.svg` | Mark solo (navbar, avatars, > 20 px) |
| `favicon.svg` | Simplified favicon variant (node + one peer) |

`static/favicon.ico` and `static/apple-touch-icon.png` come from the brand
favicon set.

## Palette

Core (dark is the default appearance):

| Token | Hex | Use |
| --- | --- | --- |
| Deep Space | `#0B0E15` | Background |
| Nebula | `#141926` | Cards, panels, code blocks |
| Horizon | `#232B3D` | Borders, dividers |
| Starlight | `#EDF1F8` | Headings, primary text |
| Stardust | `#A8B3C7` | Body text |
| Comet Grey | `#6B7690` | Meta text, labels |
| Signal Coral | `#FF6B5B` | Primary action — one per view |
| Sync Cyan | `#58C7F3` | Links, peers, sync status |

Semantic: success `#3EDC97`, warning `#FFC24B`, error `#FF4D6A` (deliberately
cooler than Signal Coral), info `#58C7F3`.

Light mode per style guide: background `#FFFFFF`, text Ink `#141B2E`, Coral
`#E8503F`, Cyan `#0E86C4`. The widget's light-mode semantic tones
(success `#0F9D6A`, warning `#A8690A`, error `#D5365A`) are darkened
derivatives chosen for AA contrast on white; they are not defined in the
style guide.

## Typography

- **JetBrains Mono** — wordmark, eyebrows/labels, status badges, code, hashes.
- **Inter** — headings, body text, buttons, forms.

The docs site self-hosts both via `@fontsource` (no CDN). The embeddable
widget intentionally does **not** bundle font files; it declares the families
with system fallbacks (`ui-monospace`, `-apple-system`, …) so host pages that
load the brand fonts get the full look and everyone else gets a clean
fallback.

### Compact widget type scale

The style guide's web scale (16 px body, 28 px H2) is sized for pages. The
Relay Button is an embedded widget, so it uses a compact scale — a deliberate,
documented deviation from the style guide:

| Role | Style guide (web) | Widget |
| --- | --- | --- |
| Panel title (H2) | Inter Bold 28 px | Inter Bold 18 px |
| Section (H3) | Inter SemiBold 20 px | Inter SemiBold 15 px |
| Body | Inter 16 px / 1.6 | Inter 13 px / 1.5 |
| Eyebrow / label | JB Mono Bold 13 px caps | JB Mono Bold 10.5 px caps |
| Code / hashes | JB Mono 14 px | JB Mono 12 px |

Radii follow the guide: 10 px cards/panels, 8 px buttons and fields, 1 px
Horizon borders.

## Theming the widget

Dark ("Deep Space") is the default. Light mode activates automatically below
any ancestor that sets `data-theme="light"` (Docusaurus convention) or
`data-relay-theme="light"`.

- Svelte: tokens live in `packages/ui/src/svelte/styles/theme.css`
  (`--relay-*` custom properties).
- React: tokens are injected by the component (`--rb-*`); the pre-existing
  `--le-space-sponsor-relay-*` custom properties remain supported as
  host-page overrides.
