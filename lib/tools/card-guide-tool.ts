import { Type } from "../pi-sdk/index.ts";
import { toolOk } from "./tool-result.ts";

const MODULES = [
  "design",
  "typography",
  "tables",
  "charts",
  "diagrams",
  "diagram",
  "chart",
  "interactive",
  "data_record",
  "accessibility",
  "streaming",
] as const;

const CARD_GUIDE = `
G-SAP interactive card design handbook for show_card.

You are generating HTML or SVG fragments that render inside an iframe in G-SAP chat.
Follow these rules exactly. The card should feel like a compact paper extension of the conversation, not an unrelated embedded web page.

Section 0. Design philosophy

- Paper extension: the card belongs to the chat notebook and should sit calmly in the message stream.
- Flat and warm: use solid fills. Avoid gradient, drop-shadow, blur, glow, mesh backgrounds, noise texture, and heavy decoration.
- Compact: the card contains the visual object only. Explanatory narration belongs in the normal assistant message outside show_card.
- Serif-first: body text uses the serif stack. Data labels and controls may use the system UI font.
- Quiet motion: avoid bounce, spring, scale, and long animation. If motion is necessary, use opacity transitions under 150ms.
- Useful first: every card must make the answer easier to inspect, compare, or operate.

Section 1. Streaming and sandbox rules

- Call this guide before the first show_card call in a turn.
- show_card code is a content fragment only.
- Do not emit DOCTYPE, html, head, or body tags. The host wraps the fragment.
- Put short <style> rules early, content next, <script> last.
- Prefer inline style when possible so elements and styles stream together.
- Keep style blocks short, ideally 15 lines or less.
- Do not use comments in HTML, CSS, or JS.
- Do not use display:none, hidden tabs, hidden carousels, or deferred-only content.
- Script runs after the card stream completes.
- Do not use localStorage, sessionStorage, eval, Function, window.open, top navigation, forms, or external image URLs.
- Do not use position: fixed. The iframe height is controlled by content measurement.
- Avoid nested scrolling containers. Let the host auto-fit card height.

Section 2. Host wrapper contract

The host injects:
- document shell and body reset
- CSS variables for theme color, spacing, fonts, and borders
- base box-sizing reset
- body padding around 12px 16px
- default font var(--font-serif)
- resize observer that reports card height to chat

Your fragment must not duplicate those wrappers.

Section 3. Theme CSS variables

Paper tones:
- --bg: #F5EFE4, main paper surface
- --bg-card: #FBF7EE, raised card surface
- --sidebar-bg: #EFE8DB, deeper substrate

Ink:
- --text: #2A2622, primary dense ink
- --text-light: #4A433C, secondary text
- --text-muted: #6B6158, captions and labels

Structure:
- --border: #D8CFBE, divider and subtle border

Accent:
- --accent: #537D96, distant mountain blue
- --accent-hover: #3F6179, pressed or strong state
- --accent-light: rgba(83,125,150,0.08), tint fill
- --accent-rgb: 83, 125, 150

Semantic:
- --green: #4A6B4A, success and natural positive state
- --danger: #8B2C1F, error or negative meaning only

Extended palette:
- #1B365D ink blue, deep emphasis and chart secondary
- #9D5F4D seal ochre, warm stamp accent and annotations
- #E4ECF5 ink blue light, badge or chip background
- #EEF2F7 ink blue whisper, info strip background
- #FFFDF7 sheet white, brightest content surface
- #FAF9F5 ivory, secondary panel
- #E8E6DC sand, deeper layer

Layout tokens:
- --radius-chat-card: 4px
- --radius-chat-card-inner: max(2px, calc(var(--radius-chat-card) - 2px))
- --space-xs: 0.25rem
- --space-sm: 0.5rem
- --space-md: 1rem
- --space-lg: 1.5rem

Fonts:
- --font-serif: EB Garamond, Noto Serif SC, Source Han Serif SC, Songti SC, STSong, serif
- --font-ui: system sans-serif
- --font-mono: JetBrains Mono, ui-monospace, monospace

Section 4. Typography

- h1: 1.35rem, weight 500, line-height 1.25, color var(--text)
- h2: 1.1rem, weight 500, line-height 1.3, color var(--text)
- h3: 0.95rem, weight 500, line-height 1.35, color var(--text)
- paragraph: 0.9rem, weight 400, line-height 1.65, color var(--text)
- caption or label: 0.75rem, weight 400, line-height 1.3, color var(--text-muted)
- metric value: 1.6rem, weight 600, line-height 1.15, color var(--accent)

Typography rules:
- h2 uses a left bar: border-left 2px solid var(--accent), padding-left 8px, border-radius 0.
- strong text uses weight 500 and var(--accent).
- Only weights 400 and 500 are generally allowed. Weight 600 is for metric values only. Never use 700.
- Use sentence case. Avoid all caps and decorative title case.
- Never use font-size below 11px.
- Round displayed numbers with Math.round, toFixed, or Intl.NumberFormat. Do not show floating point artifacts.

Section 5. Color rules

- Colors encode meaning, not arbitrary sequence.
- Use at most two accent colors per card: primary accent plus one semantic color.
- Text on a colored background uses the darkest shade from the same color family.
- Avoid generic hardcoded grays such as #333 or rgb(0,0,0).
- Prefer CSS variables or the extended palette above.
- Default background should be transparent so the host paper tone remains visible.
- For subtle differentiation, use var(--bg), var(--bg-card), #FFFDF7, #FAF9F5, #E8E6DC, or rgba(var(--accent-rgb), 0.06).

Chart palette:
- #537D96 distant mountain blue, primary
- #1B365D ink blue, deep contrast
- #9D5F4D seal ochre, warm accent
- #4A6B4A ink green, success or natural data
- #8F867B warm gray, neutral baseline or secondary series
- #8B2C1F deep vermilion, error or negative only

Use two or three chart colors whenever possible. Do not exceed four colors. Area fills should use alpha around 0.08; lines and strokes can use full color.

Section 6. Component specifications

Card container:
- background var(--bg-card)
- border 0.5px solid var(--border) when the boundary matters
- border-radius var(--radius-chat-card)
- padding 1rem 1.25rem

Divider:
- border none
- border-top 0.5px solid var(--border)
- margin 0.8em 0

Table:
- width 100%
- border-collapse collapse
- font-size 0.85rem
- th left aligned, weight 500, color var(--text-light), padding 6px 8px, bottom border 1px solid var(--border)
- td padding 5px 8px, color var(--text), subtle bottom border
- last row has no bottom border
- if the table may overflow, use table-layout fixed and explicit column widths

Metric group:
- display flex
- flex-wrap wrap
- gap 12px 20px
- each metric min-width 72px
- metric values use font-variant-numeric tabular-nums

Badge, pill, or tag:
- inline-flex, align-items center, gap 4px
- padding 2px 8px
- font-size 0.75rem, weight 500
- border-radius var(--radius-chat-card)
- background var(--accent-light), color var(--accent-hover)
- ink blue variant uses #E4ECF5 background and #1B365D text
- stamp variant uses rgba(157,95,77,0.08) background and #9D5F4D text

Button:
- border 0.5px solid var(--border)
- border-radius var(--radius-chat-card)
- background transparent
- color var(--accent)
- padding 4px 10px
- font-family var(--font-serif)
- font-size 0.82rem
- font-weight 500
- cursor pointer
- hover background var(--accent-light)
- no active scale animation

Blockquote / blockquote:
- border-left 2px solid var(--accent)
- padding 4px 0 4px 12px
- border-radius 0
- color var(--text-muted)
- font-style italic

Code:
- pre background var(--bg), border 0.5px solid var(--border), border-radius var(--radius-chat-card), padding 8px 12px, overflow-x auto
- code font-family var(--font-mono), font-size 0.82rem, color var(--text)

Section 7. Forbidden patterns

- gradients, drop shadows, blur, glow, and mesh backgrounds
- emoji as structural icons
- position fixed
- storage APIs
- eval and Function
- window.open or navigation
- form submission
- DOCTYPE, html, head, body
- HTML/CSS/JS comments
- display none, tabs, and carousel patterns
- font-size below 11px
- font-weight 700
- title case or all caps
- dark or colored outer background
- generic hardcoded colors
- rounded corners on single-sided borders
- nested scrolling containers
- external img URLs

Section 8. Complexity budget

- Title or subtitle: at most 5 words.
- Accent colors: at most 2.
- Horizontal elements at full width: at most 4. Wrap or split beyond that.
- Style block: at most 15 lines; prefer inline style when practical.
- Card should fit a chat content width around 680 to 900px.
- Keep one clear purpose per card.

Section 9. Layout modes

Editorial:
- explanatory content without a surrounding card wrapper
- natural text flow and modest vertical rhythm

Bounded card:
- a data record, contact, receipt, status summary, or compact report
- one outer card wraps all content

Metric grid:
- top metrics with optional chart below
- use flex wrap and tabular numerals

Responsive columns:
- use CSS grid with repeat(auto-fit, minmax(160px, 1fr))
- use minmax(0, 1fr), not bare 1fr, to prevent overflow

Diagram:
- SVG or simple HTML nodes
- group related shapes
- use clear direction and labels
- avoid crossing connectors when possible

Section 10. SVG rules

- SVG must declare viewBox.
- Do not hardcode width or height attributes when the host can size it.
- Use role img on root SVG with title and desc children.
- SVG text uses font-family var(--font-serif).
- All colors use CSS variables or the extended palette.
- Default rectangle corner radius is rx 2.
- Stroke width is 1 or 1.5; never exceed 2.
- Lines should have enough contrast and should not rely on color alone.

Section 11. Accessibility

- Begin HTML cards with an sr-only h2 when the card has no visible heading.
- SVG cards must include title and desc.
- Interactive controls need aria-label when visible text is absent.
- Color must not be the only way to convey state.
- Keep text selectable.
- Maintain readable contrast on light and dark themes.

Section 12. Use case templates

Metric dashboard:
- Metrics appear first in a flex-wrap row.
- Optional trend line or compact chart appears below.
- Keep labels short and values rounded.

Data record card:
- One bounded card.
- UI-heavy content may use var(--font-ui).
- Use a compact table for fields.
- Avoid decorative avatars unless they carry meaning.

Interactive explainer:
- Controls first, computed result below.
- No hidden tabs.
- Script updates result on input.
- Use aria labels and text values beside range controls.

Comparison grid:
- Use responsive grid columns.
- Each option is a small bounded card.
- Badges identify differentiators such as recommended, lower cost, higher risk.

Process diagram:
- Use SVG with a clear left-to-right or top-to-bottom flow.
- Provide title and desc.
- Use marker arrows sparingly.
- Keep labels short and avoid connector overlap.

Section 13. Fallback rules

- If the content is explanatory, use editorial layout.
- If the content is an object, use card layout.
- If the content is numeric, lead with metric grid.
- If the content is procedural, use a process diagram.
- If the content is comparative, use a comparison grid.
- When uncertain, choose the simplest readable form.
`.trim();

export function createCardGuideTool() {
  return {
    name: "hana_card_guide",
    label: "G-SAP Card Guide",
    description:
      "Return the G-SAP interactive card design rules. This legacy tool name is kept for SDK compatibility.",
    parameters: Type.Object({
      modules: Type.Optional(Type.Array(Type.String(), {
        description: "Optional guide modules to focus on.",
      })),
    }),
    progress: "Loading card guide",
    execute: async (_toolCallId: string, params: { modules?: string[] } = {}) => {
      const allowedModules = new Set<string>(MODULES);
      const modules = Array.isArray(params?.modules)
        ? params.modules.filter((module) => allowedModules.has(module))
        : [];
      const prefix = modules.length ? `Requested modules: ${modules.join(", ")}\n\n` : "";
      return toolOk(`${prefix}${CARD_GUIDE}`, { modules });
    },
  };
}
