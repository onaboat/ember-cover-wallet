# Quote-bound coverage payment

The reference wallet has no fixed local price, treasury, plan, duration, or
payment mint. Those facts come from an Ember offer and a verified signed quote.

The user:

1. connects a short-lived secretless Ember session;
2. selects a current offer;
3. accepts the exact offer/version, terms version, and terms SHA-256;
4. reviews a verified quote and a simulated payment;
5. explicitly approves signing; and
6. sees server-authoritative payment and coverage state.

For a live payment the wallet verifies:

- production environment and `mainnet-beta`;
- canonical Mainnet genesis hash from both the quote and RPC;
- protected wallet and payer;
- quote signature, signing key, hash, and expiry through the SDK;
- classic SPL Token program;
- exact mint, decimals, amount, treasury account, treasury owner; and
- one exact quote reference as a static read-only non-signer account.

The transaction is a `TransferChecked`; it creates no delegate or recurring
spending authority. It is simulated immediately before signing. Signed bytes,
signature, quote, and blockhash are stored before broadcast. Recovery reuses
that exact signed transaction and never asks the user to pay twice while it can
still land.

Sandbox quotes are useful for integration testing but are non-payable and
cannot create coverage.
