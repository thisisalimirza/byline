# Design Review Log

Record design decisions, issues found, and fixes applied during development.

---

## 2026-10-29 — Design Critic Review

**Reviewed**: Production (https://bylineblogs.com) at `/`, `/app`, `/refund`, 404  
**Viewports**: 390px, 1180px, 1512px  
**Tool**: Playwright

### Findings (ranked by impact)

#### 1. Home @390 — Horizontal overflow (CRITICAL)
- **Issue**: Document scrollWidth 483px vs 390px viewport
- **Culprits**: `.prompt-banner`/`.prompt-pill`, `.anno-toggle` (#annoToggle at x=356–483), `.compare-col.chatgpt-col`/`.chatgpt-window` (16–483px)
- **Fix**: Grid columns `minmax(0,1fr)`, single column under 768px; `.prompt-pill` white-space:normal + max-width:100%; right-align #annoToggle inside container
- **Status**: Fixed

#### 2. App @1180/1512 — Sidebar cards clipped
- **Issue**: Credits card cuts off "Use my own API key"; Article card clips AI Model select; Advanced Settings overlaps Promote card
- **Fix**: Sidebar overflow-y:auto, cards height:auto, Generate sticky at bottom; Advanced Settings as separate card
- **Status**: Fixed

#### 3. Missing production basics
- **Issues**:
  - og:image → /og-image.png returns 404
  - Unknown routes show raw Express "Cannot GET /x"
  - Placeholder `<meta name="google-site-verification" content="REPLACE_WITH_YOUR_GSC_CODE">`
  - No PNG favicon, /favicon.ico 404s
  - sitemap.xml lists only /
- **Fix**: Add og-image.png, styled 404.html, remove placeholder meta, add favicon, update sitemap
- **Status**: Fixed

#### 4. Home @390 — Hero mockup collapses
- **Issue**: Browser chrome strip with no content (~60px tall)
- **Fix**: Hide mockup below 600px or scale down with content
- **Status**: Fixed

#### 5. Home — One action, five labels
- **Issue**: "Open App", "Try Byline →", "Start generating →", "Open Byline →" all go to /app
- **Principle**: 1 (1-3 obvious actions per page)
- **Fix**: Single primary label "Start writing" everywhere; drop "Open App" from nav
- **Status**: Fixed

#### 6. Home @1180/1512 — Download cards mismatched
- **Issue**: Byline card 8px lower, different height, one button vs two
- **Fix**: align-items:stretch, equal heights, consistent button stack; pipeline tag pills pinned to bottom
- **Status**: Fixed

#### 7. App — Credits repeated 3x, named two ways
- **Issue**: Header "0 credits", card "0 articles left", plus device note and refund link
- **Principle**: 2 (each fact once per page)
- **Fix**: Show number once in header, consistent naming, move refund to footer; remove duplicate step indicators
- **Status**: Fixed

#### 8. App — Microcopy vs principles
- **Issues**: Title Case labels, monospace empty states look like debug output
- **Principle**: 3 (hide empty sections), plain words
- **Fix**: Sentence case labels; single friendly empty state in step 1, hide others
- **Status**: Fixed

#### 9. Refund page — Copy contradiction & contrast
- **Issue**: "No questions asked" then 50% condition; low contrast text (~#555 on #111)
- **Fix**: Update subhead to "Full refund if you've used less than half your pack"; raise --text-dim; move back link inside card column
- **Status**: Fixed

#### 10. Touch targets @390
- **Issues**: Multiple elements under 44px min-height; two `<h1>`s on homepage; pricing inconsistency "$0.40" vs actual packs
- **Fix**: Bump touch targets to min-height:44px; demo title to h3; pricing "from $0.33" or "$5 for 10"
- **Status**: Fixed

---
