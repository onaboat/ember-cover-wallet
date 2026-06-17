# Cover + Worker Transfer Plan (cover-wallet sub-project 2 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Bring the already-tested, dependency-free cover client + worker proxy from the abandoned `ember-wallet` fork into `ember-cover-wallet`, get every existing test green under this repo's strict tsconfig, with zero behaviour change.

**Architecture:** Single-package layout (like `src/vault/`). The 6 pure-TS cover modules land in `src/cover/`; the CF Worker proxy lands in `src/worker/`. All imports are already relative `./x.ts`, so the only rewrite is the proxy's cross-package `@workspace/ember/ember-auth` → `../cover/ember-auth.ts`. No new dependencies (cover code uses only SubtleCrypto / fetch / builtins). Tests run in the existing node vitest setup — no jsdom.

**Tech Stack:** TypeScript (strict), vitest (node env), Web Crypto. No React, no `@solana/kit` in this layer.

**Source of truth:** `~/Documents/Projects/ember-wallet/packages/ember/src/` and `~/Documents/Projects/ember-wallet/apps/api/src/cover-proxy*.ts`.

**Scope decisions:**
- **Defer the two React files** (`use-cover-decision.ts`, `cover-banner.tsx`) to sub-project 5 (UI), where React + jsdom get set up. They have no tests.
- **Defer two-signature session auth** to sub-project 4 (cover-signing flow + session-key auth). The proxy transfers verbatim (single wallet-key verify); its 6 tests stay green as the baseline that sub-project 4 evolves.

**Conventions:** run `bunx vitest run` + `bunx tsc --noEmit` after the copy; fix only strict-flag breakages (no behaviour change); commits left to the user.

---

## Task 1: Copy the 6 pure-TS cover modules into `src/cover/`

**Files (copy verbatim, no edits — imports are already relative `./x.ts`):**
- `ember-types.ts` + `ember-types.spec.ts`
- `ember-config.ts` (no spec)
- `ember-client.ts` + `ember-client.spec.ts`
- `cover-decision-logic.ts` + `cover-decision-logic.spec.ts`
- `ember-auth.ts` + `ember-auth.spec.ts`
- `cover-banner-view.ts` + `cover-banner-view.spec.ts`

- [ ] **Step 1:** `mkdir -p src/cover` and copy each file from `ember-wallet/packages/ember/src/<file>` to `ember-cover-wallet/src/cover/<file>`.
- [ ] **Step 2:** Run `bunx vitest run src/cover` — expect the cover specs to run (some strict-flag failures possible; fixed in Task 3).

## Task 2: Copy the worker proxy into `src/worker/` with the one import rewrite

**Files:**
- Copy `apps/api/src/cover-proxy.ts` → `src/worker/cover-proxy.ts`
- Copy `apps/api/src/cover-proxy.spec.ts` → `src/worker/cover-proxy.spec.ts`

- [ ] **Step 1:** `mkdir -p src/worker` and copy both files.
- [ ] **Step 2:** In `src/worker/cover-proxy.ts`, rewrite `import { verifyAuthHeader } from '@workspace/ember/ember-auth'` → `import { verifyAuthHeader } from '../cover/ember-auth.ts'`.
- [ ] **Step 3:** In `src/worker/cover-proxy.spec.ts`, rewrite `import { authPayload, base58Encode } from '@workspace/ember/ember-auth'` → `import { authPayload, base58Encode } from '../cover/ember-auth.ts'`.
- [ ] **Step 4:** Run `bunx vitest run src/worker` — expect the 6 proxy tests to run.

## Task 3: Green the whole suite under strict tsconfig

- [ ] **Step 1:** Run `bunx tsc --noEmit`. For each error, apply the minimal strict-flag fix WITHOUT changing behaviour. Expected candidates (same family hit in the vault build): `Uint8Array<ArrayBufferLike>` → `Uint8Array<ArrayBuffer>` at WebCrypto BufferSource call sites; `ReturnType<typeof setTimeout>` ambiguity (annotate `number`); `noUncheckedIndexedAccess` nullish guards; `exactOptionalPropertyTypes` conditional spreads. If a file is clean, do nothing.
- [ ] **Step 2:** Run the full `bunx vitest run`. Expected: vault (14) + cover (18) + worker (6) = 38 tests pass.
- [ ] **Step 3:** Re-run `bunx tsc --noEmit` → clean.

---

## Self-Review

**Spec coverage:** the design's "Reuse / Provenance" lists `cover/` (ember-types, ember-config, ember-client, cover-decision-logic, use-cover-decision, cover-banner, ember-auth) and `worker/` (cover-proxy). This plan transfers all of those EXCEPT the two React files (use-cover-decision, cover-banner), explicitly deferred to sub-project 5, and adds `cover-banner-view` (the opaque non-React view logic). The two-signature proxy extension named in the design's Testing section is explicitly deferred to sub-project 4. No other design item is in scope here.

**Placeholder scan:** none — Task 3's fixes are described by symptom because they're reactive to tsc output; the fix family is concrete and was exercised in the vault build.

**Behaviour-change guard:** copies are verbatim except the single proxy import path. Task 3 fixes are type-level only. If any change would alter runtime behaviour, stop and flag it.
