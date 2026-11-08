# Catalog Gate (working name)

Pay for a catalog import only when it passes. The buyer's PayPal payment is **authorized** when the job starts and **captured in full** only after the delivered CSV passes rules agreed in advance **and** a person clicks capture. The rules decide; an AI model only explains the findings and must cite real line numbers, or its text is rejected.

Authorize/capture is not escrow and not a licensed custody service. Everything here runs on the PayPal **sandbox** (test money) or in **fixture** mode (simulated PayPal responses, clearly labeled, no receipt).

## Run

```bash
node --version   # 22+
npm test         # 19 scenarios (V1-V6, F1-F8, H1-H2, I1-I2, C19), fixture mode
npm start        # http://localhost:8787 , fixture mode
```

Sandbox mode (needs a PayPal developer sandbox app):

```bash
export PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=...   # sandbox only; never commit
export BASE_URL=https://your-host                       # PayPal returns the buyer here after approval
npm run start:sandbox
```

Optional advisory model: `GEMINI_API_KEY` (and `GEMINI_MODEL`). Without it the UI shows "advisory unavailable" and nothing else changes.

## How it works

1. **Brief**: columns `sku,nombre,precio,stock`, 200 rows, 2% tolerance (minimum 196 valid), key `sku`, and an approved sample (data lines 2 to 11, compared literally).
2. **Authorize**: Orders v2 with `intent: AUTHORIZE`; the buyer approves; the order is authorized.
3. **Deliver and check**: a deterministic check produces the report (file sha256, rejections by line, duplicate keys, sample mismatches) and a verdict: PASS, PASS WITH REJECTIONS (capture needs "I read the N rejected rows") or FAIL (no capture).
4. **Explain**: the model sees only the report, never the raw file. A checker rejects any citation outside the file or without a finding.
5. **Capture**: one human click sends `POST /v2/payments/authorizations/{id}/capture` with the full authorized amount stated explicitly and `final_capture: true`. No partial capture.

Safety rules in code (`src/pedido.mjs`): a deterministic UUID-shaped PayPal-Request-Id derived from (order, operation, authorization) and a stored payload hash (same id with a different payload is blocked locally); per-order lock; lost response goes to UNCERTAIN and is reconciled by GET only, with the capture linked back to the authorization; PENDING capture is not counted as received; no void after capture; one reauthorization, by a human, days 4 to 29; expired on day 30; webhooks deduplicated and applied forward only.

## Persistence and webhooks (sandbox mode)

- Orders, request ids, payload hashes and processed webhook ids are kept in `DATA_DIR/orders.json`, written atomically. On restart every order is restored; an order that was in the middle of a capture POST comes back as UNCERTAIN and can only be reconciled by GET.
- `POST /webhooks/paypal` (sandbox mode with `PAYPAL_WEBHOOK_ID`) verifies the PayPal signature with the documented self-verification (transmission id, time, webhook id and CRC32 of the raw body, SHA256withRSA against the certificate from an https paypal.com URL), deduplicates by event id and applies events forward only.
- Fixture mode keeps everything in memory and says so on screen.

## PayPal references (read 8 Nov 2026)

- Orders v2 authorize: https://developer.paypal.com/api/orders/v2/orders-authorize
- Capture an authorization (`final_capture`): https://developer.paypal.com/api/payments/v2/authorizations-capture
- Authorization honor period and 29-day validity: https://developer.paypal.com/docs/checkout/advanced/authorization-honor/
- Idempotency (`PayPal-Request-Id`): https://developer.paypal.com/api/rest/reference/idempotency/
- Webhook signature verification: https://developer.paypal.com/api/rest/webhooks/rest/
- Webhook event names: https://developer.paypal.com/api/rest/webhooks/event-names/

## Not done yet

First sandbox receipt (needs the sandbox app credentials in the server environment), hosted demo, video. Webhook postback verification through `verify-webhook-signature` is not used; self-verification is.

## License

MIT
