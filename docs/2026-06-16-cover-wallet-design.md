# Ember Cover Wallet (purpose-built) Design

Date: 2026-06-16

Status: design approved, ready for implementation plan.

Private repo. No engine internals, no secrets, no keys ever committed
(see [[feedback_public_wallet_secrecy]] reasoning — applies even though this repo
is private).

## Purpose

A purpose-built Solana browser-extension wallet whose differentiator is **Ember
Cover** in the signing flow. We are NOT integrating into the Samui fork: that
fork's signing is explicitly POC ("None of this code is safe for production... 
Private keys should not be handled in this way"), it force-locks the wallet after
every signature (breaking per-request auth), and it carries no dapp origin. We
build the security-critical and cover parts fresh and own them, reuse the proven
crypto/plumbing, and avoid fighting POC code near real money.

## Scope (V1): cover-focused wallet

In: a secure single-keypair vault, a wallet-standard provider so any Solana dapp
can connect, and the signing flow with Ember Cover (pre-sign -> banner -> approve
-> sign -> post-sign). A dapp connects and signs through it with cover. That is
the product surface.

Out (deferred, captured): send/receive UI, portfolio/balances, multi-account,
full consumer onboarding; **BIP39 seed phrase** (V1 is a generated keypair with
an encrypted backup blob — "move to A" after it works); mainnet (devnet first);
public-sourcing the repo.

## Decisions

- **Surface:** cover-focused (one keypair, held right), not a full consumer wallet.
- **Build strategy:** fresh WXT extension, lift selectively. Own the vault +
  signing+cover fresh; lift Samui *patterns* (wallet-standard registration,
  background<->content<->popup messaging); reuse `@solana/kit`,
  `@wallet-standard/*`, WXT, and the already-built+tested cover client/banner/
  hook/auth + cover proxy (24 tests) copied in.
- **Repo:** new, **private** (`ember-cover-wallet`), its own folder, never inside
  the `ember` backend.
- **Key backup:** generated keypair + encrypted backup blob; **no seed phrase**
  in V1 (deferred to "move to A").
- **Auth:** Ember session key (separate ephemeral key) signs API requests; the
  wallet key only signs txs (always user-approved) + a one-time session
  authorization. This fixes the fork's lock conflict.
- **Cluster:** devnet (the live Ember API:
  `ember-production-de2c.up.railway.app`).

## Architecture & Components

A single tight WXT extension; key material lives ONLY in `vault/`. Everything
else asks the vault to sign — nothing else touches a key.

- **`vault/`** (built fresh) — secure keystore: Argon2id-encrypted at rest,
  non-extractable in-memory signing key, session unlock, encrypted backup. See
  Vault section.
- **`wallet-standard/`** (pattern lifted) — the wallet-standard provider so dapps
  discover + connect; surface: `connect`, `signTransaction`,
  `signAndSendTransaction`, `signMessage`.
- **`cover/`** (copied, tested) — cover client, `<CoverBanner>`,
  `useCoverDecision`, `ember-auth`.
- **`signing/`** (built fresh) — cover-signing orchestration + session-key auth +
  origin capture. See Cover-Signing Flow.
- **`background/`** + **`content/`** (pattern lifted) — WXT service worker +
  content script; dapp<->wallet messaging, wallet-standard injection, origin
  capture.
- **`ui/`** — onboarding (create keypair, set password), unlock, signing approval
  screen with the cover banner.
- **`worker/`** (copied + extended) — the cover proxy (CF Worker), extended for
  two-signature session auth.

Reused as-is: `@solana/kit`, `@wallet-standard/*`, WXT, the `cover/` + `worker/`
code. Owned fresh: `vault/`, `signing/`. Lifted patterns: wallet-standard
provider, background messaging.

## Vault (key security)

Assumes a hostile page and a stolen disk.

**Create:** generate an Ed25519 keypair (extractable only this instant) -> derive
a 256-bit AES key from the password via **Argon2id** (random salt, memory-hard
params) -> **AES-GCM** encrypt the private key bytes (random IV), binding
`salt | argon2Params | publicKey` into the GCM **AAD** so metadata can't be
tampered (param-downgrade, pubkey-swap) -> persist `{ salt, argon2Params, iv,
ciphertext, publicKey }` to IndexedDB -> zero plaintext, discard the extractable
key.

**Unlock:** Argon2id(password, salt) -> AES key -> AES-GCM decrypt (verifies AAD)
-> raw bytes -> `importKey` as a **non-extractable** Ed25519 `CryptoKey` -> zero
bytes. Wrong password / tampered metadata -> GCM auth fails.

**Sign:** `crypto.subtle.sign('Ed25519', key, message)`. Non-extractable: a
compromised page can request a signature (and every dapp tx still hits the
approval screen) but can never read the key.

**Session (lock-conflict fix):** the unlocked key stays **in memory only** (the
service worker) — never disk-persisted — with a keepalive during an active
session; SW termination -> re-unlock. **No force-lock after each signature**;
explicit lock is idle auto-lock + browser close. Locked-state-on-disk is ONLY
the Argon2id ciphertext.

**Hardening (from review):**
- Unlocked key in memory only, never IndexedDB/disk.
- Vault metadata authenticated via GCM AAD.
- **Enforce a strong password** (entropy minimum + meter); the UI states plainly
  that this password protects everything; Argon2 cost tuned so offline guessing
  of a stolen backup is painful.
- **Unlock attempt rate-limit / lockout** (anti online brute-force).
- **GCM nonce hygiene:** fresh random IV every encrypt; password change re-derives
  with a new salt + IV. Never reuse a nonce.

**Backup (V1):** export the encrypted blob (`{ salt, params, iv, ciphertext }`)
as a file/string; restore = import blob + password. No seed words to phish.

**Deferred ("move to A"):** BIP39 seed phrase; `vault/` is built so a
seed-derived key slots into the same encrypt/import path.

## Cover-Signing Flow

**Two keys:**
- **Wallet key** (vault, non-extractable, **user-approved every time**): signs the
  transaction + once signs the session authorization.
- **Ember session key** (a delegated API-auth key — generated once at enrollment,
  stored in extension storage, persists across browser sessions, rotated by
  re-enrolling; **cannot move funds**): signs each Ember API request silently —
  dodges the lock conflict. Compromise is contained: it can only request cover
  decisions / attach evidence, never sign a fund-moving transaction.

**Activate Ember Cover:** review and simulate an exact 1 Devnet USDC
`TransferChecked` to the configured Ember treasury token account -> user approves
the one-off transfer -> save the signed transaction before broadcast -> wait for
Solana confirmation -> authorize the Ember session key -> call
`/entitlements/payments/activate` through the Worker. The API validates the
confirmed transfer and activates 30 days of Core cover. If confirmation or API
activation is interrupted, the wallet retries the same saved payment signature
and never constructs another payment automatically.

**Per dapp sign request:**
1. Content script captures the **dapp origin** and threads it to the background.
2. Approval screen opens; `<CoverBanner>` fires **pre-sign** through the proxy,
   request signed by the **session key** (silent), carrying `dappUrl` + wallet
   pubkey. Proxy verifies the session authorization + the session signature ->
   forwards to the Ember API -> decision -> banner.
3. User reviews + approves (unlock if the session is locked).
4. Vault signs the tx with the **wallet key**.
5. **Post-sign** (best-effort, session-key-signed) binds the evidence. The signed
   result returns to the dapp on the normal path.

**Proxy two-signature auth (no Ember API change):** the proxy verifies (a) the
wallet authorized the session key (wallet-key signature over the authorization)
and (b) the session key signed this fresh request, and that the body's
`walletPublicKey` matches the authorized one. Then it injects the partner key +
`userRef` and forwards. All in the proxy + extension; the Ember API is untouched.

## Error Handling (fail-open; cover is strictly additive)

- Pre-sign slow (>1500ms)/down -> `cover_unavailable`; signing proceeds.
- Not enrolled / not registered -> "not covered"; signing proceeds.
- Post-sign is fire-and-forget with retries; never awaited on the dapp resolve.
- **Nothing in the dapp signing path ever blocks on or fails because of Ember.**
- Decision expiry (60s) -> re-fetch; a stale decision never binds.

## Testing

- **Vault (unit, vitest):** create->unlock->sign round-trip; wrong-password
  reject; **AAD-tamper reject**; **unlock lockout**; backup export/import. Pure
  crypto, runs locally (SubtleCrypto + Argon2 WASM).
- **Cover client/banner/hook/auth:** the 24 tests already written, copied over.
- **Proxy:** extend tests for the **two-signature** verification (session
  authorization + session request signature).
- **Extension integration** (wallet-standard provider, signing flow, React UI):
  **Playwright e2e** against a test dapp with the real built extension — the
  real-runtime gate.

## Reuse / Provenance

Copied in (tested): `cover/` (`ember-types`, `ember-config`, `ember-client`,
`cover-decision-logic`, `use-cover-decision`, `cover-banner`, `ember-auth`) and
`worker/` (`cover-proxy`) from the abandoned fork-integration work. Lifted
patterns: wallet-standard provider + background messaging from Samui. Libraries:
`@solana/kit`, `@wallet-standard/*`, WXT, Argon2 WASM (vetted, pinned).

## Pre-build dependency

The Ember API (`ember-production-de2c.up.railway.app`) is live on Railway. The
Worker points at its public base URL with no port and injects the partner key as
a secret. The extension's Devnet RPC endpoint is configured separately through
its gitignored local environment.
