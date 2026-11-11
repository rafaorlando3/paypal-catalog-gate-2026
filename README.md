# Catalog Gate (working name)

Pay for a catalog import only when it passes. The buyer's PayPal payment is **authorized** when the job starts and **captured in full** only after the delivered CSV passes rules agreed in advance **and** a person clicks capture. The rules decide; an AI model only explains the findings. A checker rejects any explanation that cites a line outside the file or a line without a finding. That check is about citations only: it does not prove that the explanation is semantically right.

Authorize/capture is not escrow and not a licensed custody service. Everything here runs on the PayPal **sandbox** (test money) or in **fixture** mode (simulated PayPal responses, clearly labeled, no receipt).

## Run

```bash
node --version   # 22+
npm test         # unit suite; exact counts are in the CI run, no PayPal call
npm start        # http://localhost:8787 , fixture mode (public)
npm run demo:ai  # defective lots: rules verdict, fixed template explanation, model explanation (only with GEMINI_API_KEY), checker
```

Sandbox mode (needs a PayPal developer sandbox app):

```bash
export PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=...   # sandbox only; never commit
export OPERATOR_TOKEN_SHA256=...                        # sha256 hex of the operator token; the token itself is never stored
export BASE_URL=https://your-host                       # PayPal returns the buyer here after approval
export DATA_DIR=/var/lib/catalog-gate-sandbox           # not shared with any other process
npm run start:sandbox
```

The REST client talks only to `https://api-m.sandbox.paypal.com`: there is no production switch and no base override, and redirects are refused so credentials never leave that origin. Headers and the full body are read under one timeout: an answer that is not complete and well formed (body lost or hung, non-JSON, a 2xx without the id or status the operation needs, 5xx, 408, 409) leaves the operation UNCERTAIN, never a refusal and never a success. Only a complete 4xx is a definitive refusal. A void may answer 204 with no body.

Run fixture and sandbox as two separate processes. The fixture is public: one simulator per order, each order bound to the visitor's session (another visitor gets "not found"), a cap on orders per session. The sandbox is protected: every order route needs the operator login, and the login gets a new session id. In both modes every POST needs the session cookie (HttpOnly, SameSite=Strict), the per-session CSRF token in `X-CG-CSRF` and a same-origin `Origin` header. The signed PayPal webhook is the only POST without a session.

Optional advisory explanation: `GEMINI_API_KEY`, using the allowlisted `gemini-3.5-flash-lite` model (`GEMINI_MODEL` must match). The adapter sends only a deterministic report to the fixed Google API origin, refuses redirects, bounds input/output and timeout, requires a complete STOP response and excludes thought parts. Errors exposed to the UI use fixed public codes. `fixtures/L0/AI-EXPECTED-FACTS-20261111.json` freezes three synthetic evaluation lots before live answers; `demo:ai` accepts exactly those lots and verifies their hashes before any call. A live evaluation is a separately controlled, single invocation capped at three calls with no retries; do not run it repeatedly. Without it the UI shows "advisory unavailable" and nothing else changes. Model calls are capped per order, per session and per day (`LLM_MAX_PER_ORDER`=3, `LLM_MAX_PER_SESSION`=5, `LLM_MAX_PER_DAY`=50), counted before the call.

## How it works

1. **Brief**: columns `sku,nombre,precio,stock`, 200 rows, 2% tolerance (minimum 196 valid), key `sku`, and an approved sample (data lines 2 to 11, compared literally).
2. **Authorize**: Orders v2 with `intent: AUTHORIZE`; the buyer approves; the order is authorized.
3. **Deliver and check**: a deterministic check produces the report (file sha256, rejections by line, duplicate keys, sample mismatches) and a verdict: PASS, PASS WITH REJECTIONS (capture needs "I read the N rejected rows") or FAIL (no capture).
4. **Explain**: the model sees only the report, never the raw file. A checker rejects any citation outside the file or without a finding.
5. **Capture**: one human click sends `POST /v2/payments/authorizations/{id}/capture` with the full authorized amount stated explicitly and `final_capture: true`. No partial capture.

Safety rules in code (`src/pedido.mjs`): every external call (create, authorize, capture, void, reauthorize) is journaled before it is sent: intent, a deterministic UUID-shaped PayPal-Request-Id derived from (order, operation, authorization), the payload hash and an in-flight state. The same id with a different payload is blocked locally. A lost answer, or a restart while a request was in flight, leaves an operation-specific UNCERTAIN state that blocks every other action. It is settled by GET where a GET can settle it (authorize by GET order, capture and void by GET authorization and capture). Otherwise it stays blocked with an alert for manual review. No POST is ever sent for an UNCERTAIN operation, not even by a human click, because PayPal-Request-Id retention and replay behaviour per endpoint are not qualified yet. Other rules: per-order lock; PENDING capture is not counted as received; no void after capture; one reauthorization, by a human, days 4 to 29; expired on day 30.

## Suggested fixes for a redelivery request (C3, AI off by default)

After a check with findings, `Suggest fixes` lists, per finding, what the supplier should change. The suggestions only feed a redelivery request written from a fixed template in Spanish or Portuguese. They never change the delivered file, the report, the verdict, the capture rules or any PayPal state, and a person accepts each one.

- **Rule-based baseline (B1)**, always on: number words in Spanish and Portuguese from 0 to 999, unit words, spaces, sku case, the approved sample value, and a split decimal only when the comma-in-name reading is invalid. A currency marker or currency word always goes back to the supplier: nothing is stripped or converted.
- **AI suggestions** are OFF. The C3 repair-suggestion feature has no live provider enabled; environment variables cannot turn it on. This is separate from the optional advisory explanation described above. The adapter takes an injected provider, has a 15 s timeout, a 16 KB answer cap and the same advisory budget as the explanation.
- Every model answer must match a strict JSON schema. A deterministic checker refuses values for currency cells, ambiguous split lines, empty cells, keys and duplicates; when the cell has digits, only the rule-based reading is allowed; a word reading is allowed only for short cells and is flagged for the person. Supplier text is sent as data and is never followed as instructions. Model text never reaches the supplier.
- C3a: a built request is shown only while its order, lot, delivery revision, decisions and language are unchanged; accepted values are written complete on their own line (received values are labelled previews); an AI answer that arrives after the delivery changed is discarded; provider errors reach the store and the view only as fixed public codes.
- Evaluation: `fixtures/C3` holds two development lots and two reserved lots with one label per finding, frozen with sha256 in `MANIFEST.json` before any model output existed. `npm run eval:c3` scores B1 and, if given recorded answers, the model before and after the checker. No result of the model is claimed here.

## Persistence and webhooks (sandbox mode)

- Orders, request ids, payload hashes, in-flight intents, the advisory counter and processed webhook ids are kept in `DATA_DIR/orders.json`, written atomically (temp file, fsync, rename). The store takes an exclusive lock file with the owner pid: a second process on the same `DATA_DIR` fails at startup, so two processes cannot send the same request. Takeover is fail-closed: only a lock holding a valid pid of a process the OS reports as gone (ESRCH) is removed; an empty, invalid or ambiguous lock keeps the store locked until a person removes it. A test kills a real process with SIGKILL during a capture and checks that the next one restores the order as UNCERTAIN(capture) and sends nothing.
- `POST /webhooks/paypal` (sandbox mode with `PAYPAL_WEBHOOK_ID`) verifies the PayPal signature with the documented self-verification (transmission id, time, webhook id and CRC32 of the raw body, SHA256withRSA against the certificate from an https paypal.com URL). An event is matched only through an id it actually carries (authorization id for captures, resource id for authorizations) and that is known locally; captures also need their capture id and the exact amount and currency. Anything less marks the order for GET reconciliation and changes nothing. Applied events are deduplicated by event id and only move forward; an event cannot settle an UNCERTAIN order unless it is the outcome of that operation.
- Fixture mode keeps everything in memory and says so on screen.

## PayPal references (read 8 Nov 2026)

- Orders v2 authorize: https://developer.paypal.com/api/orders/v2/orders-authorize
- Capture an authorization (`final_capture`): https://developer.paypal.com/api/payments/v2/authorizations-capture
- Authorization honor period and 29-day validity: https://developer.paypal.com/docs/checkout/advanced/authorization-honor/
- Idempotency (`PayPal-Request-Id`): https://developer.paypal.com/api/rest/reference/idempotency/
- Webhook signature verification: https://developer.paypal.com/api/rest/webhooks/rest/
- Webhook event names: https://developer.paypal.com/api/rest/webhooks/event-names/

## Not done yet

Real end-to-end Sandbox order/approval/authorization/capture/webhook evidence, real advisory evaluation and the demonstration video are still pending. Existing CI run 42974702939 qualified product 51a653a with 109 unit tests, C3a Chromium and all seven U1 browser scenarios; it does not qualify this later advisory source or prove real provider calls. Credentials are private server configuration, never in this repository. A hosted demo is optional; local fixture instructions are above. Webhook postback verification through `verify-webhook-signature` is not used; self-verification is.

## License

MIT
