# Byline

Byline writes a finished article from a topic and a keyword. Purchases are Stripe credit packs. Accounts are off until the Supabase variables below are set.

## Go-live checklist

Set these in the Vercel project `byline` (team `braskgroup`). The app keeps working when an optional variable is missing: that feature stays off.

| Variable | Required for | If unset |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Writing articles on credits | Generation returns the credit and shows an error |
| `STRIPE_SECRET_KEY` | Checkout, restore, and refunds. Stripe account `acct_1Re5SbAM6lqDJSwt` | Payments stay off |
| `STRIPE_WEBHOOK_SECRET` | Verifying Stripe webhooks | Webhooks are not verified |
| `RESEND_API_KEY` | One-time codes and the contact form | Purchases still work. Codes and the form ask the reader to email support |
| `EMAIL_FROM` | The from-address for those emails | Defaults to `Byline <ali@braskgroup.com>` |
| `KV_REST_API_URL` and `KV_REST_API_TOKEN` | Rate limits, codes, and in-progress articles across instances | In-memory store, cleared on restart |
| `SUPABASE_URL` | Accounts and saved drafts | Accounts stay off. Credits stay on the purchase email |
| `SUPABASE_ANON_KEY` | Accounts | Accounts stay off |
| `SUPABASE_SERVICE_ROLE_KEY` | Saving drafts, products, and credit balances | Account pages return "not configured" |
| `POSTHOG_API_KEY` | Product funnel | Analytics stay off. Nothing else changes |
| `POSTHOG_HOST` | PostHog region | Defaults to `https://us.i.posthog.com` |

Support mail goes to `ali@braskgroup.com`. Do not send marketing email. Google sign-in stays off.

### Stripe

Credit packs stay 10 for $5, 25 for $10, and 75 for $25.

Webhook endpoint: `https://bylineblogs.com/api/webhook/stripe`

Events:

- `checkout.session.completed`
- `charge.refunded`

Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

### Supabase

Turning accounts on is the three Supabase variables and nothing else in the app.

1. Create a Supabase project.
2. Apply every file in `supabase/migrations`, in filename order, from the SQL editor. Do not use `supabase db push` or `supabase db reset`.
3. Enable the email provider. Leave Google off.
4. Add `https://bylineblogs.com/app` to the redirect URLs.
5. Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`.

Row level security is enabled on every table: `profiles`, `drafts`, `products`, `credit_balances`, `purchases`, `credit_transactions`, and `generation_history`. Readers can only see their own rows. The server writes with the service role.

### PostHog

Events are sent only when `POSTHOG_API_KEY` is set:

- `landing_view` — home page
- `start` — the writing app
- `generate` — an article run starts
- `buy_click` — a pack is chosen
- `checkout_complete` — Stripe confirms payment
- `refund` — a refund is issued

### Health

`GET /api/health` returns `{ status: "ok", services: { stripe, supabase, redis, posthog } }`. Each flag is true only when that service is configured.

### Email

Verify the domain on the `EMAIL_FROM` address in Resend before codes will send. The contact form and the restore code both use that address. The reply-to on contact messages is the reader.
