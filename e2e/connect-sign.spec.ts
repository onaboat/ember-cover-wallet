import { mkdtemp, readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { type BrowserContext, chromium, expect, type Page, test } from '@playwright/test'
import {
  address as toAddress,
  blockhash as toBlockhash,
  compileTransaction,
  createTransactionMessage,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'

import { startCoverProxy } from './fixtures/cover-proxy-server.ts'

declare global {
  interface Window {
    __getWallets?: () => string[]
    __expectedMessage?: () => number[]
    __setTxBytes?: (bytes: number[]) => void
    __silentConnect?: () => Promise<number>
  }
}

function buildTx(feePayer: string): Uint8Array {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(toAddress(feePayer), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: toBlockhash('11111111111111111111111111111111'), lastValidBlockHeight: 0n },
        m,
      ),
  )
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)))
}

const EXT = path.resolve('.output/chrome-mv3')
const DAPP_FILE = path.resolve('e2e/fixtures/dapp.html')
const PASSWORD = 'Str0ng-pass-correct-horse'

// The wallet's content scripts (the MAIN-world provider + the ISOLATED bridge) are scoped to
// http(s) ONLY, deliberately not file:// or chrome://. So the dapp MUST be served over http for the
// wallet-standard provider to register. Serve the fixture from an ephemeral localhost server.
let server: Server
let dappUrl: string
let coverServer: Server

test.beforeAll(async () => {
  const html = await readFile(DAPP_FILE, 'utf8')
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no server port')
  dappUrl = `http://127.0.0.1:${address.port}/dapp.html`

  // warm the scale-to-zero devnet API
  await fetch('https://ember-v4-api-devnet.fly.dev/v1/cover/pre-sign', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-partner-key' },
    body: '{}',
  }).catch(() => {})
  coverServer = await startCoverProxy(8787)
})

test.afterAll(async () => {
  // Drop any lingering keep-alive sockets so close() resolves promptly.
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  coverServer.closeAllConnections()
  await new Promise<void>((resolve) => coverServer.close(() => resolve()))
})

async function launch(): Promise<{ context: BrowserContext; extensionId: string }> {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'ember-cover-wallet-'))
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  })
  let [sw] = context.serviceWorkers()
  if (!sw) sw = await context.waitForEvent('serviceworker')
  return { context, extensionId: new URL(sw.url()).host }
}

async function createVault(context: BrowserContext, extensionId: string): Promise<void> {
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  await popup.getByTestId('password').fill(PASSWORD)
  await popup.getByTestId('submit').click()
  await expect(popup.getByTestId('address')).toBeVisible({ timeout: 30000 })
  await popup.close()
}

async function enableCover(context: BrowserContext, extensionId: string): Promise<void> {
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  await expect(popup.getByTestId('address')).toBeVisible({ timeout: 30000 })
  await popup.getByTestId('enable-cover').click()
  await expect(popup.getByTestId('cover-status')).toBeVisible({ timeout: 30000 })
  await popup.close()
}

async function acknowledgeApprovalWarnings(page: Page): Promise<void> {
  const hasCoverSurface =
    (await page.getByTestId('tx').isVisible().catch(() => false)) ||
    (await page.getByTestId('message-overview').isVisible().catch(() => false))
  if (hasCoverSurface) {
    await expect(page.getByTestId('cover')).toBeVisible({ timeout: 7000 })
    await expect(page.getByTestId('approve')).not.toHaveText('Checking cover...', { timeout: 7000 })
  }
  for (const testId of ['cover-ack', 'impact-ack', 'message-ack']) {
    const checkbox = page.getByTestId(testId)
    if (await checkbox.isVisible()) {
      await checkbox.check()
    }
  }
}

test('dapp connects and gets a signature verifiable against the pubkey over the exact bytes', async () => {
  const { context, extensionId } = await launch()
  await createVault(context, extensionId)

  const dapp = await context.newPage()
  await dapp.goto(dappUrl)
  await expect.poll(() => dapp.evaluate(() => window.__getWallets?.() ?? [])).toContain('Ember')

  const connectApproval = context.waitForEvent('page')
  await dapp.getByRole('button', { name: 'Connect' }).click()
  const connectWin = await connectApproval
  await connectWin.getByTestId('approve').click()

  await expect.poll(() => dapp.locator('#out').getAttribute('data-address'), { timeout: 15000 }).not.toBeNull()
  const address = await dapp.locator('#out').getAttribute('data-address')
  expect((address ?? '').length).toBeGreaterThan(31)
  const pubkey = JSON.parse((await dapp.locator('#out').getAttribute('data-pubkey')) ?? '[]') as number[]
  expect(pubkey).toHaveLength(32)

  const signApproval = context.waitForEvent('page')
  await dapp.getByRole('button', { name: 'Sign', exact: true }).click()
  const signWin = await signApproval
  await acknowledgeApprovalWarnings(signWin)
  await signWin.getByTestId('approve').click()

  await expect(dapp.locator('#out')).toContainText('signed:64', { timeout: 15000 })
  const sig = JSON.parse((await dapp.locator('#out').getAttribute('data-sig')) ?? '[]') as number[]
  const signed = JSON.parse((await dapp.locator('#out').getAttribute('data-signed')) ?? '[]') as number[]
  expect(sig).toHaveLength(64)

  // CONTRACT GATE: the signed bytes MUST equal exactly what the dapp sent (no self-consistent corruption).
  const expected = (await dapp.evaluate(() => window.__expectedMessage?.() ?? [])) as number[]
  expect(signed).toEqual(expected)

  // CRYPTO GATE: verify the signature against the connected pubkey over signedMessage.
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

test('risky readable messages require acknowledgement before signing', async () => {
  const { context, extensionId } = await launch()
  await createVault(context, extensionId)

  const dapp = await context.newPage()
  await dapp.goto(dappUrl)
  await expect.poll(() => dapp.evaluate(() => window.__getWallets?.() ?? [])).toContain('Ember')

  const connectApproval = context.waitForEvent('page')
  await dapp.getByRole('button', { name: 'Connect' }).click()
  const connectWin = await connectApproval
  await connectWin.getByTestId('approve').click()
  await expect.poll(() => dapp.locator('#out').getAttribute('data-address'), { timeout: 15000 }).not.toBeNull()

  const signApproval = context.waitForEvent('page')
  await dapp.getByRole('button', { name: 'Sign Risk Message' }).click()
  const signWin = await signApproval

  await expect(signWin.getByTestId('cover')).toBeVisible({ timeout: 7000 })
  await expect(signWin.getByTestId('message-warning')).toHaveText('This message references a different site.')
  await expect(signWin.getByTestId('approve')).toHaveText('Sign without cover')
  await expect(signWin.getByTestId('approve')).toBeDisabled()
  await signWin.getByTestId('cover-ack').check()
  await expect(signWin.getByTestId('approve')).toHaveText('Acknowledge message risk')
  await expect(signWin.getByTestId('approve')).toBeDisabled()
  await signWin.getByTestId('message-ack').check()
  await expect(signWin.getByTestId('approve')).toHaveText('Sign message')
  await signWin.getByTestId('approve').click()

  await expect(dapp.locator('#out')).toContainText('signed-risk:64', { timeout: 15000 })

  await context.close()
})

test('approved dapp silently reconnects after the vault is locked', async () => {
  const { context, extensionId } = await launch()
  await createVault(context, extensionId)

  const dapp = await context.newPage()
  await dapp.goto(dappUrl)
  await expect.poll(() => dapp.evaluate(() => window.__getWallets?.() ?? [])).toContain('Ember')

  const connectApproval = context.waitForEvent('page')
  await dapp.getByRole('button', { name: 'Connect' }).click()
  const connectWin = await connectApproval
  await connectWin.getByTestId('approve').click()
  await expect.poll(() => dapp.locator('#out').getAttribute('data-address'), { timeout: 15000 }).not.toBeNull()
  const address = (await dapp.locator('#out').getAttribute('data-address')) as string

  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  await popup.getByTestId('lock').click()
  await expect(popup.getByTestId('submit')).toBeVisible({ timeout: 10000 })
  await popup.close()

  await dapp.reload()
  await expect.poll(() => dapp.evaluate(() => window.__getWallets?.() ?? [])).toContain('Ember')
  const restored = await dapp.evaluate(() => window.__silentConnect?.() ?? Promise.resolve(0))

  expect(restored).toBe(1)
  expect(await dapp.locator('#out').getAttribute('data-address')).toBe(address)

  await context.close()
})

test('dapp signs a transaction and the vault signature verifies over its messageBytes', async () => {
  const { context, extensionId } = await launch()
  await createVault(context, extensionId)

  const dapp = await context.newPage()
  await dapp.goto(dappUrl)
  await expect.poll(() => dapp.evaluate(() => window.__getWallets?.() ?? [])).toContain('Ember')

  // connect
  const connectApproval = context.waitForEvent('page')
  await dapp.getByRole('button', { name: 'Connect' }).click()
  const connectWin = await connectApproval
  await connectWin.getByTestId('approve').click()
  await expect.poll(() => dapp.locator('#out').getAttribute('data-address'), { timeout: 15000 }).not.toBeNull()
  const address = (await dapp.locator('#out').getAttribute('data-address')) as string
  const pubkey = JSON.parse((await dapp.locator('#out').getAttribute('data-pubkey')) ?? '[]') as number[]
  expect(pubkey).toHaveLength(32)

  // build a transaction whose fee payer is the connected address, hand it to the dapp
  const txBytes = buildTx(address)
  await dapp.evaluate((bytes) => window.__setTxBytes?.(bytes), Array.from(txBytes))

  // sign the transaction (approve in the popup)
  const signApproval = context.waitForEvent('page')
  await dapp.getByRole('button', { name: 'Sign Tx', exact: true }).click()
  const signWin = await signApproval
  await acknowledgeApprovalWarnings(signWin)
  await signWin.getByTestId('approve').click()
  await expect.poll(() => dapp.locator('#out').getAttribute('data-signedtx'), { timeout: 15000 }).not.toBeNull()
  const signedTx = JSON.parse((await dapp.locator('#out').getAttribute('data-signedtx')) ?? '[]') as number[]

  // CRYPTO GATE: decode the signed tx, verify the signature over messageBytes against the pubkey
  const decoded = getTransactionDecoder().decode(new Uint8Array(signedTx))
  const sig = decoded.signatures[toAddress(address)]
  expect(sig).not.toBeNull()
  const key = await crypto.subtle.importKey('raw', new Uint8Array(pubkey), { name: 'Ed25519' }, false, ['verify'])
  const verified = await crypto.subtle.verify(
    'Ed25519',
    key,
    new Uint8Array(sig as Uint8Array),
    new Uint8Array(decoded.messageBytes),
  )
  expect(verified).toBe(true)

  await context.close()
})

test('batch transaction requests are visible and cannot be approved', async () => {
  const { context, extensionId } = await launch()
  await createVault(context, extensionId)

  const dapp = await context.newPage()
  await dapp.goto(dappUrl)
  await expect.poll(() => dapp.evaluate(() => window.__getWallets?.() ?? [])).toContain('Ember')

  const connectApproval = context.waitForEvent('page')
  await dapp.getByRole('button', { name: 'Connect' }).click()
  const connectWin = await connectApproval
  await connectWin.getByTestId('approve').click()
  await expect.poll(() => dapp.locator('#out').getAttribute('data-address'), { timeout: 15000 }).not.toBeNull()
  const address = (await dapp.locator('#out').getAttribute('data-address')) as string

  await dapp.evaluate((bytes) => window.__setTxBytes?.(bytes), Array.from(buildTx(address)))

  const signApproval = context.waitForEvent('page')
  await dapp.getByRole('button', { name: 'Sign Tx Batch' }).click()
  const signWin = await signApproval

  await expect(signWin.getByTestId('batch-warning')).toContainText('Multiple transactions')
  await expect(signWin.getByTestId('approve')).toHaveText('Cannot sign batch')
  await expect(signWin.getByTestId('approve')).toBeDisabled()
  await signWin.getByTestId('reject').click()
  await expect.poll(() => dapp.locator('#out').getAttribute('data-error'), { timeout: 10000 }).not.toBeNull()

  await context.close()
})

test('signTransaction shows a real cover decision from the devnet engine', async () => {
  const { context, extensionId } = await launch()
  await createVault(context, extensionId)
  await enableCover(context, extensionId)

  const dapp = await context.newPage()
  await dapp.goto(dappUrl)
  await expect.poll(() => dapp.evaluate(() => window.__getWallets?.() ?? [])).toContain('Ember')

  // connect
  const connectApproval = context.waitForEvent('page')
  await dapp.getByRole('button', { name: 'Connect' }).click()
  const connectWin = await connectApproval
  await connectWin.getByTestId('approve').click()
  await expect.poll(() => dapp.locator('#out').getAttribute('data-address'), { timeout: 15000 }).not.toBeNull()
  const address = (await dapp.locator('#out').getAttribute('data-address')) as string

  // hand the dapp a transaction whose fee payer is the connected address
  await dapp.evaluate((bytes) => window.__setTxBytes?.(bytes), Array.from(buildTx(address)))

  // sign tx -> the approval window opens and the cover banner must RESOLVE (not stay "Checking…")
  const signApproval = context.waitForEvent('page')
  await dapp.getByRole('button', { name: 'Sign Tx', exact: true }).click()
  const signWin = await signApproval

  const banner = signWin.getByTestId('cover')
  await expect(banner).toBeVisible({ timeout: 15000 })
  await expect(banner).not.toHaveText('Checking cover...', { timeout: 15000 })
  const label = await banner.textContent()
  const tone = await banner.getAttribute('data-tone')
  console.log(`[COVER DECISION] label="${label}" tone="${tone}"`)
  expect(label, 'cover must be a real engine decision, not a fail-open').not.toBe('Cover unavailable')
  const cap = signWin.getByTestId('cover-cap')
  await expect(cap).toContainText('Ember Cover check', { timeout: 15000 })
  console.log(`[COVER CAP] ${await cap.textContent()}`)

  // approve (vault unlocked earlier; post-sign fires best-effort)
  await acknowledgeApprovalWarnings(signWin)
  await signWin.getByTestId('approve').click()
  await expect.poll(() => dapp.locator('#out').getAttribute('data-signedtx'), { timeout: 15000 }).not.toBeNull()

  await context.close()
})

test('two-sig: cover shows a real engine decision while the vault is LOCKED (before unlock)', async () => {
  const { context, extensionId } = await launch()

  // 1. Create + unlock, enable cover (one-time enroll: vault authorizes the session key + registers).
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  await popup.getByTestId('password').fill(PASSWORD)
  await popup.getByTestId('submit').click()
  await expect(popup.getByTestId('address')).toBeVisible({ timeout: 30000 })
  await popup.getByTestId('enable-cover').click()
  await expect(popup.getByTestId('cover-status')).toBeVisible({ timeout: 30000 }) // enroll succeeded (registered)
  await popup.close()

  // 2. Connect while unlocked.
  const dapp = await context.newPage()
  await dapp.goto(dappUrl)
  await expect.poll(() => dapp.evaluate(() => window.__getWallets?.() ?? [])).toContain('Ember')
  const connectApproval = context.waitForEvent('page')
  await dapp.getByRole('button', { name: 'Connect' }).click()
  await (await connectApproval).getByTestId('approve').click()
  await expect.poll(() => dapp.locator('#out').getAttribute('data-address'), { timeout: 15000 }).not.toBeNull()
  const address = (await dapp.locator('#out').getAttribute('data-address')) as string

  // 3. LOCK the vault (reopen popup, click Lock) so the next approval opens locked.
  const popup2 = await context.newPage()
  await popup2.goto(`chrome-extension://${extensionId}/popup.html`)
  await popup2.getByTestId('lock').click()
  await expect(popup2.getByTestId('submit')).toBeVisible({ timeout: 10000 }) // back to the unlock view
  await popup2.close()

  // 4. signTransaction -> approval opens LOCKED; cover must still resolve to a REAL decision.
  await dapp.evaluate((bytes) => window.__setTxBytes?.(bytes), Array.from(buildTx(address)))
  const signApproval = context.waitForEvent('page')
  await dapp.getByRole('button', { name: 'Sign Tx', exact: true }).click()
  const signWin = await signApproval

  await expect(signWin.getByTestId('password')).toBeVisible({ timeout: 10000 }) // vault is LOCKED here
  const banner = signWin.getByTestId('cover')
  await expect(banner).toBeVisible({ timeout: 20000 })
  await expect(banner).not.toHaveText('Checking cover...', { timeout: 20000 })
  const label = await banner.textContent()
  console.log(`[COVER DECISION B] label="${label}" (vault locked)`)
  expect(label, 'cover must be a real engine decision, not a fail-open').not.toBe('Cover unavailable')

  // 5. Unlock + approve to finish.
  await signWin.getByTestId('password').fill(PASSWORD)
  await acknowledgeApprovalWarnings(signWin)
  await signWin.getByTestId('approve').click()
  await expect.poll(() => dapp.locator('#out').getAttribute('data-signedtx'), { timeout: 15000 }).not.toBeNull()

  await context.close()
})

test('closing the approval window rejects the dapp promise', async () => {
  const { context, extensionId } = await launch()
  await createVault(context, extensionId)

  const dapp = await context.newPage()
  await dapp.goto(dappUrl)
  await expect.poll(() => dapp.evaluate(() => window.__getWallets?.() ?? [])).toContain('Ember')

  const approval = context.waitForEvent('page')
  await dapp.getByRole('button', { name: 'Connect' }).click()
  const win = await approval
  await win.close()

  // connect() must reject: data-error gets set, data-address is never written.
  await expect.poll(() => dapp.locator('#out').getAttribute('data-error'), { timeout: 10000 }).not.toBeNull()
  expect(await dapp.locator('#out').getAttribute('data-address')).toBeNull()

  await context.close()
})
