# P14 Reference Wallet Integration

**Status:** Implemented and verified; organization release signing remains an external gate
**Branch:** `production/14-reference-wallet-integration`
**Scope:** Ember Chrome reference wallet plus the companion exact-extension-origin API correction

## Plain-English outcome

The wallet no longer talks to the old compatibility API through a Cloudflare
Worker. It uses the packaged `@embercover/wallet-sdk` directly.

The old route worked because the extension called a Worker and the Worker added
a partner bearer key. That made the Worker, rather than the Chrome extension,
the API caller. The P14 route is secretless: the wallet proves ownership once,
then a short-lived API-only key signs each exact request. No partner secret is
present in the extension.

The extension is a reference and certification wallet. P14 does not add swaps,
staking, fiat, hardware-wallet support, or an automated payout system.

## Companion API correction

P05 originally accepted production browser bindings only as exact HTTPS
origins. Chrome extensions use `chrome-extension://<extension-id>`, so the
direct SDK could not enroll even though the older Worker path appeared to work.

The API now accepts an exact Chrome extension origin only when:

- the scheme is exactly `chrome-extension`;
- the ID is exactly 32 lowercase characters in the Chrome `a`–`p` alphabet;
- there is no wildcard, port, path, query, fragment, or credential; and
- the exact origin is present in the versioned integration configuration.

This does not make all extensions trusted. It allows one approved extension ID.
The ID is stabilized by a public manifest key. The private release-signing key
is never requested by, stored in, or bundled by this project.

## Runtime architecture

```text
Wallet owner challenge signature
          |
          v
Short-lived scoped Ember session
          |
          +--> offers -> exact terms acceptance -> verified signed quote
          |                                      |
          |                                      v
          |                         quote-bound TransferChecked
          |                         genesis check -> simulation
          |                         persist -> user sign -> broadcast
          |                                      |
          |                                      v
          |                           server payment + coverage records
          |
          +--> exact pre-sign decision -> wallet approval -> durable evidence
          |                                      |
          |                                      v
          |                           server decision and lineage
          |
          +--> claim eligibility -> human-reviewed claim intake
```

Local storage is recovery state and a display cache. It never upgrades a
payment, coverage instance, decision, evidence record, or claim into an
authoritative server fact.

## Main functions and what they do

### Session lifecycle

| Function | Plain-English responsibility |
| --- | --- |
| `EmberClientCoordinator.enroll` | Uses the unlocked vault once to sign the server challenge and opens the full P11 scoped session. |
| `EmberClientCoordinator.activeClient` | Restores the SDK after a service-worker restart, rejects wallet/session mismatches, and rotates the API-only key shortly before expiry. |
| `EmberClientCoordinator.revoke` | Revokes the server session and clears the local refresh credential even if cleanup follows an error. |
| `getSessionSigner` | Restores the exact ephemeral key and promotes a pending key if rotation was interrupted after the server accepted it. |
| `BrowserWalletSessionStore` | Persists only the SDK session and refresh credential; it never stores a wallet seed or vault private key. |

### Offers, terms, quote, and payment

| Function | Plain-English responsibility |
| --- | --- |
| `CoveragePaymentProvider.offers` | Reads the current offers from Ember; there is no locally invented plan or price. |
| `previewPayment` | Requires explicit terms acceptance, creates and verifies a signed quote, verifies Mainnet genesis, constructs the exact payment, and simulates without signing. |
| `bindQuoteReference` | Adds the quote reference as one static read-only non-signer account on the classic SPL `TransferChecked` instruction. |
| `activatePayment` | Re-verifies the quote, rebuilds and simulates, signs only after the user action, persists the signed transaction, then broadcasts. |
| `syncPayment` | Recovers the same signed transaction and payment record; it does not create a second payment. |
| `registerAndRefresh` | Submits the quote ID and on-chain signature through the SDK and records only the server-returned payment and coverage state. |

Production payment code accepts only:

- a live production quote;
- Solana `mainnet-beta`;
- the canonical Mainnet genesis hash;
- the classic SPL Token program;
- the exact mint, decimals, amount, treasury token account, treasury owner, and
  quote reference signed by Ember; and
- a payer/protected wallet matching the active wallet session.

### Signing and evidence

| Function | Plain-English responsibility |
| --- | --- |
| `EmberCoverProvider.preSign` / `preSignMessage` | Resolves a server-confirmed active coverage instance and asks the SDK to review the exact bytes. |
| `RequestService.create` | Rejects chainless and cross-build-chain transaction requests before opening approval. |
| `RequestService.approveSignTransaction` | Rejects expired decisions and bytes changed after review, signs in the service worker, then waits for durable evidence storage before releasing bytes to the dapp. |
| `EvidenceOutbox.put` | Stores the exact SDK evidence body, rejecting a later body with different bytes for the same decision. |
| `EvidenceOutbox.drain` | Retries after restart and removes evidence only after Ember accepts it. |
| `WalletTransferProvider.sendTransfer` | Simulates, signs, records, and queues evidence before the wallet’s first broadcast attempt. |

Ordinary signing remains available when Ember is unavailable, but the wallet
must show that cover is unavailable or absent. An unavailable response is never
a coverage grant.

### Authoritative activity and claims

| Function | Plain-English responsibility |
| --- | --- |
| `EmberLifecycleStore.refresh` | Re-reads payment, coverage, decisions, lineage, and claims from Ember. |
| `EmberLifecycleStore.recordPayment` / `recordDecision` | Stores identifiers and cached display data for recovery; the cache is labeled as cache when the server cannot be reached. |
| `EmberCoverProvider.claimEligibility` | Asks Ember whether the exact decision is currently eligible for claim intake. |
| `EmberCoverProvider.createClaim` | Submits a claim against that decision through the packaged SDK. |

Claim submission starts human review. P14 creates no payout, signs no payout,
broadcasts no payout, and changes none of P13’s manual commission-settlement
controls.

## Chain and extension boundaries

- A build advertises one Wallet Standard chain.
- A transaction request without a chain is rejected.
- A request for the other Solana cluster is rejected.
- Production payment checks the RPC-reported genesis hash before construction
  or signing.
- `signAndSendTransaction` is not advertised.
- Multiple transaction signing remains visibly unsupported.
- Manifest host permissions contain only the configured Ember API origin and
  the single build-bound RPC origin.
- Runtime code reads only the explicit P14 environment variables; unrelated
  historical `WXT_*` settings are not serialized into the public bundle.
- Chrome sends the exact extension Origin during session bootstrap but may
  omit it on signed GETs. The server permits that omission only for the
  already exact extension-bound session; website sessions remain exact-Origin
  on every request.

## Supply chain and release gates

The repository installs the reviewed SDK tarball from `vendor/`.

- Package: `@embercover/wallet-sdk@1.1.1`
- SHA-256:
  `0348fe7456eca64c1c651b6be49b1fb8b59e21e7615430011a0adcf57e97f985`

`bun run verify:p14` checks the digest, manifest version, production
configuration, public-key-derived extension ID, exact host permissions, and
the built bundle for retired Worker/partner-secret routes.

The following cannot be manufactured inside the repository and remain release
gates:

- a Chrome release signed by the organization’s existing release process;
- the resulting immutable store artifact and provenance;
- the production integration row containing that exact extension origin; and
- the P16 production shadow/certification record.

No private Chrome signing key is required in developer environment variables.

## Verification record

On 2026-07-28:

- 210 wallet unit tests passed across 44 files;
- all 11 Chrome extension E2E scenarios passed, including exact extension
  bootstrap Origin and Chrome's originless signed reads;
- type checking, frozen dependency installation, secret/retired-route scan,
  and the P14 bundle verifier passed;
- SDK 1.1.1 passed 31 tests, type checks, browser/React Native example checks,
  generated-client drift, ESM/CommonJS clean-consumer installs, secret scan,
  SBOM generation, and package inspection;
- the SDK tarball was packed twice with byte-identical SHA-256
  `0348fe7456eca64c1c651b6be49b1fb8b59e21e7615430011a0adcf57e97f985`;
- the production configuration path was built twice with a temporary public
  test identity and exact HTTPS API/RPC origins; both unsigned build trees
  matched at
  `453421ca69f47fe1bee96e67e551a27af471c6eb41f50dd84633f87fff64ef40`;
  and
- no real wallet transaction, payment, claim payout, partner commission
  settlement, live Ember API, or online Ember database was used.

The temporary public identity proves build determinism and validation logic;
it is not the organization's release identity and does not satisfy the signed
Chrome artifact gate.

## Rollback

Publish the prior already-signed reference-wallet artifact. Do not re-enable a
partner bearer key in the extension. Preserve server wallet subjects, sessions,
quotes, payments, coverage, decisions, evidence, and claims.
