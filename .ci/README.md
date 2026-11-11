# PayPal Catalog Gate — Offline CI Qualification Overlay (`tarefa230`)

## Status & Authorization Notice

- **State:** `HUMAN_AUTHORIZED_CI0_PUBLIC_STANDARD_LINUX_20261111`
- **Product Candidate Commit:** `e0b68f2d7ab6f100e38d1bc1cbea616d32bef16d`
- **Product Tree:** `2621636020b9e7f80b4a6293b458a0e8a81aae5e` (55 tracked blobs, 363,354 bytes)
- **Scope:** Authorized offline CI qualification for offline unit + real Chromium E2E qualification in `MODE=fixture`. No real PayPal Sandbox REST call, no AI provider call (`GEMINI_API_KEY` absent), no live money, and no artifact/cache upload.

## Architecture & Separation from Product

The 55 product blobs are never modified. Only the following 5 CI overlay paths exist outside the product tree:

1. `.github/workflows/qualify-paypal-offline.yml` — Manual `workflow_dispatch` job on `ubuntu-24.04` (15-minute job cap, `contents: read`, `persist-credentials: false`).
2. `.ci/pins.json` — Immutable manifest of all 55 product blobs (mode `100644`, Git blob SHA-1, SHA-256, byte size), pinned Playwright container digest (`linux/amd64`), and SRI `sha512` hashes for `playwright@1.64.1` and `playwright-core@1.64.1`.
3. `.ci/qualify.py` — Linux-only host harness enforcing stage budgets (`45s + 120s + 15s + 90s + 90s + 90s + 30s = 480s` plus `120s` closure reserve = `600s` total):
   - Materializes the 55 blobs directly from Git objects (`git ls-tree` / `git cat-file blob`) into an isolated `product/` directory and verifies SHA-1, SHA-256, and total byte count (`363354`) before and after container execution.
   - Downloads only the 2 pinned NPM tarballs (`playwright` and `playwright-core`), verifies `sha512` SRI before reading the tar stream, and extracts with strict member/size/path guards into `vendor/node_modules/`.
   - Creates a single container `cg-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}` with `--network none`, `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, and `:ro` bind mounts for `/product`, `/ci`, and `/vendor`.
   - Captures `docker inspect` before start and after `docker wait`, removes the owned container before post-audit, and prints the SHA-256-framed JSON qualification report to stdout.
4. `.ci/inside.mjs` — In-container runner invoked under `/usr/bin/env -i` with a minimal allowlist:
   - Verifies Node `>=22`, resolves `playwright` and `playwright-core` via `NODE_PATH=/vendor/node_modules`, records the configured Chromium executable SHA-256 and version, and confirms `--network none` isolation via interface inspection and failed external numeric TCP probes (`1.1.1.1:443`, `8.8.8.8:53`).
   - Runs the 11 unit test files (`node --test --test-reporter=tap test/*.test.mjs`) and parses actual TAP counts (`passed > 0`, `failed = cancelled = skipped = todo = 0`).
   - Runs `test/e2e/c3a-pedido-vinculo.e2e.cjs` and `test/e2e/c3au1-respostas-atrasadas.e2e.cjs` sequentially, each against its own fresh `src/servidor.mjs` process (`MODE=fixture`, `PORT=8799`, isolated `DATA_DIR`), waiting for loopback readiness and verifying clean `SIGTERM` (`exit 0`) shutdown before proceeding.
5. `.ci/README.md` — This documentation file.
