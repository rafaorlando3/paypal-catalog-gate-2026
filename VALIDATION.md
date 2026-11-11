# Catalog Gate — qualification record

Functional product: `e7955eda8e9413224a6b7541be40e5ede4638a57`  
Tree: `1ccf561d97bb360915ac97434465672dfc5f8351`  
56 product files, 376269 bytes. The final README and this record document that immutable product; they do not change its executable source.

## Offline checks

[Run 42984498276](https://github.com/rafaorlando3/paypal-catalog-gate-2026/actions/runs/42984498276), first attempt: 111 unit tests passed, no failures or skips, C3a Chromium regression passed and all seven out-of-order response scenarios passed. The 56 product files matched before and after the run, and the owned container closed before the source audit.

## Controlled real PayPal Sandbox scenario — 11 November 2026

All amounts are test money. A virtual US seller and an existing Sandbox Personal buyer were used. The buyer personally approved order `1NX72963D40808825`; authorization `1EH876029E252802B` was created. A signed authorization-created webhook was verified.

The deterministic report accepted 200 of 200 rows, with a minimum of 196, no rejected rows, no duplicate SKUs and 10 matching sample rows. Canonical report SHA256: `2dbee90f17c3f839ac610e6fbe9863b3c864244e168da29a8ff595d580d9820c`.

The exact human report acceptance was recorded after the first runtime had closed. A separately authorized runtime window adopted that acceptance and restored the same order and financial journal byte for byte. No create, authorize or delivery POST was repeated. One full capture was sent at 23:03:25–26 UTC:

- Capture: `7YK28292045248338`.
- PayPal GET: `COMPLETED`, USD 50.00, `final_capture: true`.
- Signed event: `WH-1PL052928A4639510-49N404522P1527148`, `PAYMENT.CAPTURE.COMPLETED`.
- The signature and raw-body hash were verified privately, and the event matched that same capture, authorization, amount and final-capture flag. Raw bodies, signature headers and credentials are not published.
- The application was already CAPTURED from the synchronous response. The verified webhook was recorded as backwards and did not cause another state transition.

The server ended at 23:04:13 UTC with exit 0 and no OOM. Independent readback at 23:05:32 confirmed PIDs 0, unit collected, container and own markers/lock absent, owned webhook deleted with GET confirmation, temporary credentials removed, and all 13 original Caddy routes unchanged. All 56 product files and runtime/helper pins still matched. The original journal remained untouched.

An earlier checkout attempt stopped without authorization or capture; its cause was not established. One successful Sandbox scenario does not establish production reliability or real-money operation.

## Real AI sample and limits

Gemini 3.5 Flash-Lite produced one useful recorded explanation with correct citations to lines 46, 121 and 178. A second call timed out after 15 seconds, the third was not attempted, and no call was retried. The answer used imprecise yellow-status wording and suggested updating the file before proceeding; human acceptance remains a separate gate. This is not a successful three-case evaluation or a broad accuracy/reliability claim. AI repair suggestions remain off. Payment decisions stay outside the model.

## Demonstration

[English video](https://www.youtube.com/watch?v=6uQO66Sukck), 134 seconds. Original WebM SHA256: `e268f3ca884c59497c5fc377782bc188bbd17e4b1672cf6205a2a75a89eba4f5`.

[Video run 43117933633](https://github.com/rafaorlando3/paypal-catalog-gate-2026/actions/runs/43117933633), first attempt, succeeded on candidate `b8b4432d3d8fa2284f2d3f6f6f4748cf9dc839a8`. Product files matched before and after recording; the network-isolated recording container exited with 0, PID 0, no OOM, and was removed before media export. No PayPal or Gemini calls and no credentials were used by the recording job. The video separates offline fixture interaction (simulated PayPal) from the stored real AI response and real Sandbox receipts. Its description explicitly labels the complete application segment as simulated.

## Run and review

Use Node.js 22 or later. `npm test`, then `npm start`; open `http://localhost:8787`. Fixture mode is labeled and requires no credentials. Optional Sandbox and real AI modes require the judge's own private configuration; there is no real-money mode. The MIT license is in `LICENSE`. Authorize/capture is not escrow.
