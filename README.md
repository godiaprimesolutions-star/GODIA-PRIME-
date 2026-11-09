# GODIA PRIME CONNECT ENTERPRISE — Cloudflare starter

This package supplies the remaining repository files (excluding the `public/index.html` you already uploaded) and adds a Cloudflare Worker API, additive D1 migration, account endpoints and a Safaricom Daraja **production** STK Push endpoint.

## Important status / scope

The supplied HTML currently stores most business records (businesses, supplier listings, stock, POS, orders, jobs and settings) in browser `localStorage`. This package does **not** silently claim those modules have been migrated to D1. The Worker in this package provides the first server foundation: health, account registration/login/logout, current-user lookup and M-Pesa STK Push/callback/payment status. The existing business modules still need their individual save/load functions connected to API endpoints before those records become shared, durable Cloudflare records.

The original HTML's backend URL placeholder is changed to same-origin (`window.location.origin`), so its API calls target this Worker when the site is served by the same Worker.

## Files

- `public/index.html` — add the index.html you have already uploaded; this ZIP intentionally does not duplicate it.
- `public/manifest.json` and `public/icons/` — installable web-app metadata and scalable icons.
- `src/index.js` — Cloudflare Worker API and static asset handler. Authentication here is PIN-based; no OTP service is implemented in this package.
- `migrations/0001_initial.sql` — additive `gpce_*` tables for users, sessions and payments. It does not drop or overwrite existing `gpc_*` tables.
- `wrangler.toml` — Worker, static asset and D1 binding configuration. Fill in the ID/name of your **existing** D1 database.
- `package.json` — Wrangler scripts.
- `.gitignore` — excludes secrets and local build files.
- `.dev.vars.example` — names of local variables only; no real credentials.

## Before deploying

1. Keep a backup of the existing D1 database. Do not delete it or run destructive SQL.
2. In Cloudflare, open the existing D1 database you intend to use. Copy its database name and ID into `wrangler.toml`. Do not create another database unless you explicitly decide to.
3. Confirm that the existing Worker name in `wrangler.toml` is the Worker you intend to update. This package uses `godia-prime-connect-enterprise-ltd`; change it only if your existing Worker has a different exact name.
4. Install Node.js and run `npm install`.
5. Apply the additive migration to the selected existing database: `npm run d1:migrate:remote`.
6. Add the production secrets to the existing Worker in Cloudflare Dashboard → Workers & Pages → your Worker → Settings → Variables and Secrets:
   - `MPESA_CONSUMER_KEY` (Secret)
   - `MPESA_CONSUMER_SECRET` (Secret)
   - `MPESA_SHORTCODE` (Text/Secret)
   - `MPESA_PASSKEY` (Secret)
   - `MPESA_CALLBACK_URL` (Text): `https://YOUR-WORKER-DOMAIN/api/mpesa/callback`
7. Set `MPESA_ENV` to `production` and `MPESA_TRANSACTION_TYPE` to the transaction type issued for your Daraja production shortcode (normally `CustomerPayBillOnline` for a PayBill).
8. Ensure Safaricom Daraja has the callback URL registered/allowed for your production app and that the shortcode/passkey match the production credentials.
9. Deploy the same existing Worker: `npm run deploy`.

**Do not paste consumer keys, consumer secret, passkey, passwords, PINs, access tokens or security credentials into GitHub, this README, HTML, JavaScript or chat.** Add them only as Cloudflare Worker secrets. If any credential has previously been exposed, rotate it with Safaricom/Cloudflare.

## API endpoints

- `GET /api/health`
- `POST /api/auth/register` JSON: `{ "name": "...", "email": "...", "phone": "07...", "pin": "1234" }`
- `POST /api/auth/login` JSON: `{ "phone": "07...", "pin": "1234" }` — sets an HttpOnly Secure session cookie.
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/payments/mpesa/stkpush` JSON: `{ "phone": "07...", "amount": 100, "accountReference": "ORDER123", "description": "Order payment" }`
- `POST /api/mpesa/callback` — Safaricom callback.
- `GET /api/payments/{paymentId}` — authenticated payment status.

A payment starts as `PENDING`; it becomes `SUCCESS` or `FAILED` only after a callback is received. Never treat an STK prompt or a browser message as proof of payment. Reconcile important payments against the Daraja transaction records/statement before releasing goods.

## Production M-Pesa notes

This is a production-only Daraja URL implementation (`https://api.safaricom.co.ke`). There is no sandbox URL or sandbox credential in the production code. A live STK push will request a real customer payment. Test with a low-value, authorized transaction after verifying the shortcode, account, callback URL and customer consent.

The callback endpoint correlates the result by `CheckoutRequestID`. Safaricom callback delivery should be monitored and payments reconciled; a callback alone is not a substitute for financial reconciliation. For stronger verification, add the Daraja STK Query/reconciliation workflow before relying on this as the sole payment proof.

## What remains to connect

The HTML contains many business modules that currently call `persist()` and write to `localStorage`. To make the whole platform multi-user and cloud-backed, each module needs authenticated API routes and D1 tables for businesses, suppliers, products, marketplace listings, orders, POS stock/sales, deliveries, jobs, credit and audit logs, followed by replacing local-only `persist()`/load behavior. Do not describe those modules as cloud-synced until this work and multi-user tests are complete.


## Files deliberately not included

- `src/authOTP.js`: not included because this version implements phone + PIN registration/login, not OTP delivery. An empty or pretend OTP file would not provide real OTP functionality. We can add it only after selecting and configuring a real OTP provider.
- `scripts/`: no build or migration helper script is required; Wrangler commands are defined in `package.json`.
