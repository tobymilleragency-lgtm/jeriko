---
name: premium-ui-motion
description: Production-grade UI motion for Jeriko-generated apps and contractor sites: restrained Framer Motion/CSS patterns, timing tokens, accessibility, and anti-gimmick rules.
user-invocable: false
allowed-tools: []
license: MIT
metadata:
  author: Hermes Agent
  version: 1.0.0
---

# Premium UI Motion

## Mission

Motion exists to clarify, confirm, and guide. It is not decoration. If the page needs spinning tools, sparks, shimmer, drifting grids, or floating hero gimmicks to feel interesting, the layout, copy, imagery, hierarchy, or proof is weak. Fix those first.

## Load this when

- Building any Jeriko web app or marketing site.
- Building contractor/local-service sites.
- Adding Framer Motion, route transitions, drawers, accordions, cards, forms, or hover interactions.
- Repairing a site that feels generic, over-animated, AI-built, gimmicky, or visually noisy.

## Approved motion patterns

Use these by default:

1. Section reveal
- One-time reveal.
- Opacity 0 -> 1.
- translateY 8-16px -> 0.
- Duration 360-560ms.
- Stagger children by 40-80ms max.

2. Card hover
- translateY(-2px) to translateY(-4px).
- Optional shadow/border-color transition.
- Duration 160-240ms.
- No tilt, spin, parallax, cursor glow, or large scale.

3. Image hover
- Scale 1.02 to 1.04 max.
- Duration 300-500ms.
- No Ken Burns autoplay, no constant zoom, no heavy filter animation.

4. Button interaction
- Use color, border, shadow, focus ring, and pressed state.
- translateY(-1px) hover is enough.
- No shimmer sweeps, glitter, pulse loops, or animated shine overlays.

5. Navigation/menu
- Mobile drawer: slide/fade 180-260ms.
- Dropdown: opacity/translateY 4-8px, 120-180ms.
- Active nav: underline/color transition only.

6. Form/status feedback
- Error/success message: fade/slide 120-220ms.
- Loading state: spinner/skeleton allowed only while waiting.
- No success confetti for contractor/local-service sites.

7. Route/page transition
- Quick fade/translate 160-260ms only if it does not delay content reading.

## Timing tokens

Prefer consistent tokens:

- `--motion-fast: 140ms`
- `--motion-base: 220ms`
- `--motion-slow: 420ms`
- `--motion-reveal: 520ms`
- `--motion-ease: cubic-bezier(0.16, 1, 0.3, 1)`
- `--motion-hover-y: -3px`
- `--motion-image-scale: 1.035`

## Framer Motion guidance

Use Framer Motion for:
- Route transitions.
- Section entrance reveal.
- Dialog/drawer presence.
- Accordion/collapsible content.
- Form feedback states.

Use CSS transitions for:
- Buttons.
- Links/nav underline.
- Card hover.
- Image hover.
- Sticky header shadow.

Do not use Framer Motion to scatter `whileHover`, `whileInView`, and `initial/animate` on every visible element. Motion should be sparse and explainable.

## Hard bans for contractor/local-service sites

Never ship these:

- Button shimmer sweeps.
- Moving blueprint/grid/stripe overlays.
- Spinning saw blades, hammers, drills, gears, or trade icons.
- Spark particles, glitter, confetti, or floating dots.
- Floating hero stage cards or fake animated construction diagrams.
- Breathing glow blobs/radial gradients.
- Infinite decorative loops.
- Cursor-follow glows.
- Parallax hero gimmicks.
- Comments or code labels like `WOW upgrade`, `wow factor`, `premium motion`, or `cinematic` as justification for effects.

If motion is decorative and repeats forever, it fails.

## Accessibility requirements

- Always include `prefers-reduced-motion: reduce` handling.
- Content must be readable immediately; no delayed headline comprehension.
- Focus states must be visible and not rely on animation alone.
- Motion must not cause layout shift.
- Avoid blur/filter animation on readable content.

## Quality checklist before verify

- Motion supports a user action or reading flow.
- No infinite decorative animation remains.
- No shimmer/spark/spin/drift/float/breathe gimmicks remain.
- `prefers-reduced-motion` is present.
- Hover transforms are small.
- Image/card motion is subtle.
- The site still looks good with all motion disabled.
