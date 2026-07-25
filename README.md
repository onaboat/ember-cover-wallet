# Ember Cover

> Most wallets warn you. Ember covers you.

Ember Cover gives Solana users real financial
protection against wallet-drain and malicious-signing losses. Where a typical
wallet only shows a warning before you sign, Ember underwrites the transaction
and, when it issues a covered decision, stands behind that decision with a
payout if a covered loss happens.

Ember is self-custody. It never holds seed phrases, never takes custody of funds,
and never changes normal wallet behavior. The underwriting runs alongside the
signing flow, so the user signs exactly as they always have.

Website: https://www.embercover.com

---

## What it does

- **Underwrites before you sign.** Ember's underwriting engine reviews a
  transaction and returns a clear cover decision: covered, not covered, or
  unsupported.
- **Pays out covered losses.** A covered loss can be claimed and paid up to the
  active cover cap, subject to the terms bound to the payment entitlement.
- **Stays out of the way.** If Ember is ever unavailable the wallet still works;
  the transaction simply earns no new cover.

The specifics of how Ember reaches a cover decision are proprietary and are not
documented in this repository.

## Cover payment

The current Devnet product uses a wallet-native one-off payment: the user sends
exactly 1 Devnet USDC to the configured Ember treasury token account for 30 days
of Core cover. The wallet simulates the SPL `TransferChecked` transaction before
showing the approval action. It creates no recurring authority or token
allowance.

After Solana confirms the payment, the wallet sends its signature through the
Cloudflare Worker to the Ember API. The API validates the transfer onchain and
activates the entitlement. Signed payment state is saved before broadcast so an
interrupted activation can retry without making a second payment.

---

## Architecture

Ember is a Rust workspace. The underwriting engine is Ember-owned IP.

```
clients/wallet-sdk    TypeScript SDK that partner wallets use to call Ember
crates/ember-api      Hosted HTTP API and persistence
crates/ember-engine   Underwriting engine (proprietary)
crates/ember-core     Shared types
```

## Technology

**Core engine and API (Rust, edition 2021, stable toolchain)**
- [axum](https://github.com/tokio-rs/axum) + [tokio](https://tokio.rs) async HTTP service
- [sqlx](https://github.com/launchbadge/sqlx) with **Postgres** as the sole staging/production engine (SQLite for unit tests)
- [solana-sdk / solana-program](https://docs.rs/solana-sdk) 2.x, [spl-token](https://docs.rs/spl-token) and [spl-token-2022](https://docs.rs/spl-token-2022) for on-chain reads
- [reqwest](https://docs.rs/reqwest) (rustls) for RPC and provider calls
- [jsonwebtoken](https://docs.rs/jsonwebtoken) for sessions; API-key auth for wallet partners
- [sha2](https://docs.rs/sha2), `bs58`, `base64`, `bincode` for hashing and encoding
- [serde](https://serde.rs), `chrono`, `uuid`, `thiserror`, `anyhow`
- [tracing](https://docs.rs/tracing) for structured logs and metrics

**Client SDK**
- `@ember/wallet-sdk` (TypeScript, ESM), tested with [vitest](https://vitest.dev) and [MSW](https://mswjs.io)

**Data**
- Postgres schema with forward-only migrations; opaque prefixed text IDs

**Build, deploy, CI**
- Multi-stage [Docker](Dockerfile) build (`rust` builder, `debian-slim` runtime)
- [Fly.io](fly.toml) deployment; `docker-compose.yml` for local Postgres
- GitHub Actions CI (`.github/workflows/ci.yml`)

## Repository layout

```
crates/
  ember-core/      shared types
  ember-engine/    underwriting engine (proprietary)
  ember-api/       hosted API service
clients/
  wallet-sdk/      TypeScript partner wallet SDK
tests/             end-to-end QA harness
Dockerfile, fly.toml, docker-compose.yml, run-local.sh
```

## Getting started

Prerequisites: Rust (stable), a local Postgres, and for end-to-end flows
`solana-test-validator` and Node.

```bash
# build and test the workspace
cargo build
cargo test

# run the full local stack: solana-test-validator + ember-api
./run-local.sh
```

The wallet SDK has its own tests:

```bash
cd clients/wallet-sdk && npm install && npm test
```

---

> Status: pre-launch. Cover terms, tiers, and exclusions are defined by the
> published terms version bound to each entitlement, not by this README.
