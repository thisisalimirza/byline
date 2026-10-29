# Byline Design Principles

Design quality bar: Apple Human Interface Guidelines.

## Core Principles

### 1. One to Three Obvious Actions Per Page

Every page has a clear primary action. Secondary actions exist but don't compete for attention.

- **Landing page**: Start writing (primary), Learn more (secondary)
- **App page**: Generate article (primary), Save draft / Buy credits (secondary)
- **Account page**: View credits (primary), Purchase history (secondary)
- **Checkout**: Complete purchase (single action)

### 2. Each Fact Once Per Page

Never repeat information. If credits are shown in the header, don't also show them in a sidebar card unless the context is different (e.g., "Credits remaining" vs "Credits used this session").

### 3. Hide Empty Sections

Don't show "No drafts yet" cards or empty states unless the user needs to take action there. Empty sections should simply not render.

Exception: When a section is the primary purpose of the view (e.g., drafts tab when empty shows a helpful message about how to save drafts).

### 4. Plain Words

Write like a human, not a corporation or a robot.

| Avoid | Use |
|-------|-----|
| "An error has occurred" | "Something went wrong" |
| "Authentication required" | "Sign in to continue" |
| "Insufficient credits" | "You're out of credits" |
| "Transaction completed successfully" | "Done" or "Purchased" |
| "Invalid input parameters" | "Check your input" |

### 5. No Overlaps at Key Breakpoints

Test every page at these exact widths:
- **390px** — iPhone 14/15 Pro
- **1180px** — Small laptop / large tablet landscape
- **1512px** — MacBook Pro 14"

Nothing should:
- Overflow horizontally
- Have text overlapping other elements
- Have buttons or interactive elements too close to touch (min 44px touch target)
- Have truncated text that loses meaning

## Visual Language

### Spacing

Use the design system spacing scale. Don't invent custom values.

```
4px   — Tight (icon to label)
8px   — Compact (related elements)
12px  — Default (form fields)
16px  — Comfortable (cards)
24px  — Sections
32px  — Major sections
48px  — Page sections
```

### Typography

- **Display**: Fraunces — headings, hero text, numbers that matter
- **Body**: Plus Jakarta Sans — everything else
- **Mono**: DM Mono — code, tokens, technical values

### Color

Use semantic colors, not raw values:

- `--accent` for primary actions and highlights
- `--text` for primary content
- `--text-muted` for secondary content
- `--text-dim` for disabled/tertiary content
- `--surface`, `--surface2`, `--surface3` for layered backgrounds

### States

Every interactive element needs:
- **Default** — normal appearance
- **Hover** — subtle feedback (desktop only)
- **Active/Pressed** — immediate feedback
- **Disabled** — clearly unavailable
- **Loading** — shows progress without blocking

### Loading States

- Skeleton loaders for content areas
- Subtle pulse animation (not spinners) for buttons
- Never block the entire UI unless absolutely necessary

### Error States

- Inline errors near the source
- Toast for transient errors
- Full-page error only for unrecoverable states
- Always provide a way forward (retry, go back, contact support)

### Empty States

- Friendly illustration or icon (optional)
- Clear explanation of why it's empty
- Single action to fix it (if applicable)
- Don't be verbose — one sentence max

## Mobile Considerations

### Touch Targets

Minimum 44x44px for all interactive elements. Prefer 48px for primary actions.

### Safe Areas

Respect `env(safe-area-inset-*)` for notched devices and home indicators.

### Gestures

- Don't rely on hover states for critical information
- Support pull-to-refresh where it makes sense
- Avoid horizontal scrolling except for intentional carousels

### Performance

- Lazy load images below the fold
- Minimize layout shift (reserve space for dynamic content)
- Test on slow 3G — the app should remain usable

## Accessibility

- All images have alt text
- Color contrast meets WCAG AA (4.5:1 for text)
- Focus states are visible
- Screen reader announcements for dynamic content
- Keyboard navigation works for all interactive elements

## Content Guidelines

### Microcopy

- Use sentence case, not Title Case
- End with periods only for full sentences
- Button labels are verbs: "Save", "Generate", "Sign in"
- Don't use "Click here" or "Submit"

### Error Messages

Structure: What happened → What to do

> "Something went wrong. Try again, or contact us if it keeps happening."

Never blame the user. Never use technical jargon.

### Success Messages

Keep them brief. The UI state change is usually enough.

> "Saved" ✓

Not: "Your draft has been successfully saved to your account."
