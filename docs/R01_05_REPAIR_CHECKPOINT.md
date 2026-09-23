# R01 repair checkpoint — 22 September 2026

The five findings in R01_04_CODE_AUDIT.md have local implementation changes and focused verification. Live Devnet QA is still pending. This is a manual test candidate, not a claim that the entire product or a public SDK release is finished.

## Changes

- Wallet transfer previews track outstanding preparations and decision ownership. An obsolete result cannot cancel the decision owned by the current review or a signed send. Replacement waits for already-started cancellations before requesting new authority.
- Evidence delivery handles wakeups during a running drain. New arrivals receive another immediate pass; failed old entries are attempted once per cycle instead of spinning.
- Dapp transactions and messages retain signed outputs in an explicit completion state. A persistence error shows **Retry saving signature**, which retries delivery without asking the vault to sign again. Popup closure cannot turn this into an unsigned cancellation.
- Wallet sends retain the exact signed transaction on a save failure, prevent another preview/send, and expose the same save retry in the popup, including reopening the popup while the worker remains alive. Activity recovery now restores exact evidence before broadcasting a saved wallet-owned transaction. Dapp-owned transactions are never broadcast by Activity recovery.
- Current coverage is fetched from the server for each approval and refreshed independently of payment, decision, lineage and claim history. Missing history is retained as cached display data and marked separately; it cannot replace fresh coverage/allowance authority.
- Backend accepted-evidence retries compare the immutable artifact's byte hash and, for messages, signature. Conflicting bytes/kinds return a conflict without changing accepted evidence or allowance. Identical retries still succeed after expiry.

No SDK source or wire schema changed; the wallet remains bound to the original immutable beta.3 artifact. Beta.2 was not touched. The demo baseline was not changed.

## Verification actually run

A subsequent full test pass is recorded in [R01_06_FINAL_TEST_PASS.md](R01_06_FINAL_TEST_PASS.md). The results below describe the earlier focused repair pass.

- 116 distinct affected wallet tests across six files passed: an initial 113-test run, then the four changed files were rerun after three more regressions and the Activity ordering assertion were added (70 tests in that final affected run). No unchanged whole-wallet suite was repeated.
- Wallet TypeScript check passed after the final source changes.
- 19 backend decision/evidence tests passed against a disposable PostgreSQL 16 database. This includes transaction/message changed-evidence rejection, exact retries after expiry, cancellation races, allowance accounting and worker paths. The temporary container was removed.
- Strict backend Clippy for all workspace targets/features, rustfmt check, and OpenAPI generation check passed.
- Backend embedded SDK generate:check passed for both wallet and partner contracts, covering the previously missed CI target.
- build:qa-candidate and its strict SDK/artifact/extension verifier passed. Output: .output/qa-candidate/chrome-mv3. File/source hashes: R01_05_BUILD_MANIFEST.json.
- No live transaction was signed or broadcast, no remote CI result is claimed, and no deployment, database reset, commit, push or publication was performed in this repair turn. The installed .output/chrome-mv3 was not rebuilt.

## Manual QA checkpoint

First deploy the repaired backend through the existing user-controlled push/deployment process. The earlier backend cutover prerequisites remain applicable; old readiness claims do not. The new backend change is currently uncommitted in crates/ember-api/src/decisions.rs. Wallet repair source is also uncommitted.

After deploying, promote/reload the repaired wallet using the existing QA build procedure. Keep the existing vault and the unchanged localhost:5173 demo.

1. Run the known and first-time funded SOL scenarios. For eligible covered decisions, verify approval completes, the expected recipient/amount confirms and allowance commits once.
2. Replace a wallet send preview rapidly, including identical details. The final review must remain usable; cancelling the final review releases only its unused reservation.
3. Repeat the existing evidence/cover retry scenarios. Verify no duplicate committed allowance and no signature is created again merely to retry saving/delivery.
4. Reconnect after the fresh QA database cutover while retaining old wallet history. Fresh active coverage/allowance must load despite missing old payment/decision records.
5. For a controlled storage failure in a developer QA session, verify **Retry saving signature** for transaction/message approvals and wallet sends. Recover storage, retry, and verify the signer was used once. Keep this fault injection outside the baseline demo code. The automated regressions already exercise these failures with isolated mocks.

## Recovery boundary

Before any durable storage write succeeds, a pending signed output is retained in the running service worker. Reopening the popup is supported; terminating that worker or browser during a total storage failure is not a demonstrated durable-recovery path. Do not claim otherwise. After evidence is durably queued, the existing outbox can retry across worker restarts; a persisted wallet-owned transaction can also be recovered through Activity. Live browser suspension/restart behaviour remains part of manual validation.

Do not extend the 60-second evidence acceptance deadline, alter cover policy, or overwrite the reviewed SDK artifact to make a scenario pass.
