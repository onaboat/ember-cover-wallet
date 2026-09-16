import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import type {
  OperatorJob,
  OperatorJobInput,
  OperatorResult,
  OperatorState,
} from './protocol.ts'
import { parseConformanceSignerWalletName } from './signer-wallet.ts'

const MAX_BODY_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

interface PendingJob {
  job: OperatorJob
  reject(error: Error): void
  resolve(result: OperatorResult): void
  timer: ReturnType<typeof setTimeout>
}

interface OperatorBridgeOptions {
  operatorScript?: string
  timeoutMs?: number
  walletName: string
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  response.end(`${JSON.stringify(value)}\n`)
}

function text(
  response: ServerResponse,
  status: number,
  contentType: string,
  value: string,
): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'content-type': contentType,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  response.end(value)
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > MAX_BODY_BYTES) throw new Error('Operator request body is too large')
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('Operator request body is not valid JSON')
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Operator request body must be an object')
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Operator field ${field} is required`)
  }
  return value
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&#39;')
}

function operatorPage(token: string, walletName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="ember-operator-token" content="${token}">
  <meta name="ember-operator-wallet-name" content="${escapeHtmlAttribute(walletName)}">
  <title>Ember API conformance operator</title>
  <link rel="stylesheet" href="/operator.css?token=${token}">
</head>
<body>
  <main>
    <p class="eyebrow">Local Devnet operator</p>
    <h1>Ember API conformance</h1>
    <p id="status">Connect the configured external wallet to begin.</p>
    <button id="connect" type="button">Connect external wallet</button>
    <section id="job" hidden>
      <h2 id="job-title"></h2>
      <dl id="summary"></dl>
      <p class="warning">Review every value. The wallet will ask for a separate approval.</p>
      <button id="approve" type="button">Continue to wallet approval</button>
      <button id="reject" type="button">Reject request</button>
    </section>
  </main>
  <script src="/operator.js?token=${token}"></script>
</body>
</html>`
}

const OPERATOR_CSS = `
:root { color-scheme: dark; font: 16px/1.5 system-ui, sans-serif; background: #111318; color: #f3f4f6; }
body { margin: 0; }
main { max-width: 44rem; margin: 0 auto; padding: 3rem 1.25rem; }
.eyebrow { color: #f59e0b; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
section { margin-top: 2rem; padding: 1.25rem; border: 1px solid #374151; border-radius: 12px; background: #181b22; }
dl { display: grid; grid-template-columns: 12rem 1fr; gap: .5rem 1rem; }
dt { color: #9ca3af; } dd { margin: 0; overflow-wrap: anywhere; }
button { margin: .5rem .5rem .5rem 0; padding: .75rem 1rem; border-radius: 8px; border: 0; font-weight: 700; cursor: pointer; }
#approve, #connect { background: #f59e0b; color: #111318; }
#reject { background: #374151; color: #f3f4f6; }
.warning { color: #fbbf24; }
button:disabled { opacity: .45; cursor: not-allowed; }
`

export class OperatorBridge {
  readonly token = randomBytes(32).toString('hex')
  readonly timeoutMs: number
  readonly walletName: string

  private connectedWallet: string | null = null
  private operatorScript = ''
  private pendingJob: PendingJob | null = null
  private server: Server | null = null
  private walletWaiters: Array<{
    reject(error: Error): void
    resolve(walletAddress: string): void
    timer: ReturnType<typeof setTimeout>
  }> = []

  private constructor(options: OperatorBridgeOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.operatorScript = options.operatorScript ?? ''
    this.walletName = parseConformanceSignerWalletName(options.walletName)
  }

  static async start(options: OperatorBridgeOptions): Promise<OperatorBridge> {
    const bridge = new OperatorBridge(options)
    if (!options.operatorScript) {
      bridge.operatorScript = await readFile(
        new URL('./operator.js', import.meta.url),
        'utf8',
      )
    }
    await bridge.listen()
    return bridge
  }

  get operatorUrl(): string {
    const server = this.server
    if (!server) throw new Error('Operator bridge is not running')
    const address = server.address() as AddressInfo | null
    if (!address) throw new Error('Operator bridge address is unavailable')
    return `http://127.0.0.1:${address.port}/?token=${this.token}`
  }

  async close(): Promise<void> {
    const error = new Error('Operator bridge closed')
    this.pendingJob?.reject(error)
    if (this.pendingJob) clearTimeout(this.pendingJob.timer)
    this.pendingJob = null
    for (const waiter of this.walletWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.walletWaiters = []
    const server = this.server
    this.server = null
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((closeError) => (closeError ? reject(closeError) : resolve())),
      )
    }
  }

  async waitForWallet(): Promise<string> {
    if (this.connectedWallet) return this.connectedWallet
    return await new Promise<string>((resolve, reject) => {
      const waiter = {
        reject,
        resolve,
        timer: setTimeout(() => {
          this.walletWaiters = this.walletWaiters.filter(
            (candidate) => candidate !== waiter,
          )
          reject(new Error('Timed out waiting for the operator wallet'))
        }, this.timeoutMs),
      }
      this.walletWaiters.push(waiter)
    })
  }

  async request(job: OperatorJobInput): Promise<OperatorResult> {
    if (!this.connectedWallet) throw new Error('Operator wallet is not connected')
    if (this.pendingJob) throw new Error('An operator request is already pending')
    const completeJob = { ...job, id: randomUUID() } as OperatorJob
    return await new Promise<OperatorResult>((resolve, reject) => {
      const pending: PendingJob = {
        job: completeJob,
        reject,
        resolve,
        timer: setTimeout(() => {
          if (this.pendingJob === pending) this.pendingJob = null
          reject(new Error('Operator approval timed out'))
        }, this.timeoutMs),
      }
      this.pendingJob = pending
    })
  }

  private async listen(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        json(response, 400, {
          error: error instanceof Error ? error.message : 'Operator request failed',
        })
      })
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => resolve())
    })
    this.server.unref()
  }

  private authorized(request: IncomingMessage, url: URL): boolean {
    return (
      request.headers.authorization === `Bearer ${this.token}` ||
      url.searchParams.get('token') === this.token
    )
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (!this.authorized(request, url)) {
      json(response, 401, { error: 'Unauthorized' })
      return
    }
    if (request.method === 'GET' && url.pathname === '/') {
      text(
        response,
        200,
        'text/html; charset=utf-8',
        operatorPage(this.token, this.walletName),
      )
      return
    }
    if (request.method === 'GET' && url.pathname === '/operator.js') {
      text(response, 200, 'text/javascript; charset=utf-8', this.operatorScript)
      return
    }
    if (request.method === 'GET' && url.pathname === '/operator.css') {
      text(response, 200, 'text/css; charset=utf-8', OPERATOR_CSS)
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/state') {
      const state: OperatorState = {
        connectedWallet: this.connectedWallet,
        job: this.pendingJob?.job ?? null,
        walletName: this.walletName,
      }
      json(response, 200, state)
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/connect') {
      const body = record(await readJsonBody(request))
      const walletName = requiredString(body.walletName, 'walletName')
      if (walletName !== this.walletName) {
        throw new Error('Connected wallet does not match the configured conformance signer')
      }
      const walletAddress = requiredString(body.walletAddress, 'walletAddress')
      if (this.connectedWallet && this.connectedWallet !== walletAddress) {
        throw new Error('Operator wallet cannot change during a conformance run')
      }
      this.connectedWallet = walletAddress
      for (const waiter of this.walletWaiters) {
        clearTimeout(waiter.timer)
        waiter.resolve(walletAddress)
      }
      this.walletWaiters = []
      json(response, 200, { connectedWallet: walletAddress })
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/result') {
      const body = record(await readJsonBody(request))
      const pending = this.pendingJob
      if (!pending) throw new Error('No operator request is pending')
      const id = requiredString(body.id, 'id')
      if (pending.job.id !== id) throw new Error('Operator result is stale')
      const outcome = requiredString(body.outcome, 'outcome')
      let result: OperatorResult
      if (outcome === 'rejected') {
        result = {
          id,
          outcome,
          reason: requiredString(body.reason, 'reason'),
        }
      } else if (outcome === 'signed_message' && pending.job.kind === 'sign_message') {
        result = {
          id,
          outcome,
          signatureBase64: requiredString(body.signatureBase64, 'signatureBase64'),
          signedMessageBase64: requiredString(
            body.signedMessageBase64,
            'signedMessageBase64',
          ),
          walletAddress: requiredString(body.walletAddress, 'walletAddress'),
        }
      } else if (
        outcome === 'signed_transaction' &&
        pending.job.kind === 'sign_transaction'
      ) {
        result = {
          id,
          outcome,
          signedTransactionBase64: requiredString(
            body.signedTransactionBase64,
            'signedTransactionBase64',
          ),
          walletAddress: requiredString(body.walletAddress, 'walletAddress'),
        }
      } else {
        throw new Error('Operator result does not match the pending request')
      }
      if (
        'walletAddress' in result &&
        result.walletAddress !== this.connectedWallet
      ) {
        throw new Error('Operator result came from a different wallet')
      }
      clearTimeout(pending.timer)
      this.pendingJob = null
      pending.resolve(result)
      json(response, 200, { accepted: true })
      return
    }
    json(response, 404, { error: 'Not found' })
  }
}
