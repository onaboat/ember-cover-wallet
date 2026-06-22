# Unified approval window (Approach A)

Date: 2026-06-22
Status: Design approved in principle (Approach A); revised after a codebase verification pass.

## Problem

When a dapp asks the wallet to connect, sign a message, or sign a transaction, the
wallet opens a separate, bare "Ember - Approve" OS popup window (`request.html`,
rendered by `RequestApp.tsx`). That window shows only an approval card and calls
`window.close()` when the user is done. It looks and feels like a different surface
from the wallet the user knows (balance + activity), and it vanishes the moment the
work completes, so the user never sees the result land in their wallet.

## Goal

Make that window be the full wallet. It renders the same shell as the toolbar popup
(`App.tsx`), surfaces the incoming request as a screen inside the wallet, keeps balance
and activity reachable, and after a successful approval it returns to the wallet home
and stays open so the user sees the result, then closes it themselves.

## Scope

In scope (our wallet's own code):
- `src/background/request-service.ts`
- `src/entrypoints/request/RequestApp.tsx` (becomes `ApprovalScreen`)
- `src/entrypoints/request/main.tsx`
- `src/entrypoints/popup/App.tsx`
- `src/assets/global.css`
- `e2e/connect-sign.spec.ts`, `src/background/request-service.spec.ts`
- `src/entrypoints/request/index.html` (title only)

Out of scope:
- The demo dapp at `localhost:5173`. We do not touch it.
- The wallet's own in-popup Send and Cover flows. They already render in place and
  already refresh the balance on completion; they are unchanged by this work.

## The browser constraint (why it is still a window)

A dapp request fires while the user is on the dapp's tab, not in the wallet's toolbar
popup. Browser extensions cannot reliably show a dapp-triggered approval inside the
toolbar dropdown, so every wallet uses a dedicated window for this. We keep the window;
we change what it renders and how it ends. `request.html` stays a WXT entrypoint because
the service worker builds the window URL from it (`request-service.ts`, the
`request.html#/<slug>` URL).

## Architecture

`request/main.tsx` renders `<App mode="approval" />` instead of `<RequestApp />`. The
toolbar popup keeps rendering `<App />` (default `mode="wallet"`). `RequestApp`'s logic
moves into an `ApprovalScreen` component that `App` mounts as one of its account screens.
`request-service` stops removing the window after a successful approve; it resolves the
dapp's promise and clears the pending slot but leaves the window open. The user closes it.

Routing source of truth is the `mode` prop, never the URL hash. The window opens at
`request.html#/sign-transaction` (etc.); that slug is only the OS-window target and must
not drive React routing. App's existing `#cover` deep-link effect stays scoped to
`mode="wallet"`.

### The "updated balance" nuance (stated honestly)

For a dapp `signTransaction`, the wallet only signs and returns bytes; the dapp
broadcasts. So the on-chain balance does not change at sign time. After a successful
approve the window returns to the wallet home showing the current balance (which updates
on a later refresh once the dapp submits and the network confirms), and, when a cover
record was written, the signed transaction appears immediately as a pending entry in the
Activity tab. We will not promise or assert a numeric balance change for dapp-signed
transactions. (The wallet's own Send flow does broadcast, but that flow is out of scope.)

## Implementation, as four ordered vertical slices

Each slice is independently testable and lands behind the previous one.

### Slice 1: request-service lifecycle split + per-request identity

Changes in `request-service.ts`:

1. Give each pending request an identity. Add an `id` to the internal `PendingRequest`
   (a monotonic counter assigned in `create()`, e.g. `this.#seq++`, stringified).
   Expose it on `PendingRequestView` so the UI can capture it.
2. Add the `id` as an optional argument to `approveConnect`, `approveSignMessage`,
   `approveSignTransaction`, and `reject` on the `RequestApproval` interface and its
   proxy. When an `id` is passed and does not match the current `#request.id`, the call
   throws `Stale request` and does nothing else. This closes the cross-request hole: a
   long-lived window that stayed open can never act on a different, later request than the
   one it displayed.
3. Split window removal from promise resolution. In each `approveX`, call `#clear()`
   (null the pending slot, leave the window open) synchronously immediately after
   `request.resolve(...)`, and BEFORE the awaited `coverRecords.record(...)` and the
   fire-and-forget `postSign`/`postSignMessage`. This guarantees the `onRemoved` listener
   is a no-op the instant the dapp is settled, so a manual close right after approve cannot
   double-settle the promise. The awaited `coverRecords.record(...)` still completes before
   `approveX` returns, so the UI (which navigates after `await approveX()`) sees the record.
4. `reject()` keeps calling `#close()` (removes the window). Manual close before a
   decision still rejects the dapp via the unchanged `onRemoved` listener.

Acceptance (unit, `request-service.spec.ts`):
- `approveSignTransaction`/`approveConnect` resolve the dapp promise and do NOT call
  `browser.windows.remove` (window stays open).
- A later `windows.onRemoved` for that window id after approve does not reject (pending
  already cleared); no second settle.
- `reject()` still removes the window; close-before-approve still rejects.
- `approveX(staleId)` throws `Stale request` and does not resolve.

### Slice 2: extract ApprovalScreen from RequestApp

Rename `RequestApp.tsx` to `ApprovalScreen.tsx`. Keep all logic and all `data-testid`
values (`approve`, `reject`, `cover`, `cover-ack`, `impact-ack`, `message-ack`,
`password`, `error`, etc.). Changes:

1. Replace the two `window.close()` calls with callbacks from props: `onApproved()` after
   a successful approve, `onRejected()` after reject.
2. Replace `openCoverSetup`'s `window.open('/popup.html#cover', ...)` with an
   `onSetupCover()` prop. There is no second wallet window; App navigates in place.
3. Keep the self-contained inline unlock (`needsUnlock` + the inline `password` field +
   `ensureUnlocked`). The approval screen owns unlock so the cover banner and password
   coexist on one screen while the vault is locked. Broaden the re-lock detection from
   `message === 'vault is locked'` to `message.startsWith('vault is locked')` so a
   mid-approval lockout ("vault is locked out") also shows the recovery prompt instead of a
   raw error.
4. Keep the live cover-decision machinery intact: the mount poll (with its `active` guard),
   the `nowMs` countdown interval, `coverExpired`, and the `refreshCoverDecision` "Recheck
   cover" affordance. The window now invites dwelling, so an expired decision must surface
   the recheck button, not a thrown error.
5. App, not ApprovalScreen, decides when to mount it; the "No pending request" empty state
   is removed (App never mounts the screen without a pending request).
6. Capture the request `id` from the first `get()` and pass it to `approveX(id)` /
   `reject(id)`.

Module location and bundle: have `App` load `ApprovalScreen` via `React.lazy` so the
toolbar popup (which never decodes raw dapp transactions) does not eagerly pull in
`decode-transaction`, `decode-messages`, and the `@solana/kit` transaction decoders. The
file can stay under `src/entrypoints/request/`; the lazy boundary keeps the decoders out
of the popup's initial bundle. Measure the popup bundle delta after the change.

Acceptance: the approval screen renders identically to today inside the wallet shell;
unit decoder specs (`decode-transaction.spec.ts`, `decode-messages.spec.ts`) are
untouched and stay green.

### Slice 3: App approval mode (routing, nav, return)

Changes in `App.tsx`:

1. Add a `mode: 'wallet' | 'approval'` prop, default `'wallet'`.
2. Add `'approval'` to the `AccountScreen` union.
3. Pending detection. In approval mode only, on mount read `request.get()` once (with an
   `active` guard for StrictMode) and store the captured request `id` plus a
   `approvalPending` flag. Route off the `mode` prop and `view`, not the hash.
4. Locked-vault routing. In approval mode, a locked-but-present vault must NOT go to App's
   `unlock` view. `refresh()` (and `onCreate`) route a present vault to `view='account'`
   with `accountScreen='approval'`, and ApprovalScreen owns inline unlock. App's separate
   `unlock`/`create` auth views are used only in `mode='wallet'`. This keeps password and
   cover on one screen and avoids a duplicate `password`/`error` testid collision (the
   auth view never co-mounts with the approval screen).
5. Render the approval screen. When `accountScreen==='approval'`, render `<ApprovalScreen>`
   inside `ec-shell > ec-shell__main` (so it scrolls via the shell's main), wired with
   `onApproved`, `onRejected`, `onSetupCover`, and the captured `id`. It is not gated by
   `mainTab==='assets'` the way receive/send/cover are.
6. `onApproved()`: set `accountScreen='home'`, `mainTab='assets'` first (so a null `get()`
   never flashes the approval screen), clear `approvalPending`, then `refreshWalletData()`
   and `refreshCoverState()`. Do not re-poll `get()`. `onRejected()`: dapp is rejected and
   the window closes via `reject()` -> `#close()`; nothing to navigate to.
7. `onSetupCover()`: `setAccountScreen('cover')` (App already renders the cover activation
   screen). Keep the `#cover` hash handler strictly for `mode='wallet'`.
8. Nav during approval and the peek. While `approvalPending`, render the bottom nav during
   `accountScreen==='approval'` (not only `'home'`) and add a third item, "Request", that
   returns to `accountScreen='approval'`. The peek must preserve ApprovalScreen state:
   keep `ApprovalScreen` MOUNTED while a request is pending and hide it with CSS when the
   user peeks at Assets/Activity, rather than unmounting it. This preserves the
   acknowledgement checkboxes and the cover countdown across a peek. Tab buttons must not
   reset `accountScreen` to `'home'` while a request is pending.

   This peek is the single most UI-heavy part of the change. It is included because the
   user asked for balance and activity to be visible alongside the approval. If we choose
   to trim scope, the fallback is: no peek, the approval screen shows a compact balance
   line inline, and the full balance + activity appear after the sign on the home screen.
   Flagged here as a decision the reviewer can make.

Acceptance: in approval mode, a pending request lands on the approval screen (locked or
unlocked); after approve the window stays open on home/assets; the "Request" tab returns
to a still-pending approval with acknowledgements and countdown intact.

### Slice 4: CSS migration + tests

CSS (`global.css`):
- Introduce a single `.ec-approval-screen` class and mechanically re-scope every
  `.ec-request-shell <descendant>` rule to `.ec-approval-screen <descendant>` (the flat
  review-card treatment, the tinted full-width coverage band with per-tone backgrounds,
  the eyebrow h2/h3, the 13px/20px type scale, the full-bleed topbar reset). Folding into
  `.ec-task-screen` alone would silently drop roughly 125 lines of approval styling and
  the approval cards would regress to the popup's raised, bordered default cards.
- Split the shared `.ec-auth-shell, .ec-request-shell { ... }` co-declarations so
  `.ec-auth-shell` keeps its styling when `.ec-request-shell` is retired.
- Decide whether the coverage band keeps its edge-to-edge bleed inside `ec-shell__main`
  (which has gutters) or moves inboard to match the popup's boxed cover strip. Pick one to
  avoid a half-migrated look. Default: boxed inboard, matching the popup.
- `request/main.tsx` drops the `documentElement` width/height 100% override so the window
  uses the fixed 360x600 `ec-shell` like the popup. The window is already sized (376x632)
  for a 360x600 content shell, so it centers with no gap.

`request/index.html`: normalize the title (remove the em dash, e.g. "Ember Wallet"); keep
it loading `./main.tsx` so WXT still emits `request.html`.

e2e (`connect-sign.spec.ts`):
- The approval window is still a separate page captured via `context.waitForEvent('page')`.
- App now boots through loading/route before showing the approval, so add an explicit
  readiness gate (`expect(signWin.getByTestId('approve')).toBeVisible()`) before asserting
  cover labels.
- In each approve-path test, ADD assertions that the window stays open and shows the
  wallet shell (`wallet-balance` / `main-tabs` visible, back on home/assets) after the
  existing dapp-side signature assertions. Do NOT assert a numeric balance change.
- For covered paths, assert the signed signature appears in `wallet-activity` (the pending
  cover-record path). Do not assert an Activity row in flows where cover is unavailable
  (no record is written when there is no decision or no derivable signature).
- Keep the close-before-approve reject test as-is; add a distinct close-after-approve test
  asserting the dapp result is unchanged (no spurious "Request closed").
- The locked-vault cover test keeps asserting `password` and the `cover` banner on the same
  approval screen before unlock, then asserts that after unlock + approve the window shows
  the wallet shell and stays open.

There are no spec files importing `RequestApp`, so there is nothing to "repoint"; the only
references are `request/main.tsx` and the component file itself.

## Edge cases

- No pending request when the approval window loads: show the wallet home.
- No vault yet with a pending request: App's create flow shows; after create, route to the
  approval screen (the routing effect depends on `view` so it fires after `onCreate`).
- A second dapp request after a sign: it opens its own new window as today; the first,
  still-open window is on home with no pending request and cannot drive the new one (the
  nonce guarantees this even if it tried).
- Two App instances live at once (toolbar popup + approval window) share vault state via the
  SW. The approval window must unlock independently and route unlock -> approval, never
  depending on the toolbar popup being open.

## Test plan summary

- Unit (`request-service.spec.ts`): clear-not-remove on approve; onRemoved-after-approve
  no-op; reject still removes; stale-id rejected; ordering (clear before awaited record).
- e2e (`connect-sign.spec.ts`): readiness gate; window-stays-open + wallet shell after
  approve; activity pending row on covered paths; close-before vs close-after-approve;
  locked-vault password + cover coexist, then unlock + approve stays open.
- Manual: toggle to/from the Request tab during approval and confirm acknowledgements and
  the cover countdown survive; confirm the toolbar popup's `main-tabs` still shows exactly
  two items (no "Request" item in wallet mode).

## Out of scope / future

- Per-request queueing (more than one pending request at a time) stays as today: `create()`
  throws "Request already exists" for a concurrent second request.
- Broadcasting dapp-signed transactions from the wallet is not added; the wallet signs only.
