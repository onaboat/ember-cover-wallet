# R01 correctness audit — 22 September 2026

Status: audit findings were implemented and locally verified in the subsequent repair turn. See [R01_05_REPAIR_CHECKPOINT.md](R01_05_REPAIR_CHECKPOINT.md) for exact evidence, recovery limits and the pending Manual QA checkpoint. The original audit below records the defects found; it is not the current implementation status.

Reviewed: wallet 84d72e7, standalone SDK 236dd39, backend 9e2f7a2. Focus: review ownership, cancellation, signed-evidence persistence/delivery/retries, and current-coverage discovery. This is a targeted correctness audit, not an exhaustive security assessment or a claim that every defect is known.

## Confirmed findings

### 1. P1 — an obsolete preview can cancel the current review's decision

Wallet: src/background/sol-transfer-service.ts:535–550. Backend: crates/ember-api/src/decisions.rs:644–653 and 710–745.

The backend deduplicates identical signable bytes under the same coverage into one decision. The wallet cancels the prior decision when replacing a preview, and also cancels any decision returned by a superseded asynchronous preview. It does not check whether the current review owns that same decision ID.

Witness: hold the first preSign response; complete a second preview for identical bytes with the same backend decision ID; release the first response. The stale completion calls cancelReview on the current covered decision. A cancellation accepted before signed evidence invalidates that decision, while the current wallet review still displays covered. This is an inter-component ownership error.

Expected repair: explicitly coordinate local review ownership with server decision identity. Late results must not cancel a decision used by a current review or signing operation. Do not weaken backend atomic cancellation/evidence rules. Acceptance: identical-byte overlapping previews, different-byte previews and cancellation/evidence races preserve current authority and reserve/commit once.

### 2. P1 — new signed evidence can miss its delivery deadline inside the wallet

Wallet: src/background/evidence-outbox.ts:77–86 and 120–126; src/background/cover-service.ts:265–281. Backend TTL: crates/ember-core/src/lib.rs:8.

Each drain snapshots the queue once. A concurrent drain call returns the already running promise. Evidence enqueued during that upload survives storage mutation, but neither drain attempts it. Without another trigger, it waits for the one-minute alarm. The decision expires 60 seconds after review issuance, before which first evidence must reach the backend. Consequently even healthy delivery can be delayed beyond the remaining approval deadline.

Witness: enqueue old evidence, block its upload, enqueue new evidence and call drain, then finish the old upload. Only the old evidence is submitted; the new entry remains queued.

Expected repair: make queue wakeups part of the delivery state machine, so work arriving during a drain receives a prompt attempt; avoid tight retry loops for failed/terminal entries. Keep exact bytes and the approved backend expiry contract. Acceptance: overlapping arrivals are delivered without waiting for the recovery alarm, failures remain recoverable and accepted evidence is not double-counted.

### 3. P1 — storage failure after dapp signing strands the request

Wallet: src/background/request-service.ts:505–579 and 591; analogous message path:403–438. Evidence persistence: src/background/cover-service.ts:265–281.

After custody signs, the service marks signing started and retains the signed output only in a local variable. If postSign's durable outbox write rejects, the dapp promise is neither resolved nor rejected, the pending slot is not cleared, and approve/cancel/new requests are blocked. Closing the popup is ignored once signing starts. The dapp Activity record contains metadata, not recoverable signed transaction bytes.

Witness: inject a postSign storage failure after a successful signature. The first approve rejects; signingStarted remains true; the original dapp promise remains unsettled; cancel, another approval and another request are rejected. No second signature was produced.

Expected repair: explicit signed-but-persistence-pending state retaining exact outputs and a defined recovery path, including the service-worker lifecycle. Never solve this by signing again or reporting unsigned cancellation. Acceptance: persistence failure after signing has an actionable, non-duplicating recovery path and cannot permanently lock the request service. The built-in send's post-sign storage boundary should be covered in the same repair review.

### 4. P2 — stale history prevents discovery of current coverage

Wallet: src/background/ember-lifecycle-store.ts:147–163 and 205–242; src/background/cover-service.ts:336–377.

Full refresh reads a cached payment before current coverage, then requires all historical decision/lineage reads and claims to succeed. A missing old payment prevents current-coverage discovery altogether; any later history failure discards the fresh result. Meanwhile decision lookup accepts a locally active cached coverage ID and the provider does not invalidate/re-discover it when the server rejects that stale authority.

Witness: retain old locally active coverage/payment, return payment-not-found while a fresh current-coverage endpoint is available. Refresh returns cached authority without calling current coverage; subsequent decision lookup reuses the old coverage ID. This is directly relevant to the proposed fresh QA database cutover while retaining wallet storage.

Expected repair: current coverage and allowance refresh independently of historical records. Handle stale references explicitly and use bounded re-discovery for invalid coverage authority. Preserve keys and do not require clearing the vault. Acceptance: a fresh backend with retained old wallet history discovers the new active coverage and permits a new review; missing history remains a history issue.

### 5. P2 — backend treats conflicting evidence retries as accepted

Backend: crates/ember-api/src/decisions.rs:1860–1881.

For post_sign/confirmation/sealed decisions the handler returns accepted:true before examining the request's signed bytes or matching its evidence kind. Thus a different syntactically valid body can receive the acceptance response for earlier evidence. The original evidence is not overwritten and this branch does not charge twice; the defect is false confirmation of the submitted retry. The SDK's decision-ID check cannot detect this semantic mismatch.

Confirmed by control-flow inspection; not database-reproduced in this audit. Git blame shows this predates R01, but it belongs in the evidence contract review that was previously missed.

Expected repair: validate retries against the accepted evidence identity; identical retries remain accepted after expiry, conflicting retries return a conflict without altering the accepted artifact or allowance. Acceptance: unchanged evidence after expiry succeeds; different bytes/kind do not receive accepted:true.

## Why the previous checks were insufficient

The initial verification missed the backend's embedded SDK and CI-specific OpenAPI allowlist. Those CI defects were subsequently fixed. More significantly, isolated mocks did not model shared backend decision identity or the time constraint on evidence delivery. An existing outbox test explicitly accepts the stranded-new-entry outcome, and the replacement-review test counts cancellation calls without representing backend state. Test totals were used as stronger readiness evidence than they warranted.

## Evidence and scope

Four temporary wallet witness tests ran once: 4 passed in 825ms, meaning all four undesirable behaviours reproduced. Witnesses and rerun instructions are archived at /private/tmp/ember-r01-audit-20260922. They were removed from the regular test directory because tests asserting broken behaviour must not become the product's regression contract. No complete suite was rerun in this audit. Backend finding 5 is inspection evidence only.

No product source, demo baseline, SDK artifact, deployment or database was changed during this audit. No commit or push was made. Only this report and the manual-QA readiness correction were added/edited.

## Proposed repair sequence

1. Repair review ownership and the signed-evidence lifecycle together across wallet/backend/SDK boundaries (findings 1, 2, 3, 5). Preserve single signing, exact evidence, atomic first-accepted semantics and expiry. Add focused tests of the expected behaviour, not mock call counts.
2. Repair current-coverage discovery independently of historical cache health (finding 4), then validate retained wallet storage against the fresh QA backend.
3. At the coherent code checkpoint run affected checks once, plus the inexpensive formatting/generated-contract gates for changed repositories. Use the backend CI workflow to identify targets, including the embedded SDK. Do not repeat an unchanged full suite per small edit.
4. Produce a new immutable SDK candidate only if its source/contract changes; preserve beta.2 and beta.3 artifacts. Rebuild the wallet candidate after fixes, then run the unchanged baseline Manual QA and record actual results before moving to Android.

The user subsequently instructed implementation; the repair checkpoint above records the completed local changes. No decision has been made to extend expiry, alter coverage policy, change the baseline dapp, or bypass evidence persistence.
