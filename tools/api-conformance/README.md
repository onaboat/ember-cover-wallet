# Ember API conformance external signer fixture

This fixture lets the SDK repository's real-API conformance runner use the
operator's configured external Wallet Standard wallet without exposing a seed
phrase, private key, or wallet password to Node. The Node artifact prepares and
simulates exact Devnet transactions. A token-protected loopback page asks the
operator to connect the configured wallet and explicitly continue each Wallet
Standard approval.

The production Ember wallet is deliberately rejected as the SDK runner's
signer. Ember owns its own session, cover decision, approval, signing,
broadcast and evidence use case. Letting the SDK runner create a decision and
then asking Ember to create another decision for the same bytes would violate
the single-decision-owner invariant. There is no conformance bypass, trusted
dapp flag, or mode that disables Ember's cover checks.

This is a Devnet QA tool. It does not certify Mainnet, HTTPS-wallet CORS,
Android, or Solana-phone behavior.

## Safety boundary

- The fixture accepts only the SDK runner's `sandbox` environment.
- The configured signer must be an external Wallet Standard wallet. The
  production Ember wallet is rejected before network access.
- The RPC must be HTTPS or exact loopback HTTP and its genesis hash must be
  Solana Devnet.
- The controlled transaction is a configured SOL transfer capped at 100,000
  lamports, in addition to the server-quoted 1 Devnet USDC coverage payment.
- Both transactions must simulate successfully before the operator can
  continue to the wallet approval.
- The signed transaction message must exactly match the reviewed unsigned
  message. The RPC signature must match the signed transaction.
- The loopback bridge binds one wallet for one run, allows one pending request,
  times out without retrying, and never approves automatically.
- Do not use a production wallet. Do not put credentials, seed phrases,
  private keys, extension passwords, or session files in environment values or
  this repository.

## Build

From this wallet repository:

```sh
npm run build:conformance-fixture
```

The ignored output is:

```text
tools/api-conformance/dist/ember-conformance-wallet.mjs
tools/api-conformance/dist/operator.js
```

## Configure and run

Choose a funded Devnet-only account in an external Wallet Standard wallet and a
controlled Devnet recipient. The account needs at least 1 Devnet USDC plus
enough Devnet SOL for the payment and the controlled transfer. SDK conformance
creates cover for this dedicated account; it is separate from Chrome product
conformance for the Ember wallet.

In the SDK repository, set its documented conformance variables plus these
fixture-owned values:

```sh
export EMBER_CONFORMANCE_FIXTURE_MODULE=/absolute/path/to/wallet/tools/api-conformance/dist/ember-conformance-wallet.mjs
export EMBER_CONFORMANCE_RPC_URL=https://api.devnet.solana.com
export EMBER_CONFORMANCE_SIGNER_WALLET_NAME=REPLACE_WITH_EXTERNAL_WALLET_STANDARD_NAME
export EMBER_CONFORMANCE_RECIPIENT=REPLACE_WITH_CONTROLLED_DEVNET_RECIPIENT
export EMBER_CONFORMANCE_TRANSFER_LAMPORTS=5000
export EMBER_CONFORMANCE_TRANSACTION_APPROVAL=I_APPROVE_DEVNET_TRANSACTIONS
```

Then run:

```sh
npm run conformance:api
```

The runner prints a tokenized `http://127.0.0.1` operator URL. Open that exact
URL in the Chrome profile where the configured external Wallet Standard wallet
is installed, connect the dedicated QA account, and inspect every message and
transaction before continuing to the wallet's own approval screen.

The quoted 1 Devnet USDC transaction is a setup payment: it activates the cover
being tested and is not itself covered. After backend activation, the runner
requests the separate capped controlled transaction, obtains the SDK-owned
cover decision, signs the exact reviewed bytes and submits byte-identical
post-sign evidence.

Chrome product conformance is a separate checkpoint. It must use Ember's normal
send flow with an already-active entitlement and prove that the exact request
shows `COVERED` before Ember signs it. The SDK runner must not pre-create that
product decision.

The SDK writes its public-safe JSON report under
`artifacts/api-conformance/`. A successful local build or unit test is not a
real-API conformance result; the reviewed passing report is the release
evidence.
