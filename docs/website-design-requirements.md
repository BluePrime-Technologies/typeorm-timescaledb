# typeorm-timescaledb — Visual Design Requirements

**For:** the UI/UX designer building the actual screens (no Figma yet — this is
the visual direction to design from, separate from the content document).
**Not covered here:** page content or copy — see the website content documents.

---

## 1. Who This Is For, and What That Means Visually

The audience is backend/TypeScript developers evaluating or already using
TimescaleDB — people who read documentation for a living and can smell a
templated marketing site in half a second. The design should read as
**engineering-serious and quietly confident**, closer to a well-made CLI tool's
site than a SaaS landing page. No gradients-and-blob illustration style, no
"book a demo" energy, nothing that oversells a pre-1.0 package.

The one thing the design should never do: imply more polish or completeness
than the product actually has. Restraint is the brand.

---

## 2. Color System

Blue as the base, plus where I'd deviate and why.

### Primary palette

| Role                                     | Name            | Hex       | Use                                                              |
| ---------------------------------------- | --------------- | --------- | ---------------------------------------------------------------- |
| Base background (dark, primary theme)    | Chunk Ink       | `#0B1220` | Default page background — deep navy-black, not pure black        |
| Base background (light, secondary theme) | Paper           | `#F5F7FA` | Light-mode background, cool-toned, not warm cream                |
| Primary text                             | Signal White    | `#E7EAF0` | Body text on dark backgrounds                                    |
| Primary brand blue                       | Hypertable Blue | `#2F5AA8` | Links, primary buttons, focus rings, active nav state            |
| Deep blue (structure)                    | Deep Chunk      | `#16233F` | Card backgrounds, code block chrome, table headers on dark theme |

### Accent — where I'd deviate from "just blue"

A single-blue palette on a dark background tends to look cold and generic
(this is the default a lot of dev-tool sites land on). One warm accent gives
the site a pulse and doubles as the color of the signature element (§5):

| Role   | Name         | Hex       | Use                                                                                                    |
| ------ | ------------ | --------- | ------------------------------------------------------------------------------------------------------ |
| Accent | Candle Amber | `#D98E32` | CTA highlights, the signature chunk-strip motif, hover accents — used sparingly, never as a background |

Amber against navy blue is a deliberate, slightly unusual pairing for a
database tool (most either stay monochrome-blue or go green/teal for
"data/success"). It also isn't cream-and-terracotta and isn't
black-and-neon — the two AI-generated-design defaults worth actively avoiding
here.

### Status colors — a real system, not decoration

The project's own docs (`docs/feature-status.md`) already define five status
labels: **Shipped**, **Release scope**, **Planned**, **Unsupported**,
**Manual**. The site should use these labels verbatim wherever it describes a
capability, and each should have a consistent, restrained color so a reader
can scan a page and instantly tell what's real:

| Label         | Name         | Hex       | Feel                                        |
| ------------- | ------------ | --------- | ------------------------------------------- |
| Shipped       | Live Teal    | `#2BA37A` | Confident, not neon-green                   |
| Release scope | Candle Amber | `#D98E32` | Same as the accent — "almost here"          |
| Planned       | Slate        | `#8B94A3` | Deliberately unexciting — this is the point |
| Unsupported   | Clay         | `#B65C4B` | Muted warning, not alarm-red                |
| Manual        | Muted Violet | `#7C6FA0` | Distinct, calm                              |

This system should appear as a small pill/badge component, used consistently
across the User Guide, API Reference, and Release Notes.

### What to avoid

- Cream background + serif display + terracotta accent (a very common
  AI-generated-design default right now — wrong register for this product
  anyway).
- Pure-black background + single neon accent (the other common default).
- Anything resembling TimescaleDB's or Postgres's own brand colors closely
  enough to look affiliated — this is an independent, unofficial integration.

---

## 3. Typography

The product's whole pitch is "typed" — typed hypertables, typed queries, typed
aggregates. The type system should say that before a single word of copy does.

### The pairing

- **Headings, labels, nav, and eyebrows:** **IBM Plex Mono** (semi-bold/bold),
  tight letter-spacing at large sizes, uppercase with wide tracking for small
  labels (eyebrows, nav items, status badges).
- **Body copy:** **IBM Plex Sans** (regular/medium) — same type family as the
  mono face, so headings and prose feel like one considered system rather than
  two unrelated fonts glued together.
- **Code:** **IBM Plex Mono** — the same face used for headings. This is the
  intentional risk: headings and code share a typeface, so a `@Hypertable`
  decorator in a code block visually rhymes with an `## Hypertables` heading
  above it. It reinforces "everything here is typed" without saying it.

All three are free, open-source, and widely available — no licensing blocker
for the designer.

### Scale (starting point — designer should refine)

| Level           | Size (desktop) | Weight    | Face                              |
| --------------- | -------------- | --------- | --------------------------------- |
| Hero H1         | 56–64px        | Bold      | IBM Plex Mono                     |
| Section H2      | 32–36px        | Semi-bold | IBM Plex Mono                     |
| Subsection H3   | 22–24px        | Semi-bold | IBM Plex Mono                     |
| Body            | 16–17px        | Regular   | IBM Plex Sans                     |
| Small / caption | 13–14px        | Medium    | IBM Plex Mono, uppercase, tracked |
| Code            | 14–15px        | Regular   | IBM Plex Mono                     |

Line height: generous for body (1.6–1.7), tighter for headings (1.1–1.2).

---

## 4. Layout

### Landing page

- **Left-aligned, not centered.** Marketing-template sites center everything;
  a terminal or editor is left-aligned. Set the hero headline and supporting
  text flush left, full-bleed section backgrounds.
- **Code comes immediately, not below the fold as an afterthought.** The
  install command sits directly beside or below the hero headline — the first
  thing a visitor sees after the pitch is real, runnable code.
- **The rule-of-three value proposition** (Typed / Honest / Safe) should read
  as three equal, calm blocks — no icons doing the work type and spacing
  should be doing.
- **The "Additional Information" grid** near the bottom should look like a
  dense, evenly-weighted grid of small boxes — not a hero-style feature
  section. Deliberately less visual emphasis than the hero, since its job is
  proof of substance, not persuasion.
- Generous vertical whitespace between sections; this is a page meant to be
  read, not skimmed past.

### Docs pages (Getting Started, User Guide, API Reference)

Use a conventional three-column technical-docs layout — this is one of the
few places convention beats invention, since developers navigate docs sites by
muscle memory:

```
[ left: persistent section nav ]  [ center: content, ~720px max width ]  [ right: sticky "on this page" outline ]
```

- Left nav persists across all `/docs/*`-equivalent pages, collapsible on
  mobile into a drawer.
- Center content column is where all the type-scale and code-block styling
  does its work — keep it narrow enough to stay readable (~720–760px).
  Right-hand "on this page" outline is optional but recommended given how long
  the User Guide and API Reference pages are.

### Release Notes

Reverse-chronological, each version as its own card/block with a visible
version number set in the mono display face — this page should feel like a
git log made readable, not a blog.

---

## 5. Signature Element: The Chunk Strip

Every design needs one thing it's remembered by. For this project, it should
come directly from what a hypertable actually is: **data cut into chunks along
a time axis.**

**The chunk strip:** a horizontal row of thin vertical bars of varying height
— visually just short of a candlestick chart or histogram — rendered in
Candle Amber against the dark background.

Where it appears:
- As a subtle, low-opacity ambient texture behind the hero section.
- As the divider between major landing-page sections, replacing a plain
  horizontal rule.
- Optionally, animated once on page load: bars "settle" into their resting
  height in a quick staggered sequence (~40ms per bar) — a single orchestrated
  moment, not continuous motion. Must respect `prefers-reduced-motion` by
  skipping straight to the resting state.
- Small version, static, could double as a favicon/mark treatment.

This ties the visual identity directly to hypertables, `time_bucket`, and
`getCandlesticks()` — nobody could reuse this motif for an unrelated product,
which is exactly the point.

---

## 6. Components — Visual Treatment

- **Code block:** dark chrome (Deep Chunk background) even in light mode,
  IBM Plex Mono, syntax highlighting, a visible language tag top-left, a copy
  button top-right. Never a plain unstyled `<pre>`.
- **Status badge:** small pill, mono uppercase label, colored per §2's status
  table, consistent size and placement (top-right of a guide subsection or
  inline after a heading).
- **Options/parameter table:** hairline row dividers, monospace for the
  `option`/`type` columns, sans for the description column — reinforces the
  type-vs-prose distinction established in §3.
- **Callout/note box ("What this does not do"):** a distinct but calm
  treatment — left border in Slate, not a yellow-alert-triangle warning box.
  This is scope information, not a warning.
- **Nav / footer:** mono, uppercase, wide tracking, small — treat navigation
  labels as part of the type system's "structural" register, not body text.

---

## 7. Motion

Minimal and purposeful:
- One orchestrated moment on the landing page (the chunk strip settling on
  load).
- Subtle hover states on links and cards — color shift and/or underline
  reveal only. No scale, tilt, or bounce effects.
- No scroll-jacking, no parallax.
- Respect `prefers-reduced-motion` everywhere motion is used.

---

## 8. Accessibility & Responsive Baseline

- Body text minimum 4.5:1 contrast ratio against its background in both
  themes.
- Visible keyboard focus rings using Hypertable Blue, 2px, with offset — never
  suppressed.
- Breakpoints: mobile `<640px`, tablet `641–1024px`, desktop `>1024px`. Docs
  sidebar collapses to a drawer below 1024px.
- Dark theme is primary/default given the developer audience; light theme
  (Paper background) is a supported secondary, not an afterthought — both
  need real contrast-checked treatments, not an auto-inverted dark mode.

---

## 9. Iconography

Keep this minimal. No illustrative icon set, no decorative icons doing double
duty as content. The only icons needed: GitHub mark, npm mark, copy-to-clipboard,
external-link indicator, and a simple chevron/caret for collapsible nav
sections. Everything else should be typography and the chunk-strip motif doing
the visual work, not icons standing in for it.
