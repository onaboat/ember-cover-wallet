# Ember API conformance wallet fixture

This fixture lets the SDK repository's real-API conformance runner use the
actual Ember Chrome wallet without exposing a seed phrase, private key, or
extension password to Node. The Node artifact prepares and simulates exact
Devnet transactions. A token-protected loopback page asks the operator to
connect Ember and explicitly continue each Wallet Standard approval.

This is a Devnet QA tool. It does not certify Mainnet, HTTPS-wallet CORS,
Android, or Solana-phone behavior.

## Safety boundary

- The fixture accepts only the SDK runner's `sandbox` environment.
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

Choose a funded Devnet-only QA wallet and a controlled Devnet recipient. The
wallet needs at least 1 Devnet USDC plus enough Devnet SOL for the payment and
the controlled transfer.

In the SDK repository, set its documented conformance variables plus these
fixture-owned values:

```sh
export EMBER_CONFORMANCE_FIXTURE_MODULE=/absolute/path/to/wallet/tools/api-conformance/dist/ember-conformance-wallet.mjs
export EMBER_CONFORMANCE_RPC_URL=https://api.devnet.solana.com
export EMBER_CONFORMANCE_RECIPIENT=REPLACE_WITH_CONTROLLED_DEVNET_RECIPIENT
export EMBER_CONFORMANCE_TRANSFER_LAMPORTS=5000
export EMBER_CONFORMANCE_TRANSACTION_APPROVAL=I_APPROVE_DEVNET_TRANSACTIONS
```

Then run:

```sh
npm run conformance:api
```

The runner prints a tokenized `http://127.0.0.1` operator URL. Open that exact
URL in the Chrome profile where the unpacked Ember extension is installed,
connect the designated QA wallet, and inspect every message and transaction
before continuing to the wallet's own approval screen.

Use one session owner during this run. Disconnect any separate Ember API
session already open inside the extension before starting; the SDK conformance
runner owns the API session while the extension remains the protected signer.

The SDK writes its public-safe JSON report under
`artifacts/api-conformance/`. A successful local build or unit test is not a
real-API conformance result; the reviewed passing report is the release
evidence.
