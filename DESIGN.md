---
name: fast-jev developer guide
description: An annotated code review for understanding context retention.
colors:
  primary: "#176b3a"
  primary-hover: "#10512b"
  retained-bg: "#e9f6ed"
  removed: "#913a3a"
  removed-bg: "#fff0ef"
  truncated: "#77551c"
  truncated-bg: "#faf4e4"
  ink: "#1f2328"
  muted: "#59636e"
  paper: "#ffffff"
  surface: "#f6f8fa"
  line: "#d8dee4"
typography:
  display:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "clamp(42px, 4.6vw, 66px)"
    fontWeight: 600
    lineHeight: 1.13
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "clamp(30px, 3.1vw, 42px)"
    fontWeight: 600
    lineHeight: 1.13
    letterSpacing: "-0.035em"
  body:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.65
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, Liberation Mono, monospace"
    fontSize: "12px"
  label:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 600
rounded:
  standard: "6px"
  compact: "4px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.paper}"
    rounded: "{rounded.standard}"
    padding: "13px 20px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  code-block:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.standard}"
---

# Design System: fast-jev developer guide

## Overview

**Creative North Star: “The Annotated Diff”**

A reference-first, light interface grounded in the developer's familiar code-review scene. Large self-hosted headings establish a calm reading hierarchy; dense transcript rows make the product's retention mechanism tangible. The user selected this familiar review language over the assigned signal-routing concept.

**Key Characteristics:** cool neutral fields, text-labeled retention states, actual code in monospace, modest corners, generous section separation, and copyable setup instructions. Site implementation is the visual authority; no incumbent frontend was replaced.

## Colors

### Primary

Forest green identifies primary actions and retained history. Its darker variant supplies hover feedback, while a pale related surface carries retained transcript rows.

### Secondary

Muted red marks removed example rows. Amber marks truncated output. Both always accompany written state labels.

### Neutral

Charcoal carries text; slate-muted text carries explanation. White is the reading ground, pale cool gray distinguishes reference/setup regions, and light gray defines table boundaries.

**The Labeled State Rule.** Color never conveys retention alone: Keep, Drop, Truncate, and Pinned remain visible as text.

## Typography

Geist is self-hosted in regular, semibold, and bold weights with its SIL license. It is deliberately familiar for this user-selected developer-reference world; the detector's overused-font advisory is acknowledged rather than treated as evidence of uniqueness. The display and headline tokens govern large headings; body copy uses the body token. Compact labels and transcript code use the compact roles. Code-block text inherits its surrounding size with code scaled proportionally.

**The Code Is Code Rule.** Monospace belongs to commands, paths, configuration, line numbers, and measurements—not the page's general voice.

## Layout

The centered container is capped at 1248px including horizontal padding. Desktop sections use two columns with content-specific gaps; at 760px the document becomes a single ordered reading column. The intermediate 1050px breakpoint reduces gaps and stacks the review toolbar. Mobile padding is 24px. Wide decision tables scroll within their own keyboard-focusable region, not the page.

**The Reading Order Rule.** Narrow layouts preserve explanation before demonstration and installation before backend selection. Heading-to-copy spacing remains smaller than section-to-section separation.

## Elevation & Depth

Most surfaces are flat, separated by rules and tonal fields. Only the transcript review and temporary copy status receive soft offset shadows. There is no decorative glow or hard offset depth.

## Shapes

Code blocks, primary actions, and the transcript review use the standard radius. Small buttons use the compact radius. Transcript rows and decision tables remain rectangular. Round installation step markers communicate the actual two-step sequence.

## Components

- **Primary action:** filled green, semibold, optionally paired with an authored line-arrow SVG; darker hover and clear focus outline.
- **Transcript review:** numbered rows, written retention decisions, pale state surfaces, and a toggle between the full synthetic example and retained checkpoint.
- **Code block:** a labeled header, copy action, wrapped command/configuration body, and a fine boundary.
- **Backend tabs:** underlined active state, explicit selected semantics, arrow/Home/End navigation, and panels shown progressively. Without JavaScript both instruction panels remain visible.
- **Reference table:** ordinary header/body rows, text-labeled outcomes, and internal overflow on mobile.
- **Troubleshooting disclosure:** native details/summary with clear separators; preserves browser keyboard behavior.
- **Copy feedback:** a polite live-status message reports success or instructs manual copying on clipboard failure.

Motion is limited to document scrolling and review surface state; reduced-motion preference removes nonessential movement. Content is never hidden by entrance animation.

## Do's and Don'ts

- Do retain textual decisions alongside color.
- Do wrap long commands and endpoints without causing page overflow.
- Do preserve visible focus, relative asset paths, and no-JavaScript backend access.
- Don't present the synthetic transcript as real performance data.
- Don't turn compact reference labels into decorative kickers.
- Don't replace useful tables with repetitive promotional cards.
