# Extension Shell + Secure Background Vault Plan (cover-wallet sub-project 3a of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. The Playwright task (T6) is the real-runtime gate — do not mark the plan done until it passes in an actual browser.

**Goal:** Turn `ember-cover-wallet` into an installable WXT/React browser extension whose background service worker hosts the secure vault (unlocked Ed25519 key in SW memory only, encrypted record on disk), with a minimal popup to create a vault, unlock it, and view the wallet address — proven end-to-end in a real Chromium via Playwright.

**Architecture:** WXT extension. The `Vault` (sub-project 1) lives behind a `VaultController` singleton in the **background** service worker, persisting the encrypted `VaultRecord` via `browser.storage.local` (a `BrowserVaultStore` implementing the existing `VaultStore` interface). The popup is a separate context: it never holds key material; it drives the background controller through a `@webext-core/proxy-service` proxy, so the unlocked key never leaves the SW. No dapp-facing surface yet (that is 3b).

**Tech Stack:** WXT 0.20.25, `@wxt-dev/module-react` 1.2.2, React 19.2.x, `@webext-core/proxy-service` 2.0.0, WXT testing (`fakeBrowser`), vitest (node), `@playwright/test`. Patterns lifted from `ember-wallet` (the Samui fork) — NOT its key handling.

**Spec:** `docs/2026-06-16-cover-wallet-design.md` (Architecture: `background/`, `vault/` IndexedDB note, `ui/` onboarding+unlock). Builds on sub-projects 1 (`src/vault/`) and 2 (`src/cover/`, `src/worker/`).

**Decisions (deviations from the design doc, called out):**
- **`browser.storage.local`, not raw IndexedDB**, for the single ciphertext `VaultRecord`. Simpler, idiomatic for extensions, and we already declare the `storage` permission. Same security property (only the Argon2id ciphertext is persisted). The `vault/` encrypt/import path is untouched, so a future IndexedDB or seed-derived store still slots into the same `VaultStore` interface.
- **Playwright** for the e2e gate. The WebdriverIO/`tauri-plugin-webdriver` rule in memory was for the Tauri *desktop* Guardian wallet; this is a WXT *browser extension*, whose approved design specifies Playwright.

**Conventions:** TDD the logic units (store, controller); the framework wiring + UI are proven by the Playwright gate. Run `bunx tsc --noEmit` + `bunx vitest run` before each checkpoint. Commits left to the user.

---

## Task 0: WXT + React scaffold, deps, existing suite stays green

**Files:** Create `wxt.config.ts`; Modify `package.json`, `tsconfig.json`, `vitest.config.ts`.

- [ ] **Step 1: Install deps.**
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun add wxt@0.20.25 react@19.2.5 react-dom@19.2.5 @webext-core/proxy-service@2.0.0
bun add -D @wxt-dev/module-react@1.2.2 @wxt-dev/auto-icons@1.1.1 @types/react@19 @types/react-dom@19 @playwright/test
```

- [ ] **Step 2: `package.json` scripts** — add (keep existing `test`/`check-types`):
```json
"scripts": {
  "dev": "wxt",
  "build": "wxt build",
  "postinstall": "wxt prepare",
  "check-types": "tsc --noEmit",
  "test": "vitest run",
  "e2e": "wxt build && playwright test"
}
```

- [ ] **Step 3: `wxt.config.ts`** — auto-imports OFF (explicit imports, per project principles):
```ts
import { defineConfig } from 'wxt'

export default defineConfig({
  srcDir: 'src',
  imports: false, // no magic globals; import WXT helpers explicitly from '#imports'
  modules: ['@wxt-dev/module-react', '@wxt-dev/auto-icons'],
  manifest: {
    name: 'Ember',
    permissions: ['storage'],
  },
})
```

- [ ] **Step 4: Generate WXT types.** Run `bunx wxt prepare`. Expected: creates `.wxt/` with `tsconfig.json` + `wxt.d.ts`. Add `.wxt` and `.output` to `.gitignore` (the vault plan already added `.wxt`; add `.output`).

- [ ] **Step 5: Compose `tsconfig.json`** — extend WXT's generated config but keep our strict flags:
```json
{
  "extends": "./.wxt/tsconfig.json",
  "compilerOptions": {
    "allowImportingTsExtensions": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "jsx": "react-jsx",
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "e2e"]
}
```

- [ ] **Step 6: `vitest.config.ts`** — add the WXT vitest plugin so `#imports` + `fakeBrowser` work, keep the argon2 timeout:
```ts
import { defineConfig } from 'vitest/config'
import { WxtVitest } from 'wxt/testing'

export default defineConfig({
  plugins: [WxtVitest()],
  test: { environment: 'node', testTimeout: 30000 },
})
```

- [ ] **Step 7: Verify nothing regressed.** Run, adjusting config until all three pass:
  - `bunx wxt build` → builds `.output/chrome-mv3` (no entrypoints yet is fine; WXT warns but builds).
  - `bunx tsc --noEmit` → clean.
  - `bunx vitest run` → the existing **38 tests still pass** (vault 14 + cover 18 + worker 6).
- [ ] **Step 8: Commit** `chore: add WXT + React scaffold`.

---

## Task 1: `BrowserVaultStore` over `browser.storage.local`

**Files:** Create `src/vault/browser-store.ts`; Test `src/vault/browser-store.spec.ts`.

- [ ] **Step 1: Failing test** (WXT `fakeBrowser` resets extension storage per test):
```ts
import { fakeBrowser } from 'wxt/testing'
import { beforeEach, expect, test } from 'vitest'

import { BrowserVaultStore } from './browser-store.ts'

beforeEach(() => {
  fakeBrowser.reset()
})

const record = { salt: 's', argon2Params: { m: 1, t: 1, p: 1 }, iv: 'i', ciphertext: 'c', publicKey: 'PUB' }

test('persists and returns the record', async () => {
  const store = new BrowserVaultStore()
  await store.put(record)
  expect((await store.get())?.publicKey).toBe('PUB')
})

test('clear removes the record', async () => {
  const store = new BrowserVaultStore()
  await store.put(record)
  await store.clear()
  expect(await store.get()).toBeNull()
})
```

- [ ] **Step 2:** `bunx vitest run src/vault/browser-store.spec.ts` → fails (module missing).

- [ ] **Step 3: Implement** `browser-store.ts`:
```ts
import { storage } from 'wxt/utils/storage'

import type { VaultRecord, VaultStore } from './vault-store.ts'

const KEY = 'local:vault' as const

/** Persists ONLY the encrypted record (Argon2id ciphertext) — never the unlocked key. */
export class BrowserVaultStore implements VaultStore {
  async get(): Promise<VaultRecord | null> {
    return (await storage.getItem<VaultRecord>(KEY)) ?? null
  }

  async put(record: VaultRecord): Promise<void> {
    await storage.setItem(KEY, record)
  }

  async clear(): Promise<void> {
    await storage.removeItem(KEY)
  }
}
```

- [ ] **Step 4:** `bunx vitest run src/vault/browser-store.spec.ts` → 2 pass. `bunx tsc --noEmit` → clean.
- [ ] **Step 5: Commit** `feat(vault): browser.storage.local store`.

---

## Task 2: `Vault.isUnlocked()` accessor

**Files:** Modify `src/vault/vault.ts`; Test add to `src/vault/vault.spec.ts`.

The controller needs to report lock state without exposing the key.

- [ ] **Step 1: Failing test** (append to `vault.spec.ts`):
```ts
test('reports unlocked state', async () => {
  const v = new Vault(new MemoryVaultStore())
  await v.create('Str0ng-pass-correct-horse')
  await v.unlock('Str0ng-pass-correct-horse')
  expect(v.isUnlocked()).toBe(true)
})
```

- [ ] **Step 2:** `bunx vitest run src/vault/vault.spec.ts -t "unlocked state"` → fails (`isUnlocked` not a function).

- [ ] **Step 3: Implement** — add to the `Vault` class (next to `lock()`):
```ts
  isUnlocked(): boolean {
    return this.signingKey !== null
  }
```

- [ ] **Step 4:** `bunx vitest run src/vault/vault.spec.ts -t "unlocked state"` → pass. `bunx tsc --noEmit` → clean.
- [ ] **Step 5: Commit** `feat(vault): isUnlocked accessor`.

---

## Task 3: `VaultController` (background-side orchestrator)

**Files:** Create `src/background/vault-controller.ts`; Test `src/background/vault-controller.spec.ts`.

Wraps a `Vault` + injected store. All methods async (so they are proxy-safe in Task 4). Tests inject `MemoryVaultStore` — no browser needed.

- [ ] **Step 1: Failing tests:**
```ts
import { expect, test } from 'vitest'

import { MemoryVaultStore } from '../vault/memory-store.ts'
import { VaultController } from './vault-controller.ts'

test('has no vault before creation', async () => {
  const c = new VaultController(new MemoryVaultStore())
  expect(await c.hasVault()).toBe(false)
})

test('create then getAddress returns a base58 address', async () => {
  const c = new VaultController(new MemoryVaultStore())
  const address = await c.createVault('Str0ng-pass-correct-horse')
  expect(address.length).toBeGreaterThan(31)
})

test('unlock with the right password reports unlocked', async () => {
  const store = new MemoryVaultStore()
  const c = new VaultController(store)
  await c.createVault('Str0ng-pass-correct-horse')
  await c.unlock('Str0ng-pass-correct-horse')
  expect(await c.isUnlocked()).toBe(true)
})
```

- [ ] **Step 2:** `bunx vitest run src/background/vault-controller.spec.ts` → fails (module missing).

- [ ] **Step 3: Implement** `vault-controller.ts`:
```ts
import { Vault } from '../vault/vault.ts'
import type { VaultStore } from '../vault/vault-store.ts'

/** Lives in the background SW. Holds the only unlocked-key-bearing Vault instance. */
export class VaultController {
  private store: VaultStore
  private vault: Vault

  constructor(store: VaultStore) {
    this.store = store
    this.vault = new Vault(store)
  }

  async hasVault(): Promise<boolean> {
    return (await this.store.get()) !== null
  }

  async createVault(password: string): Promise<string> {
    await this.vault.create(password)
    return this.requireAddress()
  }

  async unlock(password: string): Promise<void> {
    await this.vault.unlock(password)
  }

  async isUnlocked(): Promise<boolean> {
    return this.vault.isUnlocked()
  }

  async lock(): Promise<void> {
    this.vault.lock()
  }

  async getAddress(): Promise<string | null> {
    return (await this.store.get())?.publicKey ?? null
  }

  private async requireAddress(): Promise<string> {
    const address = await this.getAddress()
    if (!address) {
      throw new Error('no vault')
    }
    return address
  }
}
```

- [ ] **Step 4:** `bunx vitest run src/background/vault-controller.spec.ts` → 3 pass. `bunx tsc --noEmit` → clean.
- [ ] **Step 5: Commit** `feat(background): vault controller`.

---

## Task 4: Proxy-service wiring + background entrypoint

**Files:** Create `src/background/vault-service.ts`, `src/entrypoints/background.ts`.

- [ ] **Step 1:** `src/background/vault-service.ts` — wire the proxy service. `@webext-core/proxy-service` 2.0.0 exports `createProxyService` (get a proxy) + `registerService` (register the real instance), keyed by a `ProxyServiceKey`. `registerVaultService()` runs ONLY in the background (where `BrowserVaultStore` is valid); `getVaultService()` returns a proxy any UI context can call:
```ts
import { createProxyService, registerService } from '@webext-core/proxy-service'
import type { ProxyService, ProxyServiceKey } from '@webext-core/proxy-service'

import { BrowserVaultStore } from '../vault/browser-store.ts'
import { VaultController } from './vault-controller.ts'

const VAULT_SERVICE_KEY = 'VaultService' as ProxyServiceKey<VaultController>

/** Called once in the background SW — constructs the real, key-bearing controller. */
export function registerVaultService(): VaultController {
  const controller = new VaultController(new BrowserVaultStore())
  registerService(VAULT_SERVICE_KEY, controller)
  return controller
}

/** Called from any UI context — returns a proxy that marshals calls to the background. */
export function getVaultService(): ProxyService<VaultController> {
  return createProxyService<VaultController>(VAULT_SERVICE_KEY)
}
```
(`ProxyService<VaultController>` resolves to `VaultController` because every controller method is already async.)

- [ ] **Step 2:** `src/entrypoints/background.ts` — register it:
```ts
import { defineBackground } from 'wxt/utils/define-background'

import { registerVaultService } from '../background/vault-service.ts'

export default defineBackground(() => {
  registerVaultService()
})
```

- [ ] **Step 3: Verify** `bunx wxt build` succeeds and emits a background script; `bunx tsc --noEmit` clean. (Behaviour is proven by the popup + e2e in T5/T6.)
- [ ] **Step 4: Commit** `feat(background): register vault proxy-service`.

---

## Task 5: Popup UI — create / unlock / account

**Files:** Create `src/entrypoints/popup/index.html`, `src/entrypoints/popup/main.tsx`, `src/entrypoints/popup/App.tsx`.

Three states driven by the controller proxy: no-vault → create; locked → unlock; unlocked → show address + lock.

- [ ] **Step 1:** `popup/index.html`:
```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Ember</title></head>
  <body><div id="root"></div><script type="module" src="./main.tsx"></script></body>
</html>
```

- [ ] **Step 2:** `popup/main.tsx`:
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 3:** `popup/App.tsx` — minimal, `data-testid`s for the e2e:
```tsx
import { useEffect, useState } from 'react'

import { getVaultService } from '../../background/vault-service.ts'

type View = 'loading' | 'create' | 'unlock' | 'account'

export function App() {
  const vault = getVaultService()
  const [view, setView] = useState<View>('loading')
  const [address, setAddress] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  async function refresh() {
    if (!(await vault.hasVault())) return setView('create')
    if (await vault.isUnlocked()) {
      setAddress(await vault.getAddress())
      return setView('account')
    }
    return setView('unlock')
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function onCreate() {
    setError('')
    try {
      setAddress(await vault.createVault(password))
      await vault.unlock(password)
      setPassword('')
      setView('account')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed')
    }
  }

  async function onUnlock() {
    setError('')
    try {
      await vault.unlock(password)
      setPassword('')
      await refresh()
    } catch {
      setError('Wrong password')
    }
  }

  if (view === 'loading') return <p>Loading…</p>
  if (view === 'account') {
    return (
      <div style={{ padding: 16, width: 320 }}>
        <p data-testid="address">{address}</p>
        <button data-testid="lock" onClick={() => void vault.lock().then(refresh)}>Lock</button>
      </div>
    )
  }
  return (
    <div style={{ padding: 16, width: 320 }}>
      <h1>{view === 'create' ? 'Create your Ember wallet' : 'Unlock'}</h1>
      <input
        data-testid="password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button data-testid="submit" onClick={() => void (view === 'create' ? onCreate() : onUnlock())}>
        {view === 'create' ? 'Create' : 'Unlock'}
      </button>
      {error ? <p data-testid="error">{error}</p> : null}
    </div>
  )
}
```

- [ ] **Step 4:** `bunx tsc --noEmit` → clean; `bunx wxt build` → emits `popup.html`.
- [ ] **Step 5: Commit** `feat(ui): popup create/unlock/account`.

---

## Task 6: Playwright e2e — the real-runtime gate

**Files:** Create `playwright.config.ts`, `e2e/onboarding.spec.ts`.

- [ ] **Step 1:** `playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 60000,
  fullyParallel: false,
})
```

- [ ] **Step 2:** `e2e/onboarding.spec.ts` — load the built extension, onboard, lock, unlock:
```ts
import path from 'node:path'

import { type BrowserContext, chromium, expect, test } from '@playwright/test'

const EXT = path.resolve('.output/chrome-mv3')

async function launch(): Promise<{ context: BrowserContext; extensionId: string }> {
  const context = await chromium.launchPersistentContext('', {
    headless: false, // MV3 extensions require headed (or `--headless=new`)
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  })
  let [sw] = context.serviceWorkers()
  if (!sw) sw = await context.waitForEvent('serviceworker')
  return { context, extensionId: new URL(sw.url()).host }
}

test('create a vault, lock, and unlock', async () => {
  const { context, extensionId } = await launch()
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/popup.html`)

  await page.getByTestId('password').fill('Str0ng-pass-correct-horse')
  await page.getByTestId('submit').click()
  const address = await page.getByTestId('address').textContent()
  expect((address ?? '').length).toBeGreaterThan(31)

  await page.getByTestId('lock').click()
  await page.getByTestId('password').fill('Str0ng-pass-correct-horse')
  await page.getByTestId('submit').click()
  await expect(page.getByTestId('address')).toHaveText(address ?? '')

  await context.close()
})
```

- [ ] **Step 3:** Install the browser: `bunx playwright install chromium` (user-space download to `~/Library/Caches`; if the locked machine blocks it, run this task in CI instead — note it, do not fake a pass).
- [ ] **Step 4:** `bunx wxt build && bunx playwright test`. Expected: the test passes against the real extension. If it fails, fix the wiring (this is the gate — a green unit suite is NOT sufficient).
- [ ] **Step 5: Commit** `test(e2e): onboarding create/lock/unlock`.

---

## Self-Review

**Spec coverage:** background-hosted vault with unlocked key in SW memory only (T3 controller holds the `Vault`; only `BrowserVaultStore` ciphertext is persisted, T1) ✓; encrypted record on disk via extension storage (T1, deviation noted) ✓; popup onboarding + unlock + account (T5) ✓; WXT extension shell + React (T0) ✓; real-runtime verification (T6 Playwright) ✓. The `vault/` IndexedDB note is satisfied by the equivalent `storage.local` store behind the same `VaultStore` interface (deviation documented). Dapp-facing wallet-standard/connect/sign is explicitly OUT (sub-project 3b).

**Placeholder scan:** logic tasks (T1–T3) carry complete code + tests. Framework tasks (T0, T4, T5) carry complete config/components; their "adjust until green" steps are real verification loops against `wxt build`/`tsc`, not deferred logic. T6 exact Playwright-extension-launch flags are concrete; the only reactive part is fixing wiring if the gate is red, which is the point of a gate.

**Type consistency:** `VaultStore`/`VaultRecord` (sub-1) reused by `BrowserVaultStore` (T1) and `VaultController` (T3); `Vault.isUnlocked()` added in T2 is consumed by `VaultController.isUnlocked()` (T3); `getVaultService()` (T4) returns a proxy of `VaultController` (T3) consumed by the popup (T5); `registerVaultService()` (T4) is called by the background entrypoint (T4).

**Open risk (flagged, not blocking):** WXT's generated tsconfig composing with our strict flags (`verbatimModuleSyntax`/`erasableSyntaxOnly`) is verified reactively in T0 step 7; if a flag conflicts with generated code, relax it for `.wxt`-generated paths only, never for `src`.
