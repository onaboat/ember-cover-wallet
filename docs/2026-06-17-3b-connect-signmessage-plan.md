# Dapp Connect + signMessage Implementation Plan (cover-wallet sub-project 3b of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use checkbox (`- [ ]`). The e2e (T8) is the real-runtime gate — not done until it passes in a real browser.

**Goal:** A dapp discovers the Ember wallet, **connects**, and gets a **message signed** through the vault, gated by an approval popup that unlocks if locked — proven by a Playwright e2e that cryptographically verifies the signature against the connected pubkey over the exact bytes sent.

**Architecture:** Page-realm wallet-standard provider → custom-event messaging → content bridge → extension messaging → background. The background holds the only key (3a's `VaultController`); a single-in-flight `RequestService` opens an approval window and, on Approve, signs **in the SW** and resolves the dapp promise. Uint8Array is transport-decoded at every serialization hop. **Sign is hardened**: never on any proxy; only invoked in-SW inside the gated approve path.

**Tech Stack:** `@wallet-standard/core@1.1.1`, `@solana/wallet-standard-features@1.3.0`, `@solana/wallet-standard-chains@1.1.1`, `@webext-core/messaging@3.0.2`, `@webext-core/proxy-service@2.0.0`, WXT 0.20.26, React 19, vitest + `@webext-core/fake-browser`, Playwright.

**Design (full code + rationale):** `docs/2026-06-17-3b-connect-signmessage-design.md`. Read its CONFIRMED-DECISIONS header first (hardened sign overrides §5/§9#6). Each task below cites the design section for its implementation code and adds the TDD test code + verification.

**Conventions:** strict tsconfig (`verbatimModuleSyntax` → `import type`; `.ts` local imports; `exactOptionalPropertyTypes` → conditional-spread optionals; `erasableSyntaxOnly` → no enums/param-properties); WXT helpers from explicit `wxt/utils/*` + `wxt/browser` (NOT `#imports`); run `bunx tsc --noEmit` + `bunx vitest run` per task; vitest already excludes `e2e/**`; commits left to the user.

---

## Task 0: Deps + manifest

**Files:** Modify `package.json`, `wxt.config.ts`.

- [ ] **Step 1:** `export PATH="$HOME/.bun/bin:$PATH"; bun add @wallet-standard/core@1.1.1 @solana/wallet-standard-features@1.3.0 @solana/wallet-standard-chains@1.1.1 @webext-core/messaging@3.0.2`
- [ ] **Step 2:** Add `web_accessible_resources` to `wxt.config.ts` manifest (design §6) — scoped to `http/https`, resource `injected.js`.
- [ ] **Step 3:** Verify: `bunx wxt build` ok; `bunx tsc --noEmit` clean; `bunx vitest run` → existing **44 pass**.

## Task 1: Transport decode + wire types

**Files:** Create `src/messaging/transport-bytes.ts` (+ spec), `src/messaging/transport.ts`, `src/messaging/schema.ts`. Code: design §1.

- [ ] **Step 1 (failing test)** `src/messaging/transport-bytes.spec.ts`:
```ts
import { expect, test } from 'vitest'

import { decodeTransportBytes } from './transport-bytes.ts'

test('reconstructs bytes from a serialized record', () => {
  expect(Array.from(decodeTransportBytes({ 0: 1, 1: 2, 2: 255 }))).toEqual([1, 2, 255])
})

test('passes through an already-typed array', () => {
  expect(Array.from(decodeTransportBytes(Uint8Array.from([1, 2, 255])))).toEqual([1, 2, 255])
})
```
- [ ] **Step 2:** run → fail. **Step 3:** implement `transport-bytes.ts` (design §1 verbatim). **Step 4:** run → 2 pass.
- [ ] **Step 5:** create `transport.ts` + `schema.ts` (design §1 verbatim, type-only). **Step 6:** `bunx tsc --noEmit` clean.

## Task 2: Messaging channels + content bridge

**Files:** Create `src/messaging/window.ts`, `src/messaging/extension.ts`, `src/messaging/content-bridge.ts`. Code: design §1. Wiring (no unit tests; e2e-covered).

- [ ] **Step 1:** create all three (design §1 verbatim). Note the content-bridge **zero-margin invariant** (each handler `return await sendMessage(...)`). **Step 2:** `bunx tsc --noEmit` clean; `bunx vitest run` → 46 still pass.

## Task 3: Wallet-standard provider

**Files:** Create `src/wallet-standard/icon.ts`, `src/wallet-standard/features/sign-message.ts` (+ spec), `src/wallet-standard/wallet.ts` (+ spec), `src/wallet-standard/setup.ts`. Code: design §1/§3.

- [ ] **Step 1 (failing tests)** `src/wallet-standard/features/sign-message.spec.ts`:
```ts
import { expect, test, vi } from 'vitest'

vi.mock('../../messaging/window.ts', () => ({
  sendMessage: vi.fn(async (_m: string, inputs: unknown) => {
    void inputs
    return [{ signature: { 0: 1, 1: 2 }, signedMessage: { 0: 3 } }]
  }),
}))

import { sendMessage } from '../../messaging/window.ts'
import { signMessage } from './sign-message.ts'

test('decodes the signature record into a Uint8Array', async () => {
  const [out] = await signMessage({ message: Uint8Array.from([3]) } as never)
  expect(out?.signature).toBeInstanceOf(Uint8Array)
})

test('collapses variadic inputs into one array payload', async () => {
  const a = { message: Uint8Array.from([1]) } as never
  const b = { message: Uint8Array.from([2]) } as never
  await signMessage(a, b)
  expect(vi.mocked(sendMessage)).toHaveBeenCalledWith('signMessage', [a, b])
})
```
- [ ] **Step 2:** run → fail. **Step 3:** implement `icon.ts`, `features/sign-message.ts`, `wallet.ts`, `setup.ts` (design §1/§3 verbatim). **Step 4:** run → pass.
- [ ] **Step 5 (failing test)** `src/wallet-standard/wallet.spec.ts`:
```ts
import { SolanaSignMessage } from '@solana/wallet-standard-features'
import { StandardConnect, StandardDisconnect, StandardEvents } from '@wallet-standard/core'
import { expect, test } from 'vitest'

import { EmberWallet } from './wallet.ts'

test('advertises exactly the four implemented features', () => {
  expect(Object.keys(new EmberWallet().features).sort()).toEqual(
    [SolanaSignMessage, StandardConnect, StandardDisconnect, StandardEvents].sort(),
  )
})
```
- [ ] **Step 6:** run → pass. **Step 7:** `bunx tsc --noEmit` clean.

## Task 4: VaultController.sign + HARDENED vault-service facade

**Files:** Modify `src/background/vault-controller.ts` (+ spec), `src/background/vault-service.ts`. Code: design §5 + CONFIRMED-DECISIONS #1.

- [ ] **Step 1 (failing tests)** append to `src/background/vault-controller.spec.ts`:
```ts
test('signs once unlocked', async () => {
  const c = new VaultController(new MemoryVaultStore())
  await c.createVault('Str0ng-pass-correct-horse')
  await c.unlock('Str0ng-pass-correct-horse')
  expect((await c.sign(Uint8Array.from([1, 2, 3]))).length).toBe(64)
})

test('refuses to sign while locked', async () => {
  const c = new VaultController(new MemoryVaultStore())
  await c.createVault('Str0ng-pass-correct-horse')
  await expect(c.sign(Uint8Array.from([1]))).rejects.toThrow('locked')
})
```
- [ ] **Step 2:** run → fail. **Step 3:** add `async sign(message)` to `VaultController` (design §5). **Step 4:** run → pass.
- [ ] **Step 5 (HARDENING):** rewrite `vault-service.ts` per CONFIRMED-DECISIONS #1 — define `interface VaultUI` (6 methods, no `sign`); `registerVaultService()` registers a plain-object facade delegating to a real `VaultController` and **returns the real controller**; `getVaultService(): ProxyService<VaultUI>`:
```ts
import { createProxyService, registerService } from '@webext-core/proxy-service'
import type { ProxyService, ProxyServiceKey } from '@webext-core/proxy-service'

import { BrowserVaultStore } from '../vault/browser-store.ts'
import { VaultController } from './vault-controller.ts'

export interface VaultUI {
  hasVault(): Promise<boolean>
  createVault(password: string): Promise<string>
  unlock(password: string): Promise<void>
  isUnlocked(): Promise<boolean>
  lock(): Promise<void>
  getAddress(): Promise<string | null>
}

const VAULT_SERVICE_KEY = 'ember.VaultService' as ProxyServiceKey<VaultUI>

/** SW only. Registers a sign-LESS facade; returns the REAL controller for in-SW signing. */
export function registerVaultService(): VaultController {
  const controller = new VaultController(new BrowserVaultStore())
  const facade: VaultUI = {
    hasVault: () => controller.hasVault(),
    createVault: (password) => controller.createVault(password),
    unlock: (password) => controller.unlock(password),
    isUnlocked: () => controller.isUnlocked(),
    lock: () => controller.lock(),
    getAddress: () => controller.getAddress(),
  }
  registerService(VAULT_SERVICE_KEY, facade)
  return controller
}

/** Any UI context: a proxy WITHOUT sign — signing is unreachable from any page. */
export function getVaultService(): ProxyService<VaultUI> {
  return createProxyService<VaultUI>(VAULT_SERVICE_KEY)
}
```
- [ ] **Step 6:** verify the 3a popup still compiles against `VaultUI` (it only uses the 6 facade methods): `bunx tsc --noEmit` clean; `bunx wxt build` ok; `bunx vitest run` passes.

## Task 5: Background pure units (account, sign-output, actions, origin)

**Files:** Create `src/background/build-account.ts` (+ spec), `src/background/sign-message-output.ts` (+ spec), `src/background/actions.ts` (+ spec), `src/background/message-handlers.ts` (+ spec). Code: design §1.

- [ ] **Step 1 (failing tests):**
  - `build-account.spec.ts`: `expect(buildConnectAccount('<a valid base58 address from a created vault>').publicKey.length).toBe(32)` — generate the address by creating a `Vault` in the test, or use a known 32-byte-decoding base58 string. Simplest: `import { base58Encode } from '../cover/ember-auth.ts'` and feed `base58Encode(new Uint8Array(32).fill(7))`.
  - `sign-message-output.spec.ts` (two tests): (a) with a signer returning `new Uint8Array(64)` and a **record-encoded** message `{0:1,1:2,2:3}`, `output[0].signedMessage` deep-equals `Uint8Array.from([1,2,3])` (proves `decodeTransportBytes`, not `new Uint8Array(record)`); (b) `output[0].signature.length === 64`.
  - `message-handlers.spec.ts` (two tests): `originOf({ url: 'https://app.x.io/p?q=1' } as never) === 'https://app.x.io'`; `originOf({} as never) === undefined`.
  - `actions.spec.ts`: mock `requestService` and assert `connect(input, 'https://x')` calls `requestService().create('connect', input, 'https://x')`.
- [ ] **Step 2:** run → fail. **Step 3:** implement the four files (design §1 verbatim). **Step 4:** run → all pass. **Step 5:** `bunx tsc --noEmit` clean.

## Task 6: RequestService (the lifecycle) — hardened, VaultSigner-injected

**Files:** Create `src/background/request-service.ts` (+ spec). Code: design §1 + CONFIRMED-DECISIONS #1 (inject `VaultSigner`, approve* call it directly; no `getVaultService` import).

- [ ] **Step 1 (failing tests)** `src/background/request-service.spec.ts` (use `@webext-core/fake-browser`; inject a fake `VaultSigner`):
```ts
import { fakeBrowser } from 'wxt/testing'
import { beforeEach, expect, test, vi } from 'vitest'

import { RequestService } from './request-service.ts'

const signer = {
  getAddress: async () => 'So11111111111111111111111111111111111111112',
  sign: async (_m: Uint8Array) => new Uint8Array(64),
}

beforeEach(() => {
  fakeBrowser.reset()
  vi.restoreAllMocks()
})

test('rejects a second concurrent request', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  void svc.create('connect', undefined)
  await expect(svc.create('connect', undefined)).rejects.toThrow('already exists')
})

test('approveSignMessage settles with a 64-byte signature', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signMessage', [{ message: Uint8Array.from([1, 2, 3]) } as never])
  await svc.approveSignMessage()
  const [out] = await pending
  expect(out?.signature).toBeDefined()
})

test('reject settles the pending promise with an error', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('connect', undefined)
  svc.reject()
  await expect(pending).rejects.toThrow('rejected')
})

test('closing the request window rejects the pending promise', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 7 } as never)
  const pending = svc.create('connect', undefined)
  fakeBrowser.windows.onRemoved.trigger(7)
  await expect(pending).rejects.toThrow('closed')
})
```
- [ ] **Step 2:** run → fail. **Step 3:** implement `request-service.ts` (design §1) WITH the hardening delta: `interface VaultSigner { getAddress(): Promise<string|null>; sign(m: Uint8Array): Promise<Uint8Array> }`; constructor takes `signer: VaultSigner`; `approveConnect` uses `this.signer.getAddress()`, `approveSignMessage` uses `buildSignMessageOutputs(request.data, (m) => this.signer.sign(m))`; `registerRequestService(signer: VaultSigner)`; keep `getRequestApproval()` narrow proxy. **Step 4:** run → 4 pass. **Step 5:** `bunx tsc --noEmit` clean.

> If `fakeBrowser.windows.onRemoved.trigger` / `windows.create` shapes differ in `@webext-core/fake-browser@1.5.2`, adapt the test to the real fake API (read its types); the assertions stay the same.

## Task 7: Request approval UI + entrypoint wiring

**Files:** Create `src/entrypoints/request/{index.html,main.tsx,RequestApp.tsx,decode-messages.ts}` (+ decode-messages spec), `src/entrypoints/injected.ts`, `src/entrypoints/content.ts`; Modify `src/entrypoints/background.ts`. Code: design §1.

- [ ] **Step 1 (failing tests)** `src/entrypoints/request/decode-messages.spec.ts`:
```ts
import { expect, test } from 'vitest'

import { decodeMessages } from './decode-messages.ts'

test('renders printable UTF-8 as text', () => {
  expect(decodeMessages([{ message: new TextEncoder().encode('hello') }])).toBe('hello')
})

test('renders non-printable bytes as hex, not mojibake', () => {
  expect(decodeMessages([{ message: Uint8Array.from([0, 1, 2]) }])).toBe('0x000102')
})
```
- [ ] **Step 2:** run → fail. **Step 3:** implement `decode-messages.ts` (design §1). **Step 4:** run → pass.
- [ ] **Step 5:** create `request/index.html`, `request/main.tsx`, `request/RequestApp.tsx` (design §1; render `origin` prominently per CONFIRMED-DECISIONS #2), `injected.ts`, `content.ts` (design §1). **Step 6:** modify `background.ts` per CONFIRMED-DECISIONS #1: `const controller = registerVaultService(); registerRequestService(controller); registerMessageHandlers()`.
- [ ] **Step 7:** `bunx tsc --noEmit` clean; `bunx wxt build` emits `request.html` + `injected.js` + a content script; `bunx vitest run` passes.

## Task 8: e2e gate — dapp connect + signMessage (crypto-verified)

**Files:** Create `e2e/fixtures/dapp.html`, `e2e/connect-sign.spec.ts`. Code: design §8.

- [ ] **Step 1:** create `e2e/fixtures/dapp.html` (design §8). In the connect handler, write `data-address` ONLY on success, and on `.catch` write `out.dataset.error` (so the cancellation test has a true negative — design §8 impl note).
- [ ] **Step 2:** create `e2e/connect-sign.spec.ts` (design §8): test 1 = connect → approve → sign → approve, asserting `signed` deep-equals `window.__expectedMessage()` AND Ed25519-verify passes against the connected pubkey; test 2 = close approval window → dapp promise rejects → no address. Fix the cancellation test's rejection-surfacing to the fixture's actual `.catch` handler (design §8 note).
- [ ] **Step 3:** `export PATH="$HOME/.bun/bin:$PATH"; bunx wxt build && bunx playwright test`. Both tests must pass in real Chromium. If a genuine wiring bug surfaces, fix it (do NOT weaken assertions). If Chromium can't launch, report BLOCKED (do not fake).

---

## Self-Review

**Spec coverage:** every design §1 file has a task (T1–T7); §3 provider (T3); §4 flow realized across T2/T6/T7; §5 + CONFIRMED-DECISIONS #1 hardened sign (T4 facade + T6 VaultSigner + T7 background wiring); §6 manifest (T0); §7 deps (T0); §8 e2e (T8). CONFIRMED-DECISIONS #2 message display (T7). Deferred (noted): signTransaction/signAndSendTransaction/signIn, cover, FIFO queue, session-based disconnect.

**Hardening invariant (the security crux):** `sign` is absent from the registered facade (T4), so it is unreachable via any proxy; `RequestService` signs via an injected `VaultSigner` (the real controller, in-SW) only inside `approveSignMessage`, reached only through the gated Approve button (T6/T7). The e2e proves the key signs the exact bytes and verifies cryptographically (T8). No `sign` crosses a proxy boundary anywhere.

**Placeholder scan:** test code is inline + complete; implementation code is fully specified in the co-located design doc (cited per task) with the hardening deltas spelled out inline here. The only reactive steps are fake-browser API shape (T6) and e2e wiring fixes (T8) — both real verification loops, not deferred logic.

**Type consistency:** `MessagingSchema` (T1) used by channels (T2) + provider (T3) + handlers (T5); `TransportConnectOutput`/`TransportSignMessageOutput` (T1) flow through actions (T5) + request-service (T6) + provider decode (T3); `VaultUI` (T4) consumed by the 3a popup + 3b RequestApp; `VaultSigner` (T6) satisfied by `VaultController` (T4); `getRequestApproval()`/`PendingRequestView` (T6) consumed by RequestApp (T7).
