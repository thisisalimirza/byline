# Design Review Log

Record design decisions, issues found, and fixes applied during development.

---

## 2026-10-29 (2:50 PM ET) — Design Critic Follow-up

**Reviewed**: Production + PR #5 preview  
**Viewports**: 390px, 1180px, 1512px

### Critical Finding

**Production is still the pre-review build.** PR #5 has green checks but hasn't been merged. All 10 items marked "Fixed" below are on the branch only, not live.

Measured on prod just now:
- home@390 scrollWidth 483 vs 390 (.prompt-pill, #annoToggle, .chatgpt-window)
- /og-image.png 404
- /favicon.ico 404
- Unknown URLs return bare "Error" page
- sitemap lists only /
- /privacy, /terms, /account all 404
- Title still "Byline — AI Articles That Rank…"
- Hero pill "Powered by Claude"
- Footer "Built with Claude — AI Article Studio"

### New Findings

#### 1. AI/vendor mentions remain (owner rule violation)
- **Location**: index.html, app.html, refund.html
- **Issues**:
  - FAQ "Do I need an Anthropic account?" + "use your own Anthropic key"
  - "GPT-4o" model pill in comparison window
  - "six agents" / "agent" throughout pipeline, features, FAQ
  - "AI Model" label in app
  - "Use my own API key instead", "Have your own Anthropic API key?"
  - "billed directly to your Anthropic account"
  - "Add credits or enter your Anthropic API key"
  - refund: "the API costs have already been incurred"
- **Fix**: Remove all vendor names from user-facing copy; "agents" → "stages"; "AI Model" → "Quality"; move BYOK to Advanced with no vendor name
- **Status**: Fixed on branch

#### 2. Title Case and "click" copy persist
- **Location**: app.html
- **Issues**: "Your Article", "Promote Your Brand", "Advanced Settings", "Generate Article", "Planning Your Article", etc.; "Click Save Draft", "click here", "then click Generate"
- **Fix**: Sentence case everywhere; buttons as verbs; remove "click" language
- **Status**: Fixed on branch

#### 3. --text-dim fails WCAG AA, inconsistent across files
- **Values found**: index #4e4b44 (2.25:1), app/account #504d47 (2.3:1), 404 #5e5b54 (2.9:1), refund #7a756c (4.3:1)
- **Fix**: Unify to --text-dim: #8f897d (≥4.5:1); --text-muted: #a39d90
- **Status**: Fixed on branch

#### 4. Jargon: "pipeline" and wrong phrases
- **Issues**: "6-stage writing pipeline", "The Pipeline" eyebrow, "you don't pick a credit", "← back to pipeline"
- **Fix**: "Six editing passes, one article"; "How it works"; clearer CTA copy; "← Back to editor"
- **Status**: Fixed on branch

#### 5. Touch targets under 44px (verify on branch)
- **Issues**: nav buttons, footer links, form inputs, toggles all under 44px
- **Fix**: min-height:44px on all interactive elements; add Playwright e2e test
- **Status**: Fixed on branch

#### 6. ChatGPT naming (owner decision needed)
- **Issue**: "ChatGPT vs. writing that sounds human" section names a chatbot
- **Note**: If no-AI rule is strict, relabel as "Typical first draft" with link as proof
- **Status**: Noted — awaiting owner decision

---

## 2026-10-29 (2:17 PM ET) — Design Critic Review

**Reviewed**: Production (https://bylineblogs.com) at `/`, `/app`, `/refund`, 404  
**Viewports**: 390px, 1180px, 1512px  
**Tool**: Playwright

### Findings (ranked by impact)

#### 1. Home @390 — Horizontal overflow (CRITICAL)
- **Issue**: Document scrollWidth 483px vs 390px viewport
- **Culprits**: `.prompt-banner`/`.prompt-pill`, `.anno-toggle` (#annoToggle at x=356–483), `.compare-col.chatgpt-col`/`.chatgpt-window` (16–483px)
- **Fix**: Grid columns `minmax(0,1fr)`, single column under 768px; `.prompt-pill` white-space:normal + max-width:100%; right-align #annoToggle inside container
- **Status**: Fixed on branch

#### 2. App @1180/1512 — Sidebar cards clipped
- **Issue**: Credits card cuts off "Use my own API key"; Article card clips AI Model select; Advanced Settings overlaps Promote card
- **Fix**: Sidebar overflow-y:auto, cards height:auto, Generate sticky at bottom; Advanced Settings as separate card
- **Status**: Fixed on branch

#### 3. Missing production basics
- **Issues**:
  - og:image → /og-image.png returns 404
  - Unknown routes show raw Express "Cannot GET /x"
  - Placeholder `<meta name="google-site-verification" content="REPLACE_WITH_YOUR_GSC_CODE">`
  - No PNG favicon, /favicon.ico 404s
  - sitemap.xml lists only /
- **Fix**: Add og-image.png, styled 404.html, remove placeholder meta, add favicon, update sitemap
- **Status**: Fixed on branch

#### 4. Home @390 — Hero mockup collapses
- **Issue**: Browser chrome strip with no content (~60px tall)
- **Fix**: Hide mockup below 600px or scale down with content
- **Status**: Fixed on branch

#### 5. Home — One action, five labels
- **Issue**: "Open App", "Try Byline →", "Start generating →", "Open Byline →" all go to /app
- **Principle**: 1 (1-3 obvious actions per page)
- **Fix**: Single primary label "Start writing" everywhere; drop "Open App" from nav
- **Status**: Fixed on branch

#### 6. Home @1180/1512 — Download cards mismatched
- **Issue**: Byline card 8px lower, different height, one button vs two
- **Fix**: align-items:stretch, equal heights, consistent button stack; pipeline tag pills pinned to bottom
- **Status**: Fixed on branch

#### 7. App — Credits repeated 3x, named two ways
- **Issue**: Header "0 credits", card "0 articles left", plus device note and refund link
- **Principle**: 2 (each fact once per page)
- **Fix**: Show number once in header, consistent naming, move refund to footer; remove duplicate step indicators
- **Status**: Fixed on branch

#### 8. App — Microcopy vs principles
- **Issues**: Title Case labels, monospace empty states look like debug output
- **Principle**: 3 (hide empty sections), plain words
- **Fix**: Sentence case labels; single friendly empty state in step 1, hide others
- **Status**: Fixed on branch

#### 9. Refund page — Copy contradiction & contrast
- **Issue**: "No questions asked" then 50% condition; low contrast text (~#555 on #111)
- **Fix**: Update subhead to "Full refund if you've used less than half your pack"; raise --text-dim; move back link inside card column
- **Status**: Fixed on branch

#### 10. Touch targets @390
- **Issues**: Multiple elements under 44px min-height; two `<h1>`s on homepage; pricing inconsistency "$0.40" vs actual packs
- **Fix**: Bump touch targets to min-height:44px; demo title to h3; pricing "from $0.33" or "$5 for 10"
- **Status**: Fixed on branch

---
