# R01 SDK/Chrome candidate — 22 September 2026

Local implementation and automated integration are complete for this slice.
Live Manual QA is pending the Devnet backend cutover. This is not a public SDK
release, underwriting certification, or Android implementation completion.

## Delivered

- Exact beta.3 SDK artifact and backend commit provenance.
- Server current-coverage discovery without local payment references.
- Available transaction count from live server allowance, not old review snapshots.
- Unsigned cancellation releases the reservation. Cancellation failures do not
  claim a refund: the backend releases the slot at expiry if offline.
- Signing disables cancellation. Closing approval UI after signing starts does
  not abandon evidence or return cancellation to the dapp.
- Exact signed evidence is persisted before dapp results/broadcast and retried
  without signing again. Concurrent uploads cannot erase newly queued evidence.
- Four decision outcomes remain distinct; a coverage-read outage is unavailable,
  not an invented refusal. Invalid or expired transaction bytes remain blocked.

## Evidence

269 tests / 48 files passed, plus one focused signer-failure cleanup check after final boundary review. Typecheck passed. Twelve packaged Chromium journeys
passed across the initial run and two affected coverage reruns. These are isolated
fixture journeys, not live-network evidence. The candidate Devnet build and QA
artifact verifier passed; see R01_03_BUILD_MANIFEST.json for per-file hashes.
SDK contract/provenance, beta release policy, bundle boundary and secret scan
checks passed during packaging. Beta.2's original verified artifact was preserved;
a mistakenly named intermediate package was withdrawn to a temporary location,
never installed or published. The packer now refuses to overwrite a candidate.

## Required backend handoff (user pushes)

Backend repository: `../backend`, branch `codex/r01-approval-reliability`.
Required contract commit: `418bc944c60ec317e5e48eb826061b5f3e3affa8`.
The hosted `https://ember-devnet-qa.up.railway.app/v1/wallet-openapi.json`
was read during this work and still exposes the previous contract.

1. Push the backend branch and select that revision for the existing isolated
   Devnet QA service. Do not point production at this candidate.
2. Use a fresh empty PostgreSQL database for that QA service. Existing test data
   was approved for disposal, but no database was reset by this work. Migration
   0024 intentionally rejects old decision rows instead of converting counters.
3. Keep `/railway.devnet.toml`, `Dockerfile.devnet`, the existing QA secrets and
   sandbox configuration. Its pre-deploy `ember-api seed-devnet-qa` migrates and
   seeds the fresh database. Keep exactly one worker-owning QA replica.
4. Verify `/v1/ready` succeeds and the wallet OpenAPI contains
   `/v1/coverage-instances/current`, `/v1/decisions/{decisionId}/cancel`, and
   `CoverageDecisionResponse.allowance`.
5. Only then run `bun run build:qa` from the wallet repository to update the
   existing `.output/chrome-mv3`, and Reload the existing extension in Chrome.
   Reconnect and activate Devnet test cover against the new
   database. Do not delete the extension/vault or reset the wallet; database
   cutover does not require changing wallet keys or the wallet's SOL balance.

## Manual QA — unchanged localhost:5173 baseline

- Known and first-time SOL transfer: review valid, funded transactions; approve
  once; verify network confirmation, exact recipient/amount, and one committed
  allowance slot. Do not assume every valid transaction is policy eligible.
- Open a covered review and cancel before signing: available slot returns after
  the server accepts cancellation; transaction is not sent.
- Leave a covered review to expire: slot becomes available again, old review
  cannot sign, and a new dapp request reviews fresh transaction bytes.
- Retry cover/evidence: no duplicate reservation or committed charge. Outage
  shows unavailable; retrying evidence never asks the vault to sign again.
- Start signing then close approval UI: approved operation finishes and evidence
  remains recoverable; it is not treated as unsigned cancellation.
- Restart/reconnect without saved payment references: active cover and current
  allowance are discovered from the backend.

After these pass, record the live results and proceed to Android foundations.
The demo code, registry tags, production deployment and current installed Chrome
output were not changed. No pushes or publication were performed.
