# Cover and claims authority after P14

The Ember server is the source of truth for payment, coverage, signing
decisions, evidence, and claims.

The wallet keeps a bounded activity index so it can match an on-chain signature
to an Ember `decisionId`. That local record is display and recovery data only:
it is wipeable, bounded, and may be stale.

`EmberLifecycleStore.refresh` resolves stored identifiers through the packaged
SDK:

- `getPayment`;
- `getCoverageInstance`;
- `getDecision`;
- `getDecisionLineage`; and
- `listClaims`.

The resulting view is labeled:

- `server` when every displayed lifecycle fact was refreshed;
- `cache` when local display data exists but refresh failed; or
- `unavailable` when neither source can provide a useful view.

Post-sign evidence is no longer fire-and-forget. The wallet persists the exact
SDK evidence request before returning signed bytes to a dapp or before its own
first broadcast. A service-worker alarm retries the outbox and removes an item
only after the server accepts it.

Claim intake starts from the authoritative decision ID:

1. call `claimEligibility(decisionId)`;
2. show the server reason and deadline;
3. collect the loss amount and statement; and
4. call `createClaim`.

Submitting a claim does not approve or broadcast a payout. Human review and the
manual payout controls remain separate backend responsibilities.
