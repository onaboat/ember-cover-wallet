# Vault Implementation Plan (cover-wallet sub-project 1 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A secure single-keypair vault — Argon2id-encrypted at rest, non-extractable WebCrypto signing key, session unlock with no force-lock, authenticated metadata, strong-password + lockout, encrypted backup — fully unit-tested in node, with zero extension/dapp dependencies.

**Architecture:** A `Vault` over an injected `VaultStore` (so tests use an in-memory store, the extension wires IndexedDB later). Encryption: Argon2id (`@noble/hashes`) → AES-GCM (SubtleCrypto) with vault metadata bound into the GCM AAD. Signing key: a non-extractable Ed25519 `CryptoKey`, held in memory only after unlock. The raw private key exists only transiently at create/unlock.

**Tech Stack:** TypeScript, `@noble/hashes` (argon2id), Web Crypto (`crypto.subtle`: AES-GCM, Ed25519), `@solana/kit` (address from public key), vitest. No WXT/extension yet — that's sub-project 3.

**Spec:** `docs/2026-06-16-cover-wallet-design.md`, Vault section. This sub-project is the whole Vault section.

**Conventions:** one assertion per test; explicit `import { expect, test } from 'vitest'`; run `bunx tsc --noEmit` + `bunx vitest run <file>` before each commit; commits only (no push).

---

## Task 0: Repo scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`

- [ ] **Step 1: package.json**
```json
{
  "name": "ember-cover-wallet",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "check-types": "tsc --noEmit", "test": "vitest run" },
  "dependencies": { "@noble/hashes": "^1.5.0", "@solana/kit": "^2.0.0" },
  "devDependencies": { "typescript": "^5.7.0", "vitest": "^2.1.0", "@types/node": "^22.0.0" }
}
```
(Pin exact versions at install time; these are floors.)

- [ ] **Step 2: tsconfig.json** — strict, the flags that bit us in the fork:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true,
    "erasableSyntaxOnly": true, "verbatimModuleSyntax": true,
    "lib": ["ES2023", "DOM"], "skipLibCheck": true, "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: vitest.config.ts** + `.gitignore` (`node_modules`, `dist`, `.wxt`, `*.local`)
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node' } })
```

- [ ] **Step 4:** `bun install`, then `bunx vitest run` → "No test files found" (clean). **Step 5: Commit** `chore: scaffold ember-cover-wallet`.

---

## Task 1: VaultStore interface + in-memory store

**Files:** Create `src/vault/vault-store.ts`, `src/vault/memory-store.ts`; Test `src/vault/memory-store.spec.ts`

- [ ] **Step 1: failing test**
```ts
import { expect, test } from 'vitest'
import { MemoryVaultStore } from './memory-store.ts'

test('returns the record it stored', async () => {
  const store = new MemoryVaultStore()
  await store.put({ salt: 's', argon2Params: { m: 1, t: 1, p: 1 }, iv: 'i', ciphertext: 'c', publicKey: 'p' })
  expect((await store.get())?.publicKey).toBe('p')
})
```
- [ ] **Step 2:** run → fail (modules missing).
- [ ] **Step 3: implement** `vault-store.ts`:
```ts
export interface Argon2Params { m: number; t: number; p: number }
export interface VaultRecord {
  salt: string // base64
  argon2Params: Argon2Params
  iv: string // base64
  ciphertext: string // base64
  publicKey: string // base58 address
}
export interface VaultStore {
  get(): Promise<VaultRecord | null>
  put(record: VaultRecord): Promise<void>
  clear(): Promise<void>
}
```
`memory-store.ts`:
```ts
import type { VaultRecord, VaultStore } from './vault-store.ts'
export class MemoryVaultStore implements VaultStore {
  private record: VaultRecord | null = null
  async get(): Promise<VaultRecord | null> { return this.record }
  async put(record: VaultRecord): Promise<void> { this.record = record }
  async clear(): Promise<void> { this.record = null }
}
```
- [ ] **Step 4:** run → pass. **Step 5: Commit** `feat(vault): store interface + in-memory store`.

---

## Task 2: Key encryption (Argon2id + AES-GCM with authenticated metadata)

**Files:** Create `src/vault/crypto.ts`; Test `src/vault/crypto.spec.ts`

The AAD binds `salt | argon2Params | publicKey` so tampering (param downgrade, pubkey swap) fails the GCM tag.

- [ ] **Step 1: failing tests**
```ts
import { expect, test } from 'vitest'
import { decryptKey, encryptKey } from './crypto.ts'

const secret = new Uint8Array(32).fill(7)

test('round-trips the secret with the right password', async () => {
  const rec = await encryptKey(secret, 'Str0ng-pass-correct-horse', 'PUBKEY')
  expect(Array.from(await decryptKey(rec, 'Str0ng-pass-correct-horse'))).toEqual(Array.from(secret))
})

test('wrong password fails', async () => {
  const rec = await encryptKey(secret, 'Str0ng-pass-correct-horse', 'PUBKEY')
  await expect(decryptKey(rec, 'wrong-password-entirely')).rejects.toThrow()
})

test('tampering with the authenticated metadata fails', async () => {
  const rec = await encryptKey(secret, 'Str0ng-pass-correct-horse', 'PUBKEY')
  await expect(decryptKey({ ...rec, publicKey: 'ATTACKER' }, 'Str0ng-pass-correct-horse')).rejects.toThrow()
})
```
- [ ] **Step 2:** run → fail.
- [ ] **Step 3: implement** `crypto.ts`:
```ts
import { argon2id } from '@noble/hashes/argon2'
import type { Argon2Params, VaultRecord } from './vault-store.ts'

const ARGON2: Argon2Params = { m: 64 * 1024, t: 3, p: 1 } // 64 MiB, 3 passes

const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b))
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

function aad(salt: string, params: Argon2Params, publicKey: string): Uint8Array {
  return new TextEncoder().encode(`${salt}|${params.m},${params.t},${params.p}|${publicKey}`)
}

async function deriveKey(password: string, salt: Uint8Array, params: Argon2Params): Promise<CryptoKey> {
  const raw = argon2id(new TextEncoder().encode(password), salt, { m: params.m, t: params.t, p: params.p, dkLen: 32 })
  return crypto.subtle.importKey('raw', new Uint8Array(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encryptKey(secret: Uint8Array, password: string, publicKey: string): Promise<VaultRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt, ARGON2)
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(b64(salt), ARGON2, publicKey) },
      key,
      new Uint8Array(secret),
    ),
  )
  return { salt: b64(salt), argon2Params: ARGON2, iv: b64(iv), ciphertext: b64(ct), publicKey }
}

export async function decryptKey(rec: VaultRecord, password: string): Promise<Uint8Array> {
  const salt = unb64(rec.salt)
  const key = await deriveKey(password, salt, rec.argon2Params)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(rec.iv), additionalData: aad(rec.salt, rec.argon2Params, rec.publicKey) },
    key,
    unb64(rec.ciphertext),
  )
  return new Uint8Array(plain)
}
```
- [ ] **Step 4:** run → pass (Argon2 makes these ~100ms+ each; fine). **Step 5: Commit** `feat(vault): argon2id + aes-gcm key encryption with authenticated metadata`.

---

## Task 3: Strong-password policy

**Files:** Create `src/vault/password-policy.ts`; Test `src/vault/password-policy.spec.ts`

- [ ] TDD: `assessPassword(pw): { ok: boolean; reason?: string }` — reject < 12 chars or fewer than 3 character classes; accept a strong one. Pure function, three tests (too short → !ok; weak → !ok; strong → ok). Commit `feat(vault): strong-password policy`.

---

## Task 4: Vault create + unlock + sign

**Files:** Create `src/vault/vault.ts`; Test `src/vault/vault.spec.ts`

Create generates an Ed25519 key (extractable only to encrypt), stores the ciphertext, discards plaintext. Unlock decrypts → imports a NON-EXTRACTABLE Ed25519 key held in memory. Sign uses SubtleCrypto.

- [ ] **Step 1: failing tests**
```ts
import { expect, test } from 'vitest'
import { MemoryVaultStore } from './memory-store.ts'
import { Vault } from './vault.ts'

test('a created+unlocked vault signs', async () => {
  const v = new Vault(new MemoryVaultStore())
  await v.create('Str0ng-pass-correct-horse')
  await v.unlock('Str0ng-pass-correct-horse')
  const sig = await v.sign(new TextEncoder().encode('hello'))
  expect(sig.length).toBe(64)
})

test('unlock with the wrong password rejects', async () => {
  const v = new Vault(new MemoryVaultStore())
  await v.create('Str0ng-pass-correct-horse')
  await expect(v.unlock('nope-wrong-password')).rejects.toThrow()
})

test('signing while locked rejects', async () => {
  const v = new Vault(new MemoryVaultStore())
  await v.create('Str0ng-pass-correct-horse')
  await expect(v.sign(new Uint8Array([1]))).rejects.toThrow('locked')
})
```
- [ ] **Step 2:** run → fail.
- [ ] **Step 3: implement** `vault.ts`:
```ts
import { getAddressFromPublicKey } from '@solana/kit'
import { decryptKey, encryptKey } from './crypto.ts'
import { assessPassword } from './password-policy.ts'
import type { VaultStore } from './vault-store.ts'

export class Vault {
  private store: VaultStore
  private signingKey: CryptoKey | null = null

  constructor(store: VaultStore) {
    this.store = store
  }

  async create(password: string): Promise<void> {
    const policy = assessPassword(password)
    if (!policy.ok) {
      throw new Error(policy.reason ?? 'weak password')
    }
    const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
    const rawPrivate = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
    const address = await getAddressFromPublicKey(pair.publicKey)
    const record = await encryptKey(rawPrivate, password, address)
    rawPrivate.fill(0)
    await this.store.put(record)
  }

  async unlock(password: string): Promise<void> {
    const record = await this.store.get()
    if (!record) {
      throw new Error('no vault')
    }
    const rawPrivate = await decryptKey(record, password) // throws on wrong password / tamper
    this.signingKey = await crypto.subtle.importKey('pkcs8', new Uint8Array(rawPrivate), { name: 'Ed25519' }, false, [
      'sign',
    ])
    rawPrivate.fill(0)
  }

  lock(): void {
    this.signingKey = null
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    if (!this.signingKey) {
      throw new Error('vault is locked')
    }
    return new Uint8Array(await crypto.subtle.sign('Ed25519', this.signingKey, new Uint8Array(message)))
  }
}
```
(Confirm `getAddressFromPublicKey` is the `@solana/kit` export at impl time; it derives the base58 address from the `CryptoKey` public key.)
- [ ] **Step 4:** run → pass. **Step 5: Commit** `feat(vault): create, unlock, non-extractable sign`.

---

## Task 5: Session — idle auto-lock + unlock lockout

**Files:** Modify `src/vault/vault.ts`; Test add to `src/vault/vault.spec.ts`

- [ ] TDD: inject a `now()` clock. (a) After `idleLockMs` since last activity, `sign` throws `locked` (auto-lock). (b) After N consecutive wrong-password unlocks, `unlock` throws `locked out` until a cooldown elapses (use the injected clock). Tests assert each with one assertion. Implement with an activity timestamp + a failed-attempt counter + cooldown, both clock-driven (no real timers in tests). Commit `feat(vault): idle auto-lock + unlock lockout`.

---

## Task 6: Encrypted backup export / import

**Files:** Modify `src/vault/vault.ts`; Test add to `src/vault/vault.spec.ts`

- [ ] TDD: `exportBackup(): string` returns the JSON of the `VaultRecord` (already encrypted, safe to write out). `Vault.importBackup(store, blob, password)` validates the blob decrypts with the password, then `put`s it. Test: export from one vault → import into a fresh store → unlock + sign works. One assertion (signature length 64). Commit `feat(vault): encrypted backup export/import`.

---

## Self-Review

**Spec coverage (Vault section):** Argon2id at rest (T2), AES-GCM + AAD-authenticated metadata (T2/T2-tamper-test), non-extractable in-memory signing key (T4), wrong-password reject (T2/T4), session no-force-lock + idle auto-lock (T5), unlock lockout (T5), strong-password enforcement (T3/T4), GCM fresh-IV-per-encrypt (T2, `getRandomValues` IV each call), encrypted backup no-seed (T6), store abstraction for later IndexedDB wiring (T1). Memory-only unlocked key: T4 holds it in a field, never written to the store — satisfied; the IndexedDB store impl (sub-project 3) must persist ONLY the `VaultRecord`, never the unlocked key (note carried to that plan).

**Deferred (not this sub-project):** BIP39 seed (the design's "move to A"); the IndexedDB `VaultStore` impl + WXT wiring (sub-project 3); keepalive for SW termination (sub-project 3, since it's extension-runtime).

**Placeholder scan:** none — every code step is complete. The two "confirm at impl time" notes (`@solana/kit` exact versions, `getAddressFromPublicKey` export name) are real-API confirmations against the installed library, not placeholders.

**Type consistency:** `VaultRecord`/`Argon2Params` (T1) used by `crypto.ts` (T2) and `Vault` (T4); `VaultStore` (T1) injected into `Vault` (T4); `encryptKey`/`decryptKey` (T2) called by `Vault.create`/`unlock` (T4); `assessPassword` (T3) called by `Vault.create` (T4).
