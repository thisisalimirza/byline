# Design Review Log

Record design decisions, issues found, and fixes applied during development.

---

## 2026-10-29 3:17 PM ET critic pass

**Reviewed**: Production (https://bylineblogs.com) after PR #5 merged  
**Viewports**: 390px, 1180px, 1512px

### Confirmed Fixed on Prod

- ✅ Home @390 horizontal overflow
- ✅ App sidebar clipping
- ✅ Production basics (og-image.png, favicon.ico, 404.html, sitemap)
- ✅ Single "Start writing" CTA label
- ✅ Download cards alignment
- ✅ Removed "AI" from title, hero pill, and footer
- ✅ Refund subhead clarified

### New Findings (ranked by impact)

#### 1. Auth is off — account page is a dead end (CRITICAL)
- **Location**: /account, /app, /api/auth/status
- **Issue**: `/api/auth/status` returns `enabled:false`, so Sign-in is hidden. /account says "Sign in to view your account" but its only button is "Go to app" (dead end). /account is still in sitemap.
- **Copy contradictions when auth is off**:
  - Home feature 04: "No sign-up… nothing stored on our end"
  - Buy modal: "Articles are stored locally in your browser…"
  - Refund: "No purchases found on this device"
- **Fix**: Make /account button open sign-in modal or link to /app?signin=1; remove /account from sitemap while auth is disabled; make copy conditional on auth state
- **Missing env vars for auth**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- **Status**: Fixed on branch

#### 2. Vendor and model names still visible
- **Location**: app.html, index.html, buy modal, terms.html
- **Issues**:
  - App sidebar: "Model" dropdown with Opus/Sonnet/Sonnet 4.5
  - Home: "GPT-4o" pill in comparison window
  - Home: "Straight from the model to the page"
  - Buy modal: "No API key needed", "Have your own API key?"
  - Terms §2: "currently Anthropic"
- **Fix**: Model → Quality (Best/Fast); remove GPT-4o pill; "Unedited first draft"; move own-key to Advanced; remove Anthropic from Terms
- **Note**: ChatGPT comparison section and FAQ await Ali's decision
- **Status**: Fixed on branch

#### 3. Empty stage panels on first load
- **Issue**: Six empty panels at every width, panel 1 has monospace debug-looking text, panels 2-6 empty. At 390px, panels render under Setup below Generate so Setup/Results tabs do nothing.
- **Fix**: Show one friendly empty state in normal type, hide panels 2-6 until they start; on mobile show results only under Results tab
- **Status**: Fixed on branch

#### 4. Stage names use four sets and two orders
- **Location**: header stepper, panels, home "How it works", hero mockup
- **Issues**:
  - Header: Plan/Research/Write/SEO/Refine/Humanize
  - Panels: Planning/Research/Writing/SEO/Refining/Humanizing
  - Home: Strategist/Researcher/Writer/SEO Editor/Refiner/Humanizer
  - Mockup: Planning Your Article… with Refine before SEO, in Title Case
- **Fix**: Pick one set (Planning/Research/Writing/SEO/Refining/Humanizing), remove duplicate header stepper at 1180/1512, redraw mockup
- **Status**: Fixed on branch

#### 5. Sidebar spacing issues
- **Issues**: Advanced nested inside Promote card with double border; Credits card duplicates header's "0 credits"; at 390px Generate not full-width and Advanced toggle 35px (under 44px)
- **Fix**: Advanced as its own card with 8px gap; fold Credits into header pill + Buy button; Generate full-width and 44px min-height on Advanced at mobile
- **Status**: Fixed on branch

#### 6. Buy-credits modal issues
- **Issues**: Title "Generate articles instantly" (not descriptive), wrong subhead "One purchase = one full article" (it's one CREDIT = one article), BEST VALUE badge on 75 pack but highlight on 25, badge floats in gap at 390px
- **Fix**: Title "Buy credits", subhead "1 credit = 1 finished article. Credits never expire.", move badge to selected pack, fix mobile layout
- **Status**: Fixed on branch

#### 7. Legal pages need consistent header/footer
- **Issues**: Terms, Privacy, Refund don't have same logo header and footer as 404 and Account; "← Back to Byline" sits outside card on Terms at 1512; footer links 16px and account buttons 32px (under 44px)
- **Fix**: Add consistent header/footer, sentence-case headings, 44px min-height on all touch targets
- **Status**: Fixed on branch

#### 8. How it works cards — tag wrapping
- **Issues**: At 1180/1512, Refiner tag wraps and sits higher than others, Humanizer text runs into its tag
- **Fix**: Shorter nowrap tags pinned to card bottom with 16px space above
- **Status**: Fixed on branch

#### 9. Comparison windows unequal height
- **Issue**: ChatGPT window ends ~25px above Byline window
- **Fix**: Equal height (stretch) with scroll hint pinned inside
- **Status**: Fixed on branch

#### 10. Jargon fixes
- **Issues**:
  - OG image: "6-stage pipeline" → "Six editing passes"
  - Terms: "full pipeline run" → "1 article"
  - Refund: "Enter token manually" → "Restore a purchase with your receipt code"
  - FAQ: "Advanced Settings" → "Advanced"
- **Status**: Fixed on branch

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

## 2026-10-29 3:45 PM ET critic pass

**Reviewed**: Production (https://bylineblogs.com) after PR #5 merged  
**Viewports**: 390px, 1180px, 1512px

### Verified on Prod
- ✅ No horizontal overflow at 390/1180/1512 on any page
- ✅ Favicon, og-image, 404 page, legal pages all live
- ✅ Auth still disabled (`/api/auth/status` enabled:false)

### New Findings (ranked by impact)

#### 1. Home — Two proof sections with DIFFERENT articles (HIGH)
- **Location**: "See the difference" + "Download both / Judge for yourself"
- **Issue**: Comparison windows show a B2B email reply-rate article, then PDFs offer a Local SEO article. Confusing and duplicative (home is ~12,100px tall at 390).
- **Fix**: Removed duplicate "Download both" section; added single "Try it yourself" CTA at bottom of comparison section.
- **Status**: ✅ Fixed on branch

#### 2. Home 1180/1512 — How it works 6-column layout issues (HIGH)
- **Location**: "How it works" cards
- **Issue**: 6 columns at 172px each; body runs 9–10 lines of 13px dim text; tags wrap ("removes robotic patterns").
- **Fix**: Changed to `repeat(3, minmax(0,1fr))` grid (2 rows of 3), body 14px/1.6, tags nowrap pinned to bottom, step-card flexbox for equal heights.
- **Status**: ✅ Fixed on branch

#### 3. Leftovers from PR #6 branch (MEDIUM)
- **Issue (a)**: index.html `.chatgpt-model-pill` showing "4o" — deleted the element entirely.
- **Issue (b)**: "How it works" cards renamed to match app: Planning, Drafting, SEO, Refining, Humanizing, Final. Colors unified (step-6 now uses --a5 purple instead of yellow).
- **Status**: ✅ Fixed on branch

#### 4. Home — "No account needed" stated 3x (MEDIUM)
- **Location**: Feature card 04, FAQ "Do I need an account?", final CTA note
- **Issue**: Contradicts sign-in work when auth is enabled.
- **Fix**: CTA note changed to "Credits start at $5 for 10 articles" (kept FAQ mention as single source).
- **Status**: ✅ Fixed on branch

#### 5. Home 1512 — Headline orphans (MEDIUM)
- **Issue**: Hero h1 breaks to a lone "human." on line 3; Product promotion h2 leaves "ad." alone on last line.
- **Fix**: Added `h1, h2 { text-wrap: balance; }` globally.
- **Status**: ✅ Fixed on branch

#### 6. Home — Three numbering systems (LOW)
- **Issue**: Why cards use "01" mono chips, How it works uses colored circled 1–6, Features uses "01" chips. Only How it works is a sequence.
- **Fix**: Keep circled numbers for stages only; remove number chips from Why-Byline and Features cards (use small icon or nothing).
- **Status**: Noted

#### 7. App — Placeholder truncation and touch target (LOW)
- **Issue**: "Who is this for?" truncates to "e.g. small business owners with no marke"; "⚙ Advanced" toggle 35px tall.
- **Fix**: Shortened placeholder to "e.g. small business owners"; added min-height 44px on Advanced toggle at mobile.
- **Status**: ✅ Fixed on branch

#### 8. Shared footer inconsistency (LOW)
- **Issue**: Home footer has Terms/Privacy/Refunds only; account has Request refund/Terms/Privacy/Contact support; 404 has Terms/Privacy/Refunds; legal pages differ.
- **Fix**: One footer everywhere: Byline · Terms · Privacy · Refunds · Contact (mailto) · © 2026 Byline; same container width as page content; links min-height 44px on mobile.
- **Note**: /site.webmanifest 404s — add one or drop the reference.
- **Status**: Noted

#### Owner decision needed (do not change without Ali)
- Privacy policy still names Anthropic and "sign in with Google" — fine legally, but flagged for review.

---

## 2026-10-29 4:15 PM ET critic pass

**Reviewed**: Production (https://bylineblogs.com) unchanged since 3:45 PM  
**Viewports**: 390px, 1180px, 1512px

### New Findings (ranked by impact)

#### 1. Vendor/model names still visible (HIGH)
- **Location**: app.html Model dropdown, home comparison pill, Terms §7, Privacy
- **Issues**:
  - App "Model" dropdown shows "Sonnet — Faster" (should be Quality with Best/Fast) — ✅ Already fixed
  - Home comparison "4o" pill (still a model name, remove entirely) — ✅ Already removed in 3:45 PM pass
  - Home download card "Straight from the model to the page" → "Unedited first draft." — ✅ Already removed in 3:45 PM pass
  - Terms §7 names "Anthropic (content generation)" — ✅ Fixed: changed to "a content-generation provider"
  - Privacy provider list has "Anthropic — Content generation" — ✅ Fixed: changed to "Content generation provider"
- **Status**: ✅ Fixed on branch

#### 2. /account dead end (MEDIUM)
- **Issue**: Only "Go to app →" button, sign-in hidden, still in sitemap.xml
- **Fix**: Verify PR #7 changes cover this
- **Status**: Verify

#### 3. Empty stage panels (MEDIUM)
- **Issue**: Six panels with monospace text; at 390px they stack under Generate so Setup/Results tabs do nothing
- **Fix**: Verify PR #7 changes cover this
- **Status**: Verify

#### 4. Stage names not unified (MEDIUM)
- **Issue**: Use one set everywhere: Planning, Research, Writing, SEO, Refining, Humanizing
- Home "How it works" cards: ✅ Fixed to Planning, Research, Writing, SEO, Refining, Humanizing
- App panel/pipeline/config names: ✅ Fixed to match
- Hero mockup: ✅ Fixed to match
- FAQ "How is Byline different...": ✅ Fixed order to "planning, research, writing, SEO, refining, and humanizing"
- **Status**: ✅ Fixed on branch

#### 5. No-accounts copy contradictions (MEDIUM)
- **Issue**: Feature 04 "No sign-up… nothing stored on our end" and FAQ "until you choose to sign in" contradict reality
- Feature 04: Already says "Start immediately" with neutral copy
- FAQ "Do I need an account?": ✅ Fixed to "Your drafts are saved locally in your browser."
- FAQ "Advanced Settings" → "Advanced": Already correct
- **Status**: ✅ Fixed on branch

#### 6. App sidebar issues (LOW)
- **Issue**: Credits card has no number, duplicates header pill; Advanced inside Promote with double border; at 390px Advanced 35px tall, Generate not full width
- **Status**: Partially addressed in earlier passes

#### 7. How-it-works tag wrapping (LOW)
- **Issue**: Refiner tag wraps, Humanizer text collides with tag at 1180/1512
- **Fix**: Short nowrap tags pinned to bottom with 16px above
- **Status**: Addressed in 3:45 PM pass

#### 8. Comparison windows unequal height (LOW)
- **Issue**: Left window ends ~15px above Byline window at 1180/1512
- **Fix**: Stretch to equal height
- **Status**: Noted

#### 9. Legal pages header/footer (LOW)
- **Issue**: No logo header/footer; Back link floats outside card; Title Case headings; touch targets under 44px
- **Fix**: Use 404 page's shared header/footer, sentence case, 44px min targets
- **Status**: Previously addressed

#### 10. Polish items (LOW)
- Focus ring: ✅ Added `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }` to index.html and app.html
- Hero subhead: ✅ Changed to "optimize articles for search" (avoids SEO-optimize break)
- App placeholder: ✅ Already shortened in 3:45 PM pass
- Page title: ✅ Changed to sentence case "Byline — Articles that rank and sound human"
- Promo visual title: ✅ Changed to sentence case "Promote your brand"
- **Status**: ✅ Fixed on branch (except "six" count reduction — kept as is)

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
