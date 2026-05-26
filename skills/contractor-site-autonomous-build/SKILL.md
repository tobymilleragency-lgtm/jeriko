---
name: contractor-site-autonomous-build
description: Build premium contractor/local-service websites without operator voice, brochureware, fake claims, or weak navigation.
userInvocable: false
---

# contractor-site-autonomous-build

Use this for every contractor, construction, remodeling, roofing, HVAC, plumbing, electrical, fencing, concrete, local-service, or service-area website build.

## Non-negotiable standard

Build a real customer-facing contractor website, not an agent demo, not a generic brochure, and not Toby/Hermes/operator-flavored copy.

Never use Toby/Hermes/operator voice in customer-facing copy.

Forbidden public-copy words and tones:
- Badass
- trash
- garbage
- operator
- mission
- no excuses
- built by an operator
- AI-built
- generated
- template
- this site
- site speaks to
- SEO content
- SEO page
- service page
- city page
- route
- crawler
- crawlable
- sitemap
- lead flow
- lead leak
- flat brochure
- generic contractor page
- local SEO system
- quote path
- estimate request workflow
- word count
- guide depth

Allowed tone:
- Professional
- local
- clear
- specific
- credible
- plainspoken
- homeowner/customer focused

## Required nav contract

Desktop primary nav must be clean, readable, and conventional:
- Home
- Services
- Service Areas
- Process
- About
- Contact or Request Estimate

Do not label service-area navigation as only `Cities`. `Cities` can appear as secondary copy, but the primary nav label must be `Service Areas`.

Mobile nav must not be the only visible nav on desktop. If a `Menu` button exists, desktop links must still be visible at normal desktop widths.

## Required route contract

A complete contractor/local-service site must include:
- `/`
- `/services`
- at least four individual `/services/<service>` pages
- `/service-areas`
- at least three city/service-area pages
- `/process`
- `/about`
- `/projects` or `/gallery`
- `/reviews` or `/faq` when real reviews are not supplied
- `/contact`
- `/privacy`
- `/terms`
- `robots.txt`
- `sitemap.xml`

## Content rules

- Never invent license, insurance, bonded, BBB, award, 5-star, financing, emergency, warranty, years-in-business, or review claims unless the user supplied them.
- If a phone/email is missing, do not create fake masked contact info. Prefer an honest estimate form, but the form must work or clearly be disabled with exact setup needed.
- Service pages need useful homeowner-facing sections: problems solved, what can be included, process, local considerations, and CTA.
- City pages must not be thin doorway pages. Each city page needs useful local/service-fit copy.
- Crawler/prerender HTML must be route-specific. Do not reuse one generic fallback paragraph across services/cities, do not expose words like crawler/page/SEO/sitemap to visitors, and do not publish thin sub-120-word service or city route bodies.
- Every prerendered route in a multi-page contractor/local-service sitemap must include crawler-visible JSON-LD (`LocalBusiness`, `HomeAndConstructionBusiness`, `GeneralContractor`, `Service`, `FAQPage`, or `BreadcrumbList`). React-only metadata is not enough.
- The local/start verification command for prerendered multi-route sites must serve `dist/public/<route>/index.html` for nested routes. Do not use `vite preview` as the appBuilder verification/start command for these sites; it can return the root SPA shell for `/services/*` and hide broken service/city pages.
- Avoid slogans that sound like an internal operator mantra. Public copy should sound like the contractor, not the AI agent.

## Visual/build rules

- Preserve or improve premium modules when available: strong hero visual, service grid, process section, trust/proof section, sticky or repeated CTA, and mobile-safe navigation.
- Do not downgrade a premium template into flat text cards.
- Do not ship broken form actions. If `/api/estimate` is called, verify it returns success locally.
- Run `jeriko verify-app` and fix every red gate. A build/typecheck pass is not enough.

## Done proof required

Before claiming done, prove:
- project-state/appSpec exists
- verify-app passed with contractor/premium gates
- no forbidden public-copy words
- route breadth works
- contact/estimate path is either working or explicitly blocked with exact missing config
- persistent localhost preview URL is running
