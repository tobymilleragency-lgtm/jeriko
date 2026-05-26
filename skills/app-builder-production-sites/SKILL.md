---
name: app-builder-production-sites
description: Production-ready app/site build workflow for Jeriko-generated marketing sites and apps, including UI/UX polish, motion, SEO/prerender, forms, deploy, and handoff verification.
user-invocable: true
allowed-tools: [bash, read, write, edit, search, browse, webdev]
---

# App Builder Production Sites

Use this skill whenever Jeriko builds, repairs, deploys, or audits a production website/app for Alpha Marketing or client work.

If the target is a contractor, construction, trade, home-services, commercial-services, or local-service business, also load and follow `contractor-site-autonomous-build`.

Canonical SOP:
`/home/toby/.jeriko/projects/go-alpha-marketing/docs/production-ready-site-sop.md`

## Rules

1. A site is not 100% production ready until the SOP checklist passes.
2. Verify both React/browser UI and prerendered/crawlable HTML.
3. GHL form claims require a live production POST and mapped field confirmation.
4. GBP alignment requires matching brand, phone, URL, categories/services, service areas, and public identity.
5. Never claim SMS, AI, booking, CRM automation, or tracking is live unless it has been tested live.
6. Keep SMS disabled until A2P is approved.
7. Add Privacy Policy when collecting name, phone, email, company, website, or tracking data.
8. Search for old/personal phone numbers and old brand names before launch.
9. Run check/build/verify gates before final reporting.
10. Final reports must include commit, production URL, live curl/browser proof, and setup-required blockers.

## UI/UX and motion standard

Jeriko must build sites that feel intentionally designed, not merely assembled.

Required polish checks for production/client sites:
- Clear visual hierarchy: one dominant hero message, obvious primary CTA, secondary CTA only when useful.
- Strong spacing rhythm: no cramped cards, glued labels, uneven paddings, or accidental text walls.
- Mobile-first execution: nav opens cleanly, tap targets are usable, no horizontal overflow, primary CTA remains easy to find.
- Customer-facing language: copy speaks as the business to the customer; no builder/process/SEO/system commentary in public UI.
- Service taxonomy quality: use natural customer labels, not keyword-stuffed labels like `<service> home improvement pro`.
- Trust modules: proof, reviews, project examples, process clarity, fit/not-fit guidance, or honest proof-pending state.
- Accessibility basics: every link has text or aria-label, forms have labels, focus states are visible, images have useful alt text.
- SEO/social basics: unique title/meta per route, canonical, sitemap, robots, Open Graph/Twitter tags, route-specific schema.
- Image discipline: no broken images; optimize size; use responsive dimensions; no giant 1MB+ card images unless justified.

Motion rules:
- Framer Motion is allowed and already available in the React web templates.
- Use motion to clarify hierarchy and affordance: entrance reveals, hover lift, active states, drawers, tabs, carousels, counters.
- Do not use motion to hide weak layout or slow down the page.
- Respect `prefers-reduced-motion`.
- Keep entrance motion subtle: 120–300ms for UI feedback, 300–700ms for hero/section reveals.
- Never animate important text so aggressively that it hurts readability.

## Design inspiration workflow

Use inspiration sources as references, not as copy-paste targets:
- Mobbin: app flows, onboarding, dashboards, forms, mobile UX patterns.
- 21st.dev: React component ideas and modern interaction patterns; adapt carefully and verify dependencies/license before use.
- Design Spells: micro-interactions, delightful details, hover states, cursors, easter eggs; use sparingly for business sites.
- Godly.website: high-end landing page composition, hero sections, visual hierarchy, spacing, typography, dark/light polish.
- DesignVault/ScreensDesign: mobile app screen, onboarding, paywall, and product UX references.

Do not blindly import code from inspiration sites. Convert the idea into project-native React/Tailwind/Radix/Framer Motion code and run verification.

## Minimum production gates

- Build/check passes.
- `jeriko verify-app` passes.
- Production deploy ready and canonical alias points to latest deployment when deploying.
- Key routes HTTP 200.
- Header/footer/meta/OG/schema brand is correct.
- Tap-to-call works when phone is present; old numbers are absent.
- Contact form posts to the intended backend or is clearly setup-required.
- Privacy/security basics are present.
- GBP alignment is confirmed or explicitly marked pending for local businesses.
- No false live SMS/AI/CRM/booking/tracking claims.
