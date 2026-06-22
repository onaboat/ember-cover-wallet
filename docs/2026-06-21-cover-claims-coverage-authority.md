# Cover claims: where coverage truth lives

Captured 2026-06-21, after adding the per-transaction cover-status indicator to the
wallet Activity feed. Records the distinction between what the wallet shows and what
a future claims flow can actually rely on, plus the gaps to close first.

## TL;DR

The wallet's local cover records are a **display convenience only**. The **authoritative
record for claims is the engine's cover decision**, identified by `requestId`. Do not let
claim adjudication depend on the wallet's local records as they exist today.

## What the wallet stores (display-only)

`src/background/cover-records.ts` (`local:ember-cover-records`) persists one record per
signed transaction — `{ signature, walletAddress, coverStatus, riskBand, requestId,
dappOrigin, recordedAt }` — written in `RequestService.approveSignTransaction` (dapp sends)
and `WalletTransferProvider.sendSolTransfer` (in-wallet sends), keyed by the on-chain
signature (`getSignatureFromTransaction`). `getSnapshot` surfaces them so the Activity row
shows a Covered / Not-covered pill.

Properties that disqualify it as a claim source of truth:
- **device-local** and **wipeable** (reinstall / clear storage loses it),
- **capped at 50 globally** (`MAX_COVER_RECORDS`) — can evict a still-claimable tx,
- written at **sign time**, not broadcast time.

## What the engine stores (authoritative)

In `ember` (`crates/ember-api`):
- **Pre-sign** (`routes/presign.rs`, `insert_decision_consuming`): records the cover
  DECISION keyed by `requestId`, tied to the subscription/entitlement and the reviewed tx
  (message hash), consuming a monthly covered-tx slot. Exists even if post-sign never lands.
- **Post-sign** (`routes/postsign.rs`): attaches the REQUIRED evidence to that decision —
  `signedBytes` + `signature` (`presign.rs` `required_post_sign_evidence`), matched by
  message hash.
- **Claims** (`routes/claims.rs`): filed by `requestId` →
  `get_decision_for_partner(requestId)` → `record_is_claim_eligible` + `subscription_active`,
  within `CLAIM_WINDOW_DAYS = 21`. Loss is described by `lossSignature`, `lossOccurredAt`,
  `claimedAmountUsd`, `explanation`, `causalEvidence`.

So a claim is adjudicated entirely server-side; the client only needs to know the
`requestId` (and signature) of the covered tx to initiate one.

## Gaps to close before claims are real

1. **Post-sign delivery is best-effort, fire-and-forget** (`request-service.ts` `void
   postSign`; `sol-transfer-service.ts` `.catch(() => {})`). If it fails (network / SW
   eviction), the engine decision lacks its required evidence and the claim is likely
   ineligible even though the UI showed "Covered". Needs reliable delivery (retry / durable
   queue + SW-restart resume).
2. **The wallet must retain the `requestId` ↔ signature link for ≥ the 21-day claim window.**
   Today the only client-side carrier is the display record, which is capped/wipeable.
   Either keep covered records durable for the window (don't evict covered ones at 50), or
   have the engine expose the user's claimable decisions so the wallet need not depend on
   local state.
3. **Sign-without-broadcast.** A dapp-signed tx that is never broadcast still records a cover
   decision (engine, at pre-sign) and a local record; the local one sits under "Pending cover
   records" indefinitely. Product decision: define when an unbroadcast decision expires /
   how it is reconciled.

## Recommendation

When claims work begins, treat the engine decision (`requestId`) as the single source of
truth, make post-sign evidence delivery reliable, and have the wallet fetch claimable
decisions from the engine rather than trusting local records for anything claim-bearing.
