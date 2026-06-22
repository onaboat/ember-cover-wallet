# Ember Cover Solana Subscription API Requirements

The extension activates cover only after an onchain Solana subscription is confirmed and the Ember API recognizes that subscription as an active entitlement. Local extension state is only a UX cache.

## Onchain Inputs

The API must be configured with the same allowlist as the extension:

- Solana Subscriptions Program: `De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`
- USDC mint per cluster
- Ember merchant wallet
- approved puller wallet
- Core / Plus / Max plan IDs and derived plan PDAs
- billing period per plan
- expected amount in USDC base units
- cover cap and covered transaction allowance per plan

## Entitlement Activation

Add an API handoff endpoint after wallet registration, or extend registration to accept subscription evidence:

`POST /entitlements/subscriptions/activate`

Request body:

```json
{
  "walletAddress": "subscriber wallet",
  "cluster": "devnet",
  "planTier": "core",
  "billingPeriod": "monthly",
  "programId": "De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44",
  "paymentMint": "USDC mint",
  "merchantWallet": "Ember merchant",
  "pullerWallet": "approved puller",
  "planId": "1",
  "planPda": "plan PDA",
  "subscriptionAuthorityPda": "authority PDA",
  "subscriptionPda": "subscription PDA",
  "setupSignature": "optional ATA/authority setup signature",
  "subscriptionSignature": "subscribe transaction signature"
}
```

API validation:

- Verify the subscribe transaction is confirmed on the declared cluster.
- Verify the subscription PDA is derived from the submitted plan PDA and wallet.
- Verify the plan PDA is derived from the configured Ember merchant and plan ID.
- Fetch and decode the plan account.
- Verify mint, amount, period, merchant, destination, and puller allowlist match the configured plan.
- Fetch and decode the subscription account.
- Verify subscriber, plan, token mint, active/cancel status, current period, and expiry.
- Reject if the subscription is cancelled, expired, wrong mint, wrong puller, wrong merchant, wrong plan, or below the required amount.

Response body:

```json
{
  "entitlementId": "ent_sub_...",
  "walletAddress": "subscriber wallet",
  "subscriptionStatus": "active",
  "planTier": "core",
  "billingPeriod": "monthly",
  "currentPeriodEnd": "2026-07-19T00:00:00Z",
  "coverCapUsd": 10000,
  "coveredTxAllowance": 100,
  "remainingLossCapUsd": 10000,
  "remainingCoveredTxThisMonth": 100
}
```

## Wallet Registration

Keep the existing nonce flow:

- `POST /wallets/register/nonce`
- `POST /wallets/register`

Registration should link the wallet to the active subscription entitlement. A wallet signature alone must not activate cover.

## Cover Status

`POST /cover/status` must return subscription-backed entitlement state:

```json
{
  "subscriptionActive": true,
  "subscriptionStatus": "active",
  "walletRegistered": true,
  "tier": "core",
  "billingPeriod": "monthly",
  "currentPeriodEnd": "2026-07-19T00:00:00Z",
  "coveredTxPerMonth": 100,
  "usedCoveredTxThisMonth": 0,
  "remainingCoveredTxThisMonth": 100,
  "monthlyLossCapUsd": 10000,
  "usedLossCapUsd": 0,
  "remainingLossCapUsd": 10000,
  "lastCoveredTransaction": null
}
```

Pre-sign cover decisions must continue to come from the API. The extension must not self-attest that cover is active.

## Subscription Management

API should expose entitlement effects for:

- active
- past due / collection failed
- cancelled but not revoked
- revoked
- plan changed
- wallet removed or re-registered

If a pull fails, `/cover/pre-sign` should return `not_covered` or `unavailable` with a public wallet-safe reason category, while keeping internal risk/collection details private.
