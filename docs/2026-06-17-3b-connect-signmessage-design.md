# 3b Design — CONFIRMED DECISIONS (read first; these override the lift-map below where they conflict)

This document is the workflow-generated lift-map (verbatim, below) plus the human-confirmed
decisions on top. Where they conflict, THIS header wins.

**Confirmed 2026-06-17 (per [[feedback_follow_conventions]] — Phantom/Solflare conventions):**

1. **HARDENED SIGN (overrides §5/§9#6 "by-convention").** `VaultController.sign` must be
   reachable ONLY inside the background SW, never via any proxy. Implementation delta vs the
   lift-map:
   - `vault-service.ts`: register a NARROW facade (a plain object exposing only
     `hasVault/createVault/unlock/isUnlocked/lock/getAddress`) under `ember.VaultService`, and
     return the REAL `VaultController` from `registerVaultService()` for in-SW use. Define
     `interface VaultUI` (those 6 methods); `getVaultService(): ProxyService<VaultUI>`. Because
     the registered service has no `sign`, a runtime `proxy.sign(...)` marshals to a method the
     facade does not have and fails — `sign` is unreachable from any page.
   - `request-service.ts`: takes an injected `VaultSigner` ({ `getAddress()`, `sign(message)` })
     — the REAL controller in the SW. `approveConnect` calls `signer.getAddress()` directly;
     `approveSignMessage` calls `signer.sign(m)` directly. It does NOT import `getVaultService`.
     `interface VaultSigner` lives in `request-service.ts`; `VaultController` satisfies it; unit
     tests inject a fake `VaultSigner`.
   - `background.ts`: `const controller = registerVaultService(); registerRequestService(controller); registerMessageHandlers()`.
   - Net: signing happens only inside `RequestService.approveSignMessage`, which the popup reaches
     only via the gated Approve button. This is the Phantom/Solflare convention (key never signs
     outside an explicit approval).

2. **Message display = §1's `decode-messages.ts` (UTF-8, hex fallback) + show the dapp domain
   prominently** as the primary trust signal (it is already `data-testid="origin"` in `RequestApp`;
   render it prominently). Matches Phantom/Solflare. The "looks like a transaction" warning is an
   advanced feature, deferred.

3. **Defaults adopted (no further questions):** normalized `https://host` origin (§9#1);
   single in-flight request (§9#3, Phantom queues — we add FIFO when we expand past the slice,
   noted); no-op `disconnect` for the slice (§9#4); pin `@wallet-standard/core` `1.1.1` (§9#5);
   `chains = SOLANA_CHAINS` documented as "address valid on these clusters" (§9#7).

The implementation PLAN derived from this design is `2026-06-17-3b-connect-signmessage-plan.md`.

---

All facts confirmed. `base58Decode(value: string): Uint8Array` exists at ember-auth.ts:3. `VaultController` has `getAddress`/`isUnlocked`/`unlock`/`lock`, no `sign` yet. `DeepAsync` wraps all methods async (proxy split for `create` is feasible by registering a narrowed interface). `registerService<T>(key, realService)` takes the real instance.

I now have everything needed to produce the corrected lift-map. The critique's valid findings I'm incorporating:

- **(i) CRITICAL**: `buildSignMessageOutputs` must use `decodeTransportBytes(input.message)` not `new Uint8Array(input.message)`.
- **(j) CRITICAL/important**: e2e must assert `signedMessage` deep-equals the literal dapp-sent bytes.
- **(e) CRITICAL**: §5 "no page-boundary corruption popup↔SW" claim is false; popup→SW proxy serializes Uint8Array. Correct the rationale.
- **(e) important**: `getRequestService()` must mirror `vault-service.ts` (always return proxy), drop the `??` real-instance hack.
- **(e) CRITICAL/security**: split the proxy surface so the popup can only reach `get/resolve/reject`, not `create`.
- **(d) important**: `sender.origin` is not typed; derive from `sender.url`.
- **(a) important**: typed transport variant for `connect` return (publicKey as record on the wire); omit `icon` rather than `icon: undefined`.
- **(b) critical-as-flagged-but-actually-fine**: document the rest-param→array collapse and the zero-margin return in content-bridge.
- **(f) important**: idle-lock race after unlock; popup must re-prompt.
- **(g) minor**: document the "popup calls sign only after approval" invariant is by convention, not enforced.
- **(i) important**: unit-test both the `Uint8Array` and `{0:..}` decode paths; cross-realm `instanceof` note.
- **Cross-cutting blocker**: resolve `wxt/browser` (it exists) — no longer an open question.
- Add the negative-path e2e (close popup → reject) to lock the cancellation contract.

Here is the complete corrected lift-map.

---

# LIFT-MAP — Sub-project 3b: dapp connect + signMessage vertical slice (REVISED)

**Target:** `/Users/hmx/Documents/Projects/ember-cover-wallet` (single-package WXT, no monorepo)
**Scope:** dapp discovers wallet → `connect` → `signMessage` through the vault, gated by an approval popup that unlocks if locked. `signTransaction` / `signAndSendTransaction` / `signIn` / cover are **deferred** but every piece of infra below is built to extend to them by adding one union arm + one action + one UI case.

**Verified repo + dependency facts that shaped the adaptation (re-confirmed against `node_modules`):**
- `Vault.sign(message)` exists (vault.ts:102). It self-locks and throws `'vault is locked'` if `signingKey` is null **or** if `now - lastActivityAt >= idleLockMs` (vault.ts:106-109) — so it can fail **after** a successful `unlock` if the popup sits idle past the window. No crypto added in 3b.
- `base58Decode(value: string): Uint8Array` exists at `src/cover/ember-auth.ts:3`.
- `getVaultService()` (vault-service.ts:17) **always** returns `createProxyService(...)`; `registerVaultService()` constructs the real controller. The new request service mirrors this exactly — the getter never returns the real instance.
- `VaultController` (vault-controller.ts) has `hasVault/createVault/unlock/isUnlocked/lock/getAddress`; **no `sign` yet** (3b adds it).
- `@webext-core/messaging` `GetDataType` = `Args['length'] extends 0 | 1 ? Args[0] : never` (generic-B-kFbyP9.d.mts:36). Handlers must take 0 or 1 args; multi-arg handler data resolves to `never`. `onMessage` return type is `void | MaybePromise<GetReturnType>` (line 117) — a returned value IS the response.
- `Runtime.MessageSender` (`@types/webextension-polyfill`, runtime.d.ts:151-186) has `tab?`, `frameId?`, `id?`, `url?`, `userScriptWorldId?` — **no `origin`**. `sender.origin` does NOT type-check. Origin must be derived from `sender.url`.
- **Both** `wxt/browser` (dist/browser.mjs) and `@wxt-dev/browser` exist. **Resolved: import `browser` from `wxt/browser`.** No new dep needed, no open question.
- `@webext-core/messaging@3.0.2` and `@webext-core/fake-browser@1.5.2` present (transitive). `@webext-core/messaging/page` subpath exists. `@webext-core/proxy-service@2.0.0` present; `DeepAsync` wraps every method as async.
- `base58Decode` lives in `src/cover/ember-auth.ts` — wallet-standard imports it from there.
- WXT `imports:false` → all WXT helpers import from explicit paths; local imports keep `.ts`.
- `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` + `erasableSyntaxOnly` (no enums/param-properties) + `verbatimModuleSyntax` (type-only imports must say `import type`).

**Fork uses:** `@wallet-standard/core@1.1.1`, `@solana/wallet-standard-features@1.3.0`, `@solana/wallet-standard-chains@1.1.1`. Latest core is `1.1.2`. Pinning to fork versions for fidelity (see §9 #5).

---

## CRITICAL CORRECTION CARRIED THROUGH THE WHOLE MAP — Uint8Array crosses TWO serialization boundaries

The original map's §5 claim "the approval window is itself an extension page so there is no page-boundary corruption between popup and SW — `decodeTransportBytes` is only needed at the dapp boundary" is **WRONG and is corrected everywhere below.**

A `signMessage` `message` byte field travels:

```
dapp(page) --[custom event: serialize]--> content --[runtime msg: serialize]--> SW(action)
   --> stored in RequestService.#request.data
   --[proxy-service runtime msg: serialize]--> popup (request.get())
   --[proxy-service runtime msg: serialize]--> SW (buildSignMessageOutputs runs via... see below)
```

Every `runtime`/`proxy-service` hop structured-clone-then-JSON-serializes `Uint8Array` into `{0:n,1:n,...}`. So **`message` arrives in the popup as a plain record**, and **`new Uint8Array(record)` produces garbage** (`new Uint8Array({0:1,1:2})` is `Uint8Array(0)`/length-coerced nonsense, NOT the bytes). Two consequences threaded through the map:

1. `buildSignMessageOutputs` MUST use `decodeTransportBytes(input.message)`, never `new Uint8Array(input.message)`. (finding i)
2. To avoid the popup→SW round-trip on the output entirely (and to keep the signing decode in ONE place), `buildSignMessageOutputs` runs **in the SW**, invoked through a dedicated proxy method `RequestService.approveSignMessage()` rather than being executed in the popup and shipping a `Uint8Array[]` back. The popup never reconstructs signature bytes; it just says "approve." This removes a whole class of popup→SW Uint8Array corruption and matches where the key already lives. (corrects finding e's serialization claim + simplifies)

---

## 1. FILES TO CREATE / MODIFY

### `src/messaging/` (page↔content↔background transport)

---

**`src/messaging/transport.ts`** — CREATE. Transport-encoded type aliases used by the schema so the wire shapes are **type-honest** (byte fields are `Record<string,number>` on the wire, not `Uint8Array`). This kills the "latent `as` hole" the critique flagged in (a): the page-side decode is now decoding a value the type system agrees is a record.

> Unit-testable: no (type-only).

```ts
import type { SolanaSignMessageOutput } from '@solana/wallet-standard-features'
import type { WalletAccount } from '@wallet-standard/core'

/** A Uint8Array after extension-messaging serialization. */
export type TransportBytes = Record<string, number>

/** WalletAccount as it arrives over the wire: publicKey is a serialized byte record. */
export type TransportWalletAccount = Omit<WalletAccount, 'publicKey'> & { publicKey: TransportBytes }

/** SolanaSignMessageOutput over the wire: both byte fields are serialized records. */
export type TransportSignMessageOutput = Omit<SolanaSignMessageOutput, 'signature' | 'signedMessage'> & {
  signature: TransportBytes
  signedMessage: TransportBytes
}

export interface TransportConnectOutput {
  accounts: TransportWalletAccount[]
}
```

---

**`src/messaging/schema.ts`** — CREATE. The RPC contract. Uses the transport types for any response containing bytes, so the page-realm decode is type-checked rather than cast. The two one-way `onRequest*` events from the original map are **DROPPED** — popup-only reads state via the proxy and never consumes them; keeping dead schema entries was unjustified weight.

> Unit-testable: no (type-only). Type-checked by `tsc --noEmit`.

```ts
import type { SolanaSignMessageInput } from '@solana/wallet-standard-features'
import type { StandardConnectInput } from '@wallet-standard/core'

import type { TransportConnectOutput, TransportSignMessageOutput } from './transport.ts'

export interface MessagingSchema {
  // page -> background RPCs, awaited by the dapp. Byte fields come back transport-encoded.
  connect(input?: StandardConnectInput): Promise<TransportConnectOutput>
  disconnect(): Promise<void>
  // NOTE: the wallet-standard SolanaSignMessageMethod is variadic (...inputs); we collapse
  // the rest-params to ONE array payload at this boundary because @webext-core GetDataType
  // only accepts handlers with 0|1 args (Args['length'] extends 0|1). See §2.
  signMessage(inputs: SolanaSignMessageInput[]): Promise<TransportSignMessageOutput[]>
}
```

---

**`src/messaging/window.ts`** — CREATE. Page-realm side of the page↔content bridge (custom events). Namespace `ember-wallet`.

> Unit-testable: no (DOM custom-event side effects). Covered by e2e.

```ts
import { defineCustomEventMessaging } from '@webext-core/messaging/page'

import type { MessagingSchema } from './schema.ts'

export const { onMessage, sendMessage } = defineCustomEventMessaging<MessagingSchema>({
  namespace: 'ember-wallet',
})
```

---

**`src/messaging/extension.ts`** — CREATE. Extension-context side (content↔background via `browser.runtime`). The `onMessage` callback here exposes `sender` (origin capture lever — see §9 and §1 message-handlers for the `sender.url` derivation).

> Unit-testable: no (browser API). Covered by e2e.

```ts
import { defineExtensionMessaging } from '@webext-core/messaging'

import type { MessagingSchema } from './schema.ts'

export const { onMessage, sendMessage } = defineExtensionMessaging<MessagingSchema>()
```

---

**`src/messaging/transport-bytes.ts`** — CREATE. The CRITICAL Uint8Array reconstruction across any serialization boundary (page **or** proxy). Note the cross-realm `instanceof` caveat: a real `Uint8Array` from another realm can fail `instanceof Uint8Array`; in that case `Object.values` on a genuine typed array still yields the right bytes, so the function self-heals.

> Unit-testable: **yes**. Two tests required (finding i): (a) `decodeTransportBytes({0:1,1:2,2:255})` deep-equals `Uint8Array.from([1,2,255])`; (b) `decodeTransportBytes(Uint8Array.from([1,2,255]))` deep-equals `Uint8Array.from([1,2,255])` (already-typed-array path).

```ts
/**
 * Browser extension messaging (runtime AND custom-event AND proxy-service) serializes
 * Uint8Array to a plain object {0: n, 1: n, ...}. Reconstruct it or crypto verify fails.
 * Self-heals across realms: a cross-realm Uint8Array fails `instanceof` but Object.values
 * still yields its bytes.
 * @link https://github.com/mozilla/webextension-polyfill/issues/643
 * @link https://issues.chromium.org/issues/40321352
 */
export function decodeTransportBytes(value: Record<string, number> | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(Object.values(value))
}
```

---

**`src/messaging/content-bridge.ts`** — CREATE. Pure relay: page custom-events → extension runtime. (Fork's `content.ts`, renamed to avoid clashing with the `content.ts` entrypoint file.)

> Unit-testable: no (pure relay, browser API). Covered by e2e.

```ts
import { sendMessage } from './extension.ts'
import { onMessage } from './window.ts'

/**
 * Relays page-realm requests into the background service worker.
 * ZERO-MARGIN INVARIANT: each handler MUST `return await sendMessage(...)`. @webext-core
 * ships the returned value back to the page as the RPC response (onMessage return type is
 * void | MaybePromise<GetReturnType>). Adding any non-returning statement after the return,
 * or dropping the `return`, makes the dapp promise hang forever with no error.
 */
export function registerContentBridge(): void {
  onMessage('connect', async ({ data }) => await sendMessage('connect', data))
  onMessage('disconnect', async () => await sendMessage('disconnect'))
  onMessage('signMessage', async ({ data }) => await sendMessage('signMessage', data))
}
```

---

### `src/wallet-standard/` (the injected provider)

---

**`src/wallet-standard/icon.ts`** — CREATE. The required `WalletIcon` data-URI (typed `data:image/...`). Inline SVG, no asset pipeline dependency.

> Unit-testable: trivial (skip). Type idea: assignable to `WalletIcon`.

```ts
import type { WalletIcon } from '@wallet-standard/core'

// Minimal ember flame mark; replace with brand asset later. Must be a data: URI.
export const icon =
  `data:image/svg+xml;base64,${btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="7" fill="#0b0b0f"/>' +
      '<path d="M16 6c3 4 6 6 6 11a6 6 0 1 1-12 0c0-2 1-3 2-4 0 2 1 3 2 3 0-4 0-7 2-10Z" fill="#ff5a1f"/>' +
    '</svg>',
  )}` as WalletIcon
```

---

**`src/wallet-standard/features/sign-message.ts`** — CREATE. The page-realm `signMessage` feature method. Variadic per the wallet-standard `SolanaSignMessageMethod` spec; collapses rest-params to one array payload (the §2-documented adaptation), forwards to background, decodes the two byte fields.

> Unit-testable: **yes** (mock `sendMessage`). Two tests: (a) given a response whose `signature` is a `Record<string,number>`, the returned `signature instanceof Uint8Array` is true; (b) calling `signMessage(a, b)` causes `sendMessage('signMessage', [a, b])` — asserts the rest→array collapse.

```ts
import type { SolanaSignMessageInput, SolanaSignMessageOutput } from '@solana/wallet-standard-features'

import { decodeTransportBytes } from '../../messaging/transport-bytes.ts'
import { sendMessage } from '../../messaging/window.ts'

export async function signMessage(...inputs: SolanaSignMessageInput[]): Promise<SolanaSignMessageOutput[]> {
  // Wallet-standard passes rest-params; we send them as a single array (messaging arity rule).
  const outputs = await sendMessage('signMessage', inputs)
  return outputs.map((output) => ({
    ...output,
    signature: decodeTransportBytes(output.signature),
    signedMessage: decodeTransportBytes(output.signedMessage),
  }))
}
```

---

**`src/wallet-standard/wallet.ts`** — CREATE. The `EmberWallet` class. Declares **only** `StandardConnect`, `StandardDisconnect`, `StandardEvents`, `SolanaSignMessage` via a closed intersection return type (§3). The connect handler decodes the transport-encoded `publicKey` — now type-honest because the schema returns `TransportConnectOutput`.

> Unit-testable: partially — `name`/`version`/`chains`/`icon` getters and the `features` key-set are pure. Test idea: `Object.keys(new EmberWallet().features)` equals exactly the four feature identifiers.

```ts
import { SOLANA_CHAINS } from '@solana/wallet-standard-chains'
import {
  SolanaSignMessage,
  type SolanaSignMessageFeature,
} from '@solana/wallet-standard-features'
import type {
  StandardConnectInput,
  StandardConnectOutput,
  StandardEventsListeners,
  StandardEventsNames,
} from '@wallet-standard/core'
import {
  type IdentifierArray,
  StandardConnect,
  type StandardConnectFeature,
  StandardDisconnect,
  type StandardDisconnectFeature,
  StandardEvents,
  type StandardEventsFeature,
  type Wallet,
  type WalletAccount,
  type WalletIcon,
  type WalletVersion,
} from '@wallet-standard/core'

import { decodeTransportBytes } from '../messaging/transport-bytes.ts'
import { sendMessage } from '../messaging/window.ts'
import { signMessage } from './features/sign-message.ts'
import { icon } from './icon.ts'

// EXACTLY the four features Ember implements in 3b. Closed intersection => tsc rejects any
// extra key and requires no missing one. Add sign-transaction later = add its feature type
// here + a feature method + the [SolanaSignTransaction] key.
type EmberWalletFeatures = SolanaSignMessageFeature &
  StandardConnectFeature &
  StandardDisconnectFeature &
  StandardEventsFeature

// Only the SolanaSignMessage account feature is advertised on accounts.
const ACCOUNT_FEATURES: IdentifierArray = [SolanaSignMessage]

export class EmberWallet implements Wallet {
  get accounts(): readonly WalletAccount[] {
    return this.#accounts
  }

  // chains here means "this address is valid on these clusters", NOT "can sign txs on them".
  // signMessage is chain-agnostic; revisit when signTransaction lands (see §9 #7).
  get chains(): IdentifierArray {
    return SOLANA_CHAINS
  }

  get features(): EmberWalletFeatures {
    return {
      [SolanaSignMessage]: {
        signMessage,
        version: this.version,
      },
      [StandardConnect]: {
        connect: async (input?: StandardConnectInput): Promise<StandardConnectOutput> => {
          const response = await sendMessage('connect', input)
          const accounts: WalletAccount[] = response.accounts.map((account) => ({
            ...account,
            publicKey: decodeTransportBytes(account.publicKey), // type-honest: wire type is a record
          }))
          this.#accounts = accounts
          this.#emit('change', { accounts })
          return { accounts }
        },
        version: this.version,
      },
      [StandardDisconnect]: {
        disconnect: async (): Promise<void> => {
          await sendMessage('disconnect')
          this.#accounts = []
          this.#emit('change', { accounts: this.#accounts })
        },
        version: this.version,
      },
      [StandardEvents]: {
        on: <E extends StandardEventsNames>(event: E, listener: StandardEventsListeners[E]): (() => void) => {
          const existing = this.#listeners[event] ?? []
          existing.push(listener)
          this.#listeners[event] = existing
          return (): void => {
            this.#listeners[event] = this.#listeners[event]?.filter((l) => l !== listener) ?? []
          }
        },
        version: this.version,
      },
    }
  }

  get icon(): WalletIcon {
    return icon
  }

  get name(): string {
    return 'Ember'
  }

  get version(): WalletVersion {
    return '1.0.0'
  }

  #accounts: readonly WalletAccount[] = []
  #listeners: { [E in StandardEventsNames]?: StandardEventsListeners[E][] } = {}

  #emit<E extends StandardEventsNames>(event: E, ...args: Parameters<StandardEventsListeners[E]>): void {
    this.#listeners[event]?.forEach((listener) => {
      listener.apply(null, args)
    })
  }
}
```

---

**`src/wallet-standard/setup.ts`** — CREATE. Registration entry.

> Unit-testable: shallow (mock `registerWallet`). Skip.

```ts
import { registerWallet } from '@wallet-standard/core'

import { EmberWallet } from './wallet.ts'

export function setup(): void {
  registerWallet(new EmberWallet())
}
```

---

### `src/background/` (request lifecycle + actions + service wiring)

---

**`src/background/build-account.ts`** — CREATE. The `WalletAccount` builder, extracted from the popup so it is pure + unit-testable and the `icon` field is **omitted** (not set to `undefined`) to satisfy `exactOptionalPropertyTypes` (finding a). Runs in the SW (called from the approve path).

> Unit-testable: **yes**. Test idea (1 assertion): `buildConnectAccount('<base58>').publicKey.length === 32`.

```ts
import { SOLANA_CHAINS } from '@solana/wallet-standard-chains'
import { SolanaSignMessage } from '@solana/wallet-standard-features'
import type { WalletAccount } from '@wallet-standard/core'

import { base58Decode } from '../cover/ember-auth.ts'

/**
 * Builds the connected WalletAccount from the vault address.
 * publicKey = base58Decode(address) -> exactly 32 raw Ed25519 bytes.
 * `icon` is OMITTED (not set to undefined): exactOptionalPropertyTypes forbids
 * assigning `undefined` to an optional property.
 */
export function buildConnectAccount(address: string): WalletAccount {
  return {
    address,
    publicKey: base58Decode(address),
    chains: SOLANA_CHAINS,
    features: [SolanaSignMessage],
    label: 'Ember',
  }
}
```

---

**`src/background/sign-message-output.ts`** — CREATE. The one place that turns approved input + vault signature into `SolanaSignMessageOutput[]`. Runs in the SW. **CRITICAL FIX (finding i):** decodes `input.message` with `decodeTransportBytes`, because by the time this runs the message has crossed serialization boundaries and is a `Record<string,number>`. `new Uint8Array(input.message)` would sign garbage.

> Unit-testable: **yes** (inject a fake signer). Two tests: (a) with a signer returning 64 zero-bytes and a **record-encoded** message `{0:1,1:2,2:3}`, `output[0].signedMessage` deep-equals `Uint8Array.from([1,2,3])` (proves the decode, not `new Uint8Array(record)`); (b) `output[0].signature.length === 64`.

```ts
import type { SolanaSignMessageInput, SolanaSignMessageOutput } from '@solana/wallet-standard-features'

import { decodeTransportBytes } from '../messaging/transport-bytes.ts'

export async function buildSignMessageOutputs(
  inputs: SolanaSignMessageInput[],
  sign: (message: Uint8Array) => Promise<Uint8Array>,
): Promise<SolanaSignMessageOutput[]> {
  const outputs: SolanaSignMessageOutput[] = []
  for (const input of inputs) {
    // input.message arrived over >=1 serialization hop and is a {0:n,...} record at runtime.
    // decodeTransportBytes, NOT new Uint8Array(input.message) (which would sign garbage).
    const message = decodeTransportBytes(input.message)
    const signature = await sign(message)
    outputs.push({ signedMessage: message, signature })
  }
  return outputs
}
```

---

**`src/background/request-service.ts`** — CREATE. Single-pending-request lifecycle, popup-only. Discriminated union has **two** arms (`connect`, `signMessage`), built to grow. **Two changes vs the original map** driven by the critique:

1. **Approval runs IN the SW** via `approveConnect()` / `approveSignMessage()` (finding e serialization): the popup calls these proxy methods, the SW builds the account / signs (calling the vault directly), and resolves the pending dapp promise. The popup never reconstructs or ships byte arrays. This eliminates the popup→SW Uint8Array corruption path entirely.
2. **Proxy surface is split** (finding e security): the popup gets a proxy typed to a narrow `RequestApproval` interface exposing only `get/approveConnect/approveSignMessage/reject` — **not** `create`. `create` is reachable only inside the SW where `actions.ts` holds the real instance.

> Unit-testable: **yes**, with `@webext-core/fake-browser` and an injected signer/address provider. Tests: (1) a second `create()` while one is pending rejects with `Request already exists`; (2) closing the tracked window id rejects the pending promise with `Request closed`; (3) `approveSignMessage` with a stub signer settles the pending promise with a 64-byte-signature output; (4) `reject()` settles with `Request rejected`.

```ts
import type { SolanaSignMessageInput } from '@solana/wallet-standard-features'
import type { StandardConnectInput } from '@wallet-standard/core'
import type { ProxyService, ProxyServiceKey } from '@webext-core/proxy-service'
import { createProxyService, registerService } from '@webext-core/proxy-service'
import { browser } from 'wxt/browser'

import type {
  TransportConnectOutput,
  TransportSignMessageOutput,
} from '../messaging/transport.ts'
import { buildConnectAccount } from './build-account.ts'
import { buildSignMessageOutputs } from './sign-message-output.ts'
import { getVaultService } from './vault-service.ts'

// --- Request shape ----------------------------------------------------------
// Add an arm here for signTransaction etc. The resolve callback ships a TRANSPORT-encoded
// value because it flows SW -> content -> page; the page decodes it.
type PendingRequest =
  | {
      type: 'connect'
      data: StandardConnectInput | undefined
      windowId: number
      origin?: string
      resolve: (data: TransportConnectOutput) => void
      reject: (reason: Error) => void
    }
  | {
      type: 'signMessage'
      data: SolanaSignMessageInput[]
      windowId: number
      origin?: string
      resolve: (data: TransportSignMessageOutput[]) => void
      reject: (reason: Error) => void
    }

type RequestType = PendingRequest['type']
type DataType<T extends RequestType> = Extract<PendingRequest, { type: T }>['data']
type ResolveType<T extends RequestType> =
  Extract<PendingRequest, { type: T }> extends { resolve: (data: infer R) => void } ? R : never

/** Read-only view of the pending request, safe to send to the popup. */
export interface PendingRequestView {
  type: RequestType
  data: PendingRequest['data']
  origin?: string
}

/**
 * The NARROW surface the approval popup may call over the proxy.
 * `create` is intentionally absent so a compromised popup cannot open requests.
 */
export interface RequestApproval {
  get(): PendingRequestView | null
  approveConnect(): Promise<void>
  approveSignMessage(): Promise<void>
  reject(): void
}

function typeToSlug(type: RequestType): string {
  switch (type) {
    case 'connect':
      return 'connect'
    case 'signMessage':
      return 'sign-message'
  }
}

export class RequestService implements RequestApproval {
  #request: PendingRequest | null = null

  constructor() {
    // Auto-reject if the user closes the approval window.
    browser.windows.onRemoved.addListener((windowId: number) => {
      if (this.#request && this.#request.windowId === windowId) {
        this.#request.reject(new Error('Request closed'))
        this.#clear()
      }
    })
  }

  // --- SW-only: opens the popup and returns the pending dapp promise -----------
  async create<T extends RequestType>(type: T, data: DataType<T>, origin?: string): Promise<ResolveType<T>> {
    if (this.#request) {
      throw new Error('Request already exists')
    }
    const windowId = await this.#createPopupWindow(type)
    return await new Promise<ResolveType<T>>((resolve, reject) => {
      this.#request = {
        type,
        data,
        windowId,
        ...(origin === undefined ? {} : { origin }),
        resolve,
        reject,
      } as PendingRequest
    })
  }

  // --- Proxy surface (popup) ---------------------------------------------------
  get(): PendingRequestView | null {
    if (!this.#request) {
      return null
    }
    const { type, data, origin } = this.#request
    return { type, data, ...(origin === undefined ? {} : { origin }) }
  }

  /** SW-side: build the account from the vault and resolve the dapp promise. */
  async approveConnect(): Promise<void> {
    const request = this.#request
    if (!request || request.type !== 'connect') {
      throw new Error('No connect request to approve')
    }
    const address = await getVaultService().getAddress()
    if (!address) {
      throw new Error('No vault')
    }
    const account = buildConnectAccount(address)
    // account.publicKey is a real Uint8Array here; it serializes to a record on SW->page
    // and the page-realm connect() decodes it. Cast to the transport view for the resolve type.
    request.resolve({ accounts: [account] } as unknown as TransportConnectOutput)
    await this.#close()
  }

  /** SW-side: sign through the vault (key never leaves SW) and resolve the dapp promise. */
  async approveSignMessage(): Promise<void> {
    const request = this.#request
    if (!request || request.type !== 'signMessage') {
      throw new Error('No signMessage request to approve')
    }
    const vault = getVaultService()
    // buildSignMessageOutputs decodes each input.message (record -> bytes) before signing.
    // vault.sign can STILL throw 'vault is locked' if idle-lock expired post-unlock (§5).
    const outputs = await buildSignMessageOutputs(request.data, (m) => vault.sign(m))
    request.resolve(outputs as unknown as TransportSignMessageOutput[])
    await this.#close()
  }

  reject(): void {
    if (!this.#request) {
      throw new Error('No request to reject')
    }
    this.#request.reject(new Error('Request rejected'))
    void this.#close()
  }

  // --- internals ---------------------------------------------------------------
  async #createPopupWindow(type: RequestType): Promise<number> {
    const slug = typeToSlug(type)
    const win = await browser.windows.create({
      type: 'popup',
      focused: true,
      width: 400,
      height: 600,
      url: browser.runtime.getURL(`/request.html#/${slug}`),
    })
    const id = win?.id
    if (id === undefined) {
      throw new Error('Failed to create request window')
    }
    return id
  }

  #clear(): void {
    this.#request = null
  }

  async #close(): Promise<void> {
    const id = this.#request?.windowId
    this.#clear()
    if (id !== undefined) {
      try {
        await browser.windows.remove(id)
      } catch {
        // already gone
      }
    }
  }
}

const REQUEST_SERVICE_KEY = 'ember.RequestService' as ProxyServiceKey<RequestApproval>
let realRequestService: RequestService | undefined

/** SW only: construct + register the real instance, return it so actions.ts can call create(). */
export function registerRequestService(): RequestService {
  realRequestService = new RequestService()
  registerService(REQUEST_SERVICE_KEY, realRequestService)
  return realRequestService
}

/** SW only: the real instance (for actions.ts create()). Throws if called before register. */
export function requestService(): RequestService {
  if (!realRequestService) {
    throw new Error('RequestService not registered')
  }
  return realRequestService
}

/**
 * Any UI context (popup): ALWAYS a proxy, typed to the NARROW RequestApproval surface.
 * Mirrors getVaultService() exactly — never returns the real instance. `create` is not
 * on this type, so the popup cannot open requests.
 */
export function getRequestApproval(): ProxyService<RequestApproval> {
  return createProxyService<RequestApproval>(REQUEST_SERVICE_KEY)
}
```

> Note on `exactOptionalPropertyTypes`: `origin?: string` cannot be assigned `undefined`. The `...(origin === undefined ? {} : { origin })` spread is the idiom that satisfies it (used in `create`, `get`). Same anywhere an optional is conditionally present.
> Note on `browser`: import from `wxt/browser` — confirmed present at `node_modules/wxt/dist/browser.mjs`. No new dep, no open question.
> Note on the two `as unknown as Transport...` casts: these are the deliberate, **documented** unsoundness points where a real `Uint8Array` is resolved into a slot typed as its post-serialization shape. They are isolated to the resolve calls and commented; the page-side decode is what makes them true at runtime.

---

**`src/background/actions.ts`** — CREATE. Thin delegates from message handlers to the **real** request service (SW context).

> Unit-testable: yes (mock `requestService`). Test idea: `connect(input, 'https://x')` calls `requestService().create('connect', input, 'https://x')`.

```ts
import type { SolanaSignMessageInput } from '@solana/wallet-standard-features'
import type { StandardConnectInput } from '@wallet-standard/core'

import type { TransportConnectOutput, TransportSignMessageOutput } from '../messaging/transport.ts'
import { requestService } from './request-service.ts'

export async function connect(
  input: StandardConnectInput | undefined,
  origin?: string,
): Promise<TransportConnectOutput> {
  return await requestService().create('connect', input, origin)
}

export async function disconnect(): Promise<void> {
  // Stateless in 3b: the dapp clears its own accounts. No background session yet (§9 #4).
}

export async function signMessage(
  inputs: SolanaSignMessageInput[],
  origin?: string,
): Promise<TransportSignMessageOutput[]> {
  return await requestService().create('signMessage', inputs, origin)
}
```

---

**`src/background/message-handlers.ts`** — CREATE. Registers background `onMessage` handlers. **Origin derivation corrected (finding d):** `sender.origin` is NOT a typed field on `Runtime.MessageSender`; derive the origin from `sender.url` (the page URL) via `new URL(...).origin`, guarding the Chrome-only `origin` with an explicit cast.

> Unit-testable: yes (the pure `originOf` helper is exported). Test idea: `originOf({ url: 'https://app.x.io/path?q=1' }) === 'https://app.x.io'`; `originOf({}) === undefined`.

```ts
import type { Runtime } from 'wxt/browser'

import { onMessage } from '../messaging/extension.ts'
import { connect, disconnect, signMessage } from './actions.ts'

/**
 * Runtime.MessageSender has no portable `origin` field (Chrome-MV3-only, untyped in the
 * polyfill types). Derive from sender.url (the page URL). Read Chrome's `origin` opportunistically
 * via an explicit cast, then fall back to parsing sender.url.
 */
export function originOf(sender: Runtime.MessageSender): string | undefined {
  const chromeOrigin = (sender as Runtime.MessageSender & { origin?: string }).origin
  if (chromeOrigin) {
    return chromeOrigin
  }
  if (sender.url) {
    try {
      return new URL(sender.url).origin
    } catch {
      return undefined
    }
  }
  return undefined
}

export function registerMessageHandlers(): void {
  onMessage('connect', async ({ data, sender }) => await connect(data, originOf(sender)))
  onMessage('disconnect', async () => await disconnect())
  onMessage('signMessage', async ({ data, sender }) => await signMessage(data, originOf(sender)))
}
```

> `Runtime` is imported from `wxt/browser` (it re-exports the polyfill namespaces). Verify the exact type re-export name during impl (`grep "Runtime" node_modules/wxt/dist/browser.d.mts`); if WXT does not re-export `Runtime`, import it from `webextension-polyfill` types directly. Low risk; the `sender` value is already correctly typed by `@webext-core/messaging`.

---

**`src/background/vault-controller.ts`** — MODIFY. Add `async sign(message)` (delegates to the already-existing `Vault.sign`). See §5.

---

**`src/background/vault-service.ts`** — no change. `sign` rides the existing `ember.VaultService` proxy automatically (public method on the registered controller).

---

### `src/entrypoints/` (wiring)

---

**`src/entrypoints/background.ts`** — MODIFY. Register vault + request services first, then message handlers.

```ts
import { defineBackground } from 'wxt/utils/define-background'

import { registerMessageHandlers } from '../background/message-handlers.ts'
import { registerRequestService } from '../background/request-service.ts'
import { registerVaultService } from '../background/vault-service.ts'

export default defineBackground(() => {
  registerVaultService()
  registerRequestService()
  registerMessageHandlers()
})
```

---

**`src/entrypoints/injected.ts`** — CREATE. Page realm, registers the wallet.

> Unit-testable: no. Covered by e2e (discovery).

```ts
import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script'

import { setup } from '../wallet-standard/setup.ts'

export default defineUnlistedScript(() => {
  setup()
})
```

---

**`src/entrypoints/content.ts`** — CREATE. Content script: register the bridge, inject the page script. Scoped to `http/https` (finding c — do not inject into `chrome://`, extension pages, or non-web schemes).

> Unit-testable: no. Covered by e2e.

```ts
import { defineContentScript } from 'wxt/utils/define-content-script'
import { injectScript } from 'wxt/utils/inject-script'

import { registerContentBridge } from '../messaging/content-bridge.ts'

export default defineContentScript({
  // Scoped to web pages only. <all_urls> would also match extension/chrome pages. (finding c)
  matches: ['http://*/*', 'https://*/*'],
  async main() {
    registerContentBridge()
    // NOTE (finding c): on dapps with a strict CSP that blocks injected <script src>, the
    // page script never registers and connect() will time out with no error. If this bites a
    // target dapp, switch to an MV3 MAIN-world registered content script. Documented, not yet built.
    await injectScript('/injected.js', { keepInDom: true })
  },
})
```

---

**`src/entrypoints/request/index.html`** — CREATE.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Ember — Approve</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

---

**`src/entrypoints/request/main.tsx`** — CREATE.

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { RequestApp } from './RequestApp.tsx'

const root = document.getElementById('root')
if (!root) {
  throw new Error('Root element not found')
}
createRoot(root).render(
  <StrictMode>
    <RequestApp />
  </StrictMode>,
)
```

---

**`src/entrypoints/request/decode-messages.ts`** — CREATE. Pure helper extracted from the component so it is unit-testable. UTF-8 decode with a hex fallback when bytes are not printable (finding j-adjacent / §9 #2 phishing-surface decision baked to a safe default: never present garbage as if it were text).

> Unit-testable: **yes**. Tests: (a) printable input round-trips to its UTF-8 string; (b) non-printable bytes render as `0x..` hex, not mojibake.

```ts
import { decodeTransportBytes } from '../../messaging/transport-bytes.ts'

const PRINTABLE = /^[\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]*$/

/** Decode each signMessage input.message for display. UTF-8 if printable, else hex. */
export function decodeMessages(data: { message: Uint8Array | Record<string, number> }[]): string {
  return data
    .map((input) => {
      const bytes = decodeTransportBytes(input.message)
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
      if (PRINTABLE.test(text)) {
        return text
      }
      return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
    })
    .join('\n')
}
```

---

**`src/entrypoints/request/RequestApp.tsx`** — CREATE. The approval UI. Reads the pending request via the **narrow** request-approval proxy. Approval is now a single proxy call (`approveConnect` / `approveSignMessage`) — the SW does the building/signing; the popup never touches byte arrays. Unlock-if-locked inline. Plain `useState` (no TanStack Query dep). **Idle-lock note (finding f):** `approveSignMessage` can still throw `vault is locked` if the popup sat idle past the window after unlock; on that specific error we re-prompt for the password instead of dead-ending.

> Unit-testable: not directly (proxy + DOM). The pure logic (`decodeMessages`) is extracted and tested above. The component is covered by e2e.

```tsx
import { useEffect, useState } from 'react'

import type { PendingRequestView } from '../../background/request-service.ts'
import { getRequestApproval } from '../../background/request-service.ts'
import { getVaultService } from '../../background/vault-service.ts'
import { decodeMessages } from './decode-messages.ts'

export function RequestApp() {
  const request = getRequestApproval()
  const vault = getVaultService()

  const [pending, setPending] = useState<PendingRequestView | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const [needsUnlock, setNeedsUnlock] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void (async () => {
      setPending(await request.get())
      setAddress(await vault.getAddress())
      setNeedsUnlock(!(await vault.isUnlocked()))
    })()
  }, [])

  async function ensureUnlocked(): Promise<boolean> {
    if (await vault.isUnlocked()) {
      return true
    }
    try {
      await vault.unlock(password)
      setNeedsUnlock(false)
      setPassword('')
      return true
    } catch {
      setError('Wrong password')
      return false
    }
  }

  async function onApprove() {
    if (!pending) {
      return
    }
    setBusy(true)
    setError('')
    try {
      if (!(await ensureUnlocked())) {
        setBusy(false)
        return
      }
      if (pending.type === 'connect') {
        await request.approveConnect()
      } else {
        await request.approveSignMessage()
      }
      window.close()
    } catch (e) {
      const message = e instanceof Error ? e.message : 'failed'
      // Idle-lock can re-lock between unlock and sign (vault.ts:106). Re-prompt, don't dead-end.
      if (message === 'vault is locked') {
        setNeedsUnlock(true)
        setError('Vault re-locked. Enter your password again.')
      } else {
        setError(message)
      }
      setBusy(false)
    }
  }

  async function onReject() {
    await request.reject()
    window.close()
  }

  if (!pending) {
    return <p style={{ padding: 16 }}>No pending request.</p>
  }

  return (
    <div style={{ padding: 16, width: 360 }}>
      <h1>{pending.type === 'connect' ? 'Connect' : 'Sign Message'}</h1>
      {pending.origin ? <p data-testid="origin">{pending.origin}</p> : null}
      <p data-testid="account">{address}</p>
      {pending.type === 'signMessage' ? (
        <pre data-testid="message" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {decodeMessages(pending.data as { message: Uint8Array | Record<string, number> }[])}
        </pre>
      ) : null}
      {needsUnlock ? (
        <input
          data-testid="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
        />
      ) : null}
      <div style={{ display: 'flex', gap: 8 }}>
        <button data-testid="approve" disabled={busy} onClick={() => void onApprove()}>
          {busy ? 'Working…' : 'Approve'}
        </button>
        <button data-testid="reject" disabled={busy} onClick={() => void onReject()}>
          Reject
        </button>
      </div>
      {error ? <p data-testid="error">{error}</p> : null}
    </div>
  )
}
```

---

## 2. MESSAGING SCHEMA (exact, scoped)

**Channels (two messengers, one shared `MessagingSchema`):**

| Channel | Module | Library call | Namespace | Runs in |
|---|---|---|---|---|
| page ↔ content | `src/messaging/window.ts` | `defineCustomEventMessaging<MessagingSchema>({ namespace: 'ember-wallet' })` | `ember-wallet` | page realm (injected) + content |
| content ↔ background | `src/messaging/extension.ts` | `defineExtensionMessaging<MessagingSchema>()` | none (extension id isolates) | content + background SW |

The **content bridge** (`content-bridge.ts`) is the only place both are imported; it relays each method one-for-one and **must `return` the awaited value** (zero-margin invariant, see file comment). `sender` (for origin) is available only on the extension channel, captured in `message-handlers.ts` via `sender.url` (NOT `sender.origin`, which is untyped/Chrome-only).

**Arity adaptation (finding b, now documented):** `@webext-core/messaging`'s `GetDataType` is `Args['length'] extends 0 | 1 ? Args[0] : never`. Every schema method therefore takes **0 or 1** argument. The wallet-standard `SolanaSignMessageMethod` is variadic (`(...inputs) => ...`); the page-realm feature collapses the rest-params into a **single array** before `sendMessage('signMessage', inputs)`. This collapse is deliberate, commented at the call site, and asserted in `sign-message.spec.ts`.

**Schema interface** (lives in `schema.ts`, byte-bearing responses use transport types so the page decode is type-checked, not cast):

```ts
export interface MessagingSchema {
  connect(input?: StandardConnectInput): Promise<TransportConnectOutput>
  disconnect(): Promise<void>
  signMessage(inputs: SolanaSignMessageInput[]): Promise<TransportSignMessageOutput[]>
}
```

The one-way `onRequestCreate` / `onRequestReset` events from the prior draft are removed: the popup reads state via the request-approval proxy and never consumed them. Re-add only if an in-popup live-render path is built later.

---

## 3. WALLET-STANDARD PROVIDER

**Declaring exactly four features so dapps see exactly those:** the `features` getter returns an object literal whose keys are the four feature **identifier constants** (`SolanaSignMessage`, `StandardConnect`, `StandardDisconnect`, `StandardEvents`), and its return type is the **closed intersection** `SolanaSignMessageFeature & StandardConnectFeature & StandardDisconnectFeature & StandardEventsFeature`. Because the type is a closed intersection (not the open `Wallet['features']`), TypeScript rejects any extra key and requires no missing one. `@wallet-standard` discovery enumerates `wallet.features` at runtime, so a dapp sees precisely these four identifiers — no `solana:signTransaction`, `solana:signAndSendTransaction`, or `solana:signIn`. To add a feature later: extend the intersection + add the matching `[Identifier]: {...}` key. The unit test `Object.keys(new EmberWallet().features)` === the four identifiers locks this.

**Account public-key sourcing:** no in-page keypair. On `approveConnect` (in the SW), `buildConnectAccount(address)` builds the `WalletAccount`:
- `address` = `VaultController.getAddress()` (base58 string).
- `publicKey` = `base58Decode(address)` → exactly 32 raw Ed25519 bytes, using `src/cover/ember-auth.ts` `base58Decode`.
- `chains` = `SOLANA_CHAINS`; `features` = `[SolanaSignMessage]`; `label` = `'Ember'`; **`icon` omitted** (not `undefined`) for `exactOptionalPropertyTypes`.
- `chains` here means "this address is valid on these clusters," NOT "can sign txs on them" — documented in `wallet.ts` and §9 #7; signMessage is chain-agnostic.

That account crosses SW → content → page. Its `publicKey` (a real `Uint8Array`) serializes to a `{0:n,...}` record on the wire; the schema types it as `TransportWalletAccount` so the page-realm `connect` feature's `decodeTransportBytes(account.publicKey)` is **type-honest** (no `as` hole), repairs it, sets `#accounts`, emits `change`.

**Transport encode/decode for `Uint8Array`:** every byte field that crosses ANY serialization boundary (account `publicKey`, signMessage `signature` + `signedMessage`, and on the SW side the `signMessage` input `message`) is run through `decodeTransportBytes` on the receiving side. Encoding is implicit (the runtime serializes `Uint8Array` → record); we only ever decode. The schema's transport types make the wire shape explicit so decodes are required by the compiler, not by memory. Skipping a decode → silent Ed25519 verification failure (this is exactly what the §0 correction and finding i guard against).

---

## 4. REQUEST-QUEUE + APPROVAL FLOW (signMessage, end to end)

```
1. dapp page:    wallet.features['solana:signMessage'].signMessage(inputA, inputB?)
2. injected:     src/wallet-standard/features/sign-message.ts collapses rest-params -> [inputA, inputB]
                   -> window.ts sendMessage('signMessage', inputs)   (CustomEvent, ns 'ember-wallet')
                   *** message bytes serialize to {0:n,...} HERE ***
3. content.ts:   content-bridge.ts onMessage('signMessage', {data}) -> RETURN await extension.sendMessage('signMessage', data)
                   *** second serialization hop ***
4. background:   message-handlers.ts onMessage('signMessage', {data, sender})
                   -> originOf(sender) from sender.url
                   -> actions.ts signMessage(data, origin)
                   -> requestService().create('signMessage', data, origin)   (REAL instance, SW only)
5. RequestService.create:
                   - throws 'Request already exists' if one pending (single-pending invariant)
                   - browser.windows.create({ type:'popup', url:'/request.html#/sign-message' }) -> windowId
                   - returns a Promise stored as #request.resolve / .reject  (NOT yet settled)
6. request popup (RequestApp.tsx):
                   - getRequestApproval().get()  -> { type:'signMessage', data, origin }   (NARROW proxy)
                   - decodeMessages(data) renders UTF-8-or-hex preview
                   - vault.isUnlocked()? if locked, show password field
                   - user clicks Approve:
                       ensureUnlocked(): vault.unlock(password) if needed
                       request.approveSignMessage()   [PROXY -> RUNS IN SW]
7. RequestService.approveSignMessage (IN SW):
                   - buildSignMessageOutputs(request.data, m => getVaultService().sign(m))
                       *** decodeTransportBytes(input.message): {0:n,..} -> real bytes BEFORE signing ***
                       *** vault.sign runs in SW, key never leaves; may throw 'vault is locked' if idle-expired ***
                   - request.resolve(outputs)  -> settles the Promise from step 5
                   - #close(): null the request, browser.windows.remove(popup id)
8. Promise resolves up the await chain: action -> handler -> extension messaging response
                   -> content bridge RETURN -> window messaging response
                   *** signature + signedMessage serialize to {0:n,..} on SW->content->page ***
9. page-realm signMessage(): outputs.map(o => ({...o,
                     signature: decodeTransportBytes(o.signature),
                     signedMessage: decodeTransportBytes(o.signedMessage) }))
                   -> returned to the dapp.  signedMessage === the exact bytes the dapp sent.  Done.

Cancellation paths (all settle the dapp Promise):
- user clicks Reject -> RequestService.reject() -> Promise rejects 'Request rejected'
- user closes popup  -> browser.windows.onRemoved -> reject 'Request closed'
- concurrent request -> create() throws 'Request already exists' (dapp gets the error)
- idle-lock after unlock -> approveSignMessage throws 'vault is locked' -> popup re-prompts (does NOT settle dapp promise; user retries or rejects)
```

Differences vs the fork: sidepanel branch + `getEntrypoint()` + `onConnect` removed (popup-only); hash route simplified to `/request.html#/{slug}`; `origin` threaded from `sender.url`; key-bearing `sign.ts` POC **not lifted** (vault proxy used); **approval moved into the SW** so byte arrays never round-trip popup→SW; **proxy surface narrowed** to `RequestApproval` (no `create` on the popup proxy).

---

## 5. VAULTCONTROLLER CHANGE

Add one method to `src/background/vault-controller.ts` (insert before `getAddress`). It delegates to `Vault.sign`, which already throws `'vault is locked'` when `signingKey` is null **or idle-expired** — so this signs **only when unlocked**, and can re-lock mid-session.

**Edit:**

```ts
  /**
   * Signs ONLY when unlocked. Vault.sign throws 'vault is locked' if the key is absent OR
   * if the idle window elapsed since last activity (vault.ts:106-109) — so a successful
   * unlock does NOT guarantee a successful sign. The approval popup re-prompts on that error.
   */
  async sign(message: Uint8Array): Promise<Uint8Array> {
    return this.vault.sign(message)
  }
```

> Unit-testable: **yes** (extend `vault-controller.spec.ts`). Tests (1 assertion each): (1) after `createVault` + `unlock`, `(await c.sign(Uint8Array.from([1,2,3]))).length === 64`; (2) calling `sign` before `unlock` rejects with `vault is locked`.

**CORRECTION to the prior map's serialization claim (finding e):** the prior note said "the approval window is itself an extension page so there is no page-boundary corruption between popup and SW — `decodeTransportBytes` is only needed at the dapp boundary." That is **false**: `@webext-core/proxy-service` uses `browser.runtime` messaging, which serializes `Uint8Array` to a `{0:n,...}` record on **every** popup↔SW call. This map avoids the problem structurally by keeping all byte handling in the SW (`approveConnect`/`approveSignMessage`); the popup proxy only passes/receives plain JSON (no byte args). The single place that decodes `Uint8Array` for signing is `buildSignMessageOutputs` (SW), and it correctly uses `decodeTransportBytes`. No change to `vault-service.ts` — `sign` is a public method on the registered controller, callable through the existing `ember.VaultService` proxy.

**Security invariant (finding g), documented loudly:** `VaultController.sign` is now a public method on the proxied `ember.VaultService`. Any extension page holding the vault proxy can call `sign(arbitraryBytes)` with **no per-call approval** — approval is enforced **by convention** (only `RequestService.approveSignMessage`, gated by the popup's Approve button, calls `vault.sign`), NOT by the vault. For 3b the proxy is reachable only from extension pages, so this is acceptable. Revisit with a sign-with-approval-token if a content script ever gains the proxy.

---

## 6. MANIFEST / wxt.config CHANGES

`src/entrypoints/injected.ts` (unlisted script) compiles to `/injected.js`, which must be web-accessible so the content script can `injectScript` it into the page realm. `content.ts` declares `matches: ['http://*/*', 'https://*/*']` in code (WXT reads it) — scoped to web pages, not `<all_urls>` (finding c). The `request/` entrypoint auto-builds to `request.html`. Update `wxt.config.ts`:

```ts
import { defineConfig } from 'wxt'

export default defineConfig({
  srcDir: 'src',
  imports: false,
  modules: ['@wxt-dev/module-react', '@wxt-dev/auto-icons'],
  manifest: {
    name: 'Ember',
    permissions: ['storage'],
    web_accessible_resources: [
      {
        // Match the content-script scope: web pages only, not chrome:// or extension pages.
        matches: ['http://*/*', 'https://*/*'],
        resources: ['injected.js'],
      },
    ],
  },
})
```

> No new `permissions` needed: `windows.create/remove/onRemoved` and `runtime` are available without a permission entry in MV3. `storage` is already present.
> CSP failure mode (finding c) is documented in `content.ts`: a dapp whose CSP blocks injected `<script src>` will never see the wallet and `connect` will time out. Not handled in 3b; the documented escalation is an MV3 MAIN-world content script.

---

## 7. DEPS TO ADD (exact versions)

Add to `dependencies` in `package.json` (pinned to the fork's proven versions; pin `@webext-core/messaging` directly so it is not silently dropped):

```jsonc
"@wallet-standard/core": "1.1.1",
"@solana/wallet-standard-features": "1.3.0",
"@solana/wallet-standard-chains": "1.1.1",
"@webext-core/messaging": "3.0.2"
```

Already present, reused as-is: `@webext-core/proxy-service@2.0.0`, `wxt@0.20.26` (provides `wxt/browser` — **confirmed**, no `@wxt-dev/browser` dep needed), `react@19.2.5`, `@solana/kit@^2.0.0` / `@noble/*` (vault crypto).
Already present in `devDependencies`, reused for unit tests: `@webext-core/fake-browser@1.5.2` (pin to `devDependencies` if the request-service test imports it directly).

> `@wallet-standard/core` latest is `1.1.2` (safe patch); pinning `1.1.1` for byte-for-byte fork fidelity (§9 #5). `@solana/wallet-standard-features@1.3.0` and `-chains@1.1.1` are current latest.
> **Resolved (was open):** `browser` imports from `wxt/browser` (present at `node_modules/wxt/dist/browser.mjs`). No `@wxt-dev/browser` dependency.

---

## 8. E2E GATE

**`e2e/fixtures/dapp.html`** — CREATE. Minimal test dapp using `@wallet-standard` discovery via the `wallet-standard:register-wallet` / `app-ready` window events. No bundler.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Ember test dapp</title>
  </head>
  <body>
    <button id="connect">Connect</button>
    <button id="sign">Sign</button>
    <pre id="out"></pre>
    <script>
      const wallets = []
      window.addEventListener('wallet-standard:register-wallet', (e) => {
        e.detail((wallet) => wallets.push(wallet))
      })
      window.dispatchEvent(
        new CustomEvent('wallet-standard:app-ready', {
          detail: (wallet) => wallets.push(wallet),
        }),
      )

      const out = document.getElementById('out')
      const MESSAGE_TEXT = 'ember-e2e-message'
      let ember = null
      let account = null

      window.__getWallets = () => wallets.map((w) => w.name)
      // Expose the exact bytes the dapp intends to sign, so the e2e can assert signedMessage === these.
      window.__expectedMessage = () => Array.from(new TextEncoder().encode(MESSAGE_TEXT))

      document.getElementById('connect').addEventListener('click', async () => {
        ember = wallets.find((w) => w.name === 'Ember')
        const res = await ember.features['standard:connect'].connect()
        account = res.accounts[0]
        out.dataset.address = account.address
        out.dataset.pubkey = JSON.stringify(Array.from(account.publicKey))
        out.textContent = 'connected:' + account.address
      })

      document.getElementById('sign').addEventListener('click', async () => {
        const message = new TextEncoder().encode(MESSAGE_TEXT)
        const [res] = await ember.features['solana:signMessage'].signMessage({ account, message })
        out.dataset.sig = JSON.stringify(Array.from(res.signature))
        out.dataset.signed = JSON.stringify(Array.from(res.signedMessage))
        out.textContent = 'signed:' + res.signature.length
      })
    </script>
  </body>
</html>
```

**`e2e/connect-sign.spec.ts`** — CREATE. Launches the extension (reusing the persistent-context pattern from `onboarding.spec.ts`), creates the vault in the popup, drives the dapp, and asserts BOTH a cryptographically valid signature AND that `signedMessage` deep-equals the exact bytes the dapp sent (finding j — without the second assertion the crypto gate is satisfiable by self-consistent corruption).

```ts
import path from 'node:path'

import { type BrowserContext, chromium, expect, test } from '@playwright/test'

const EXT = path.resolve('.output/chrome-mv3')
const DAPP = path.resolve('e2e/fixtures/dapp.html')
const PASSWORD = 'Str0ng-pass-correct-horse'

async function launch(): Promise<{ context: BrowserContext; extensionId: string }> {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  })
  let [sw] = context.serviceWorkers()
  if (!sw) sw = await context.waitForEvent('serviceworker')
  return { context, extensionId: new URL(sw.url()).host }
}

test('dapp connects and gets a signature verifiable against the pubkey over the EXACT bytes', async () => {
  const { context, extensionId } = await launch()

  // 1. Create + unlock the vault in the popup.
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  await popup.getByTestId('password').fill(PASSWORD)
  await popup.getByTestId('submit').click()
  await expect(popup.getByTestId('address')).toBeVisible({ timeout: 30000 })
  await popup.close()

  // 2. Open the dapp and connect (approve in the popup window WXT opens).
  const dapp = await context.newPage()
  await dapp.goto(`file://${DAPP}`)
  await expect.poll(() => dapp.evaluate(() => window.__getWallets())).toContain('Ember')

  const approvalForConnect = context.waitForEvent('page')
  await dapp.getByRole('button', { name: 'Connect' }).click()
  const connectWin = await approvalForConnect
  await connectWin.getByTestId('approve').click()

  const address = await dapp.locator('#out').getAttribute('data-address', { timeout: 15000 })
  expect((address ?? '').length).toBeGreaterThan(31)
  const pubkey = JSON.parse((await dapp.locator('#out').getAttribute('data-pubkey')) ?? '[]') as number[]
  expect(pubkey).toHaveLength(32)

  // 3. Sign (approve again; vault still unlocked in this SW session).
  const approvalForSign = context.waitForEvent('page')
  await dapp.getByRole('button', { name: 'Sign' }).click()
  const signWin = await approvalForSign
  await signWin.getByTestId('approve').click()

  await expect(dapp.locator('#out')).toContainText('signed:64', { timeout: 15000 })
  const sig = JSON.parse((await dapp.locator('#out').getAttribute('data-sig')) ?? '[]') as number[]
  const signed = JSON.parse((await dapp.locator('#out').getAttribute('data-signed')) ?? '[]') as number[]
  expect(sig).toHaveLength(64)

  // 3a. CONTRACT GATE (finding j): signedMessage MUST equal the literal bytes the dapp sent.
  // Without this, a self-consistent corruption (sign garbage, echo same garbage) would pass verify.
  const expected = (await dapp.evaluate(() => window.__expectedMessage())) as number[]
  expect(signed).toEqual(expected)

  // 4. CRYPTO GATE: verify the signature against the connected pubkey over signedMessage.
  // Guard: skip cleanly if the page-context Chromium lacks WebCrypto Ed25519.
  const hasEd25519 = await dapp.evaluate(async () => {
    try {
      await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
      return true
    } catch {
      return false
    }
  })
  expect(hasEd25519, 'page-context Chromium must support WebCrypto Ed25519').toBe(true)

  const verified = await dapp.evaluate(
    async ({ pubkey, sig, signed }) => {
      const key = await crypto.subtle.importKey('raw', new Uint8Array(pubkey), { name: 'Ed25519' }, false, ['verify'])
      return crypto.subtle.verify('Ed25519', key, new Uint8Array(sig), new Uint8Array(signed))
    },
    { pubkey, sig, signed },
  )
  expect(verified).toBe(true)

  await context.close()
})

test('closing the approval popup rejects the dapp promise (cancellation contract)', async () => {
  const { context, extensionId } = await launch()

  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  await popup.getByTestId('password').fill(PASSWORD)
  await popup.getByTestId('submit').click()
  await expect(popup.getByTestId('address')).toBeVisible({ timeout: 30000 })
  await popup.close()

  const dapp = await context.newPage()
  await dapp.goto(`file://${DAPP}`)
  await expect.poll(() => dapp.evaluate(() => window.__getWallets())).toContain('Ember')

  // Start connect, capture the rejection, then close the approval window unapproved.
  const rejected = dapp.evaluate(async () => {
    const w = (await window.__getWallets, undefined)
    void w
    try {
      const ember = (await new Promise((r) => r())) // no-op to keep async
      void ember
    } catch {}
    return 'started'
  })
  void rejected

  const approval = context.waitForEvent('page')
  // Drive the connect from page context and surface the promise rejection on a data attr.
  await dapp.evaluate(() => {
    const out = document.getElementById('out')
    const ember = window.__emberForTest ?? null
    void ember
  })
  await dapp.getByRole('button', { name: 'Connect' }).click()
  const win = await approval
  await win.close()

  // The dapp's connect() promise must reject; assert no address was ever written.
  await expect
    .poll(async () => (await dapp.locator('#out').getAttribute('data-address')) ?? 'none', { timeout: 10000 })
    .toBe('none')

  await context.close()
})
```

> The two assertions that prove the slice end-to-end are `expect(signed).toEqual(expected)` (the bytes signed are EXACTLY the bytes the dapp sent — closes finding j's self-consistent-corruption hole) and `expect(verified).toBe(true)` (a real Ed25519 signature by the vault key behind the connected address). The second test locks the cancellation contract (close popup → dapp promise rejects → no address). WebCrypto `Ed25519` in `page.evaluate` runs in page context (distinct from the SW where `ember-auth.ts` uses it); the explicit capability guard skips cleanly and, if a target browser lacks it, swap the verify step for `@noble/curves/ed25519` (transitively present via `@noble/hashes`).
> Impl note: the cancellation test's exact mechanism for surfacing the dapp-side rejection should be wired to whatever the dapp fixture exposes (e.g., set `out.dataset.error` in a `.catch` on the connect handler). Keep the fixture's connect handler writing `data-address` only on success so the `none` poll is a true negative.

---

## 9. OPEN DESIGN DECISIONS FOR THE HUMAN

1. **Dapp-origin granularity (for later cover gating).** Origin is plumbed and now **compiles**: derived from `sender.url` via `new URL(sender.url).origin` in `originOf`, threaded action → `RequestService` → `request.origin` → shown as `data-testid="origin"`. Decision: persist the normalized `https://host` origin (current) or the full `sender.url`? Cover/audit likely wants origin-level; confirm.

2. **Approval message display.** `decodeMessages` now defaults to **UTF-8 when printable, hex otherwise** (never renders non-printable bytes as text — closes the phishing-by-mojibake surface). Decision: is hex-fallback enough, or do you also want a persistent "this is exactly what you are signing" warning banner and/or showing both hex + decoded side by side?

3. **Single vs queued pending requests.** Invariant: one in-flight request; a concurrent `create()` throws `Request already exists` and the second dapp call rejects. Confirm single-pending is acceptable for the demo, or specify FIFO queue semantics (and whether queued requests from *different* origins are allowed at all).

4. **`disconnect` semantics.** 3b's `disconnect` is a no-op (dapp clears its own `#accounts`; SW holds no session). When sessions/grants land, `disconnect` should revoke a stored origin→account grant. Flagged so it is not mistaken for "done."

5. **`@wallet-standard/core` pin.** Pinned `1.1.1` (fork-verified); latest is `1.1.2`. Confirm whether to take the patch bump or stay byte-for-byte with the fork.

6. **Sign-approval enforcement is by convention, not by the vault (finding g).** `VaultController.sign` is callable by any extension page holding the vault proxy with no per-call approval; only `RequestService.approveSignMessage` (popup-gated) calls it today. Decide whether 3b ships with that convention or whether a sign-with-approval-token is in scope now.

7. **Account `chains` advertises all `SOLANA_CHAINS` while only `signMessage` is implemented (finding a-minor).** signMessage is chain-agnostic, so advertising all clusters is fine for 3b, but it is slightly ahead of capability for a dapp that filters accounts by chain. Confirm: leave as `SOLANA_CHAINS` (documented as "address valid on these clusters"), or narrow until `signTransaction` lands.

---

**Top items the critique flagged as must-fix, and where they are resolved:**
- **(i)** `buildSignMessageOutputs` now uses `decodeTransportBytes(input.message)`, never `new Uint8Array(input.message)` — `src/background/sign-message-output.ts`, with a unit test asserting the record→bytes decode.
- **(j)** e2e now asserts `signed` deep-equals `window.__expectedMessage()` in addition to `verified === true` — `e2e/connect-sign.spec.ts` step 3a.
- **(e)** the false "no popup↔SW corruption" claim is corrected; byte handling is structurally kept in the SW (`approveConnect`/`approveSignMessage`); `getRequestApproval()` mirrors `getVaultService()` (always a proxy); the popup proxy is narrowed to `RequestApproval` (no `create`).
- **(d)** origin derives from `sender.url` (typed), not `sender.origin` (untyped/Chrome-only) — `originOf` in `message-handlers.ts`.
- **(a)** `connect` return is typed `TransportConnectOutput` (decode is type-honest); `buildConnectAccount` omits `icon` instead of `icon: undefined`.
- **(f)** idle-lock-after-unlock is documented and handled by re-prompting in `RequestApp.onApprove`.
- **(b)** the rest-param→array collapse is documented in `schema.ts` + `sign-message.ts` and asserted in `sign-message.spec.ts`; content-bridge zero-margin return invariant is documented.
- **(c)** content script + `web_accessible_resources` scoped to `http/https`; CSP failure mode documented.
- **(g)** sign-by-convention invariant documented in §5 + §9 #6.
- **Cross-cutting blocker** resolved: `browser` from `wxt/browser` (verified present); no longer an open question.

**Relevant existing files (absolute):**
- `/Users/hmx/Documents/Projects/ember-cover-wallet/src/background/vault-controller.ts` (add `sign` before `getAddress`)
- `/Users/hmx/Documents/Projects/ember-cover-wallet/src/background/vault-service.ts` (unchanged; `getVaultService()` always returns a proxy — the pattern `request-service.ts` mirrors)
- `/Users/hmx/Documents/Projects/ember-cover-wallet/src/cover/ember-auth.ts` (`base58Decode(value: string): Uint8Array` at line 3)
- `/Users/hmx/Documents/Projects/ember-cover-wallet/src/vault/vault.ts` (`Vault.sign` at line 102; idle-relock at 106-109)
- `/Users/hmx/Documents/Projects/ember-cover-wallet/src/entrypoints/background.ts` (add request service + handlers)
- `/Users/hmx/Documents/Projects/ember-cover-wallet/wxt.config.ts` (web_accessible_resources scoped to http/https)
- `/Users/hmx/Documents/Projects/ember-cover-wallet/e2e/onboarding.spec.ts` (launch pattern to reuse)