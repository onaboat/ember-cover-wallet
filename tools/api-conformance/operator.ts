import { getWallets } from '@wallet-standard/core'

import { decodeBase64, encodeBase64 } from './protocol.ts'
import type { OperatorJob, OperatorState } from './protocol.ts'

interface OperatorAccount {
  address: string
}

interface OperatorWallet {
  accounts: readonly OperatorAccount[]
  features: {
    'standard:connect': {
      connect(): Promise<{ accounts: readonly OperatorAccount[] }>
    }
    'solana:signMessage': {
      signMessage(input: {
        account: OperatorAccount
        message: Uint8Array
      }): Promise<readonly { signature: Uint8Array; signedMessage: Uint8Array }[]>
    }
    'solana:signTransaction': {
      signTransaction(input: {
        account: OperatorAccount
        chain: 'solana:devnet'
        transaction: Uint8Array
      }): Promise<readonly { signedTransaction: Uint8Array }[]>
    }
  }
  name: string
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id)
  if (!value) throw new Error(`Operator page is missing ${id}`)
  return value as T
}

function metaContent(name: string): string {
  const value = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content
  if (!value) throw new Error(`Operator metadata ${name} is unavailable`)
  return value
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function'
}

function isOperatorWallet(value: unknown, expectedName: string): value is OperatorWallet {
  if (!value || typeof value !== 'object') return false
  const wallet = value as {
    accounts?: unknown
    features?: Record<string, unknown>
    name?: unknown
  }
  if (wallet.name !== expectedName || !Array.isArray(wallet.accounts) || !wallet.features) {
    return false
  }
  const connect = wallet.features['standard:connect'] as
    | { connect?: unknown }
    | undefined
  const signMessage = wallet.features['solana:signMessage'] as
    | { signMessage?: unknown }
    | undefined
  const signTransaction = wallet.features['solana:signTransaction'] as
    | { signTransaction?: unknown }
    | undefined
  return (
    isFunction(connect?.connect) &&
    isFunction(signMessage?.signMessage) &&
    isFunction(signTransaction?.signTransaction)
  )
}

const token = metaContent('ember-operator-token')
const walletName = metaContent('ember-operator-wallet-name')

const status = element<HTMLParagraphElement>('status')
const connectButton = element<HTMLButtonElement>('connect')
const jobSection = element<HTMLElement>('job')
const jobTitle = element<HTMLHeadingElement>('job-title')
const summary = element<HTMLDListElement>('summary')
const approveButton = element<HTMLButtonElement>('approve')
const rejectButton = element<HTMLButtonElement>('reject')
status.textContent = `Connect ${walletName} to begin.`
connectButton.textContent = `Connect ${walletName}`

let wallet: OperatorWallet | null = null
let account: OperatorAccount | null = null
let currentJob: OperatorJob | null = null
let busy = false

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  const body = (await response.json()) as unknown
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Operator request failed (${response.status})`
    throw new Error(message)
  }
  return body
}

function renderJob(job: OperatorJob | null): void {
  currentJob = job
  jobSection.hidden = job === null
  summary.replaceChildren()
  if (!job) return
  jobTitle.textContent = job.summary.title
  for (const [label, value] of Object.entries(job.summary)) {
    if (label === 'title') continue
    const term = document.createElement('dt')
    term.textContent = label.replaceAll(/([A-Z])/g, ' $1').toLowerCase()
    const description = document.createElement('dd')
    description.textContent = String(value)
    summary.append(term, description)
  }
  approveButton.disabled = busy || !account
  rejectButton.disabled = busy
}

async function refresh(): Promise<void> {
  const state = (await api('/api/state')) as OperatorState
  if (state.connectedWallet && account?.address !== state.connectedWallet) {
    status.textContent = `The run is bound to ${state.connectedWallet}. Reconnect that wallet.`
    approveButton.disabled = true
  }
  renderJob(state.job)
}

async function connectWallet(): Promise<void> {
  const availableWallets: readonly unknown[] = getWallets().get()
  const candidate = availableWallets.find((value) => isOperatorWallet(value, walletName))
  if (!candidate) {
    throw new Error(`${walletName} is not available in this browser`)
  }
  const connected = await candidate.features['standard:connect'].connect()
  const selected = connected.accounts[0] ?? candidate.accounts[0]
  if (!selected?.address) throw new Error(`${walletName} returned no account`)
  wallet = candidate
  account = selected
  await api('/api/connect', {
    method: 'POST',
    body: JSON.stringify({ walletAddress: selected.address, walletName }),
  })
  status.textContent = `Connected ${selected.address}. Waiting for the runner.`
  connectButton.disabled = true
  await refresh()
}

async function submitResult(result: Record<string, string>): Promise<void> {
  await api('/api/result', {
    method: 'POST',
    body: JSON.stringify(result),
  })
}

async function approve(): Promise<void> {
  if (!wallet || !account || !currentJob || busy) return
  busy = true
  renderJob(currentJob)
  try {
    if (currentJob.kind === 'sign_message') {
      const outputs = await wallet.features['solana:signMessage'].signMessage({
        account,
        message: decodeBase64(currentJob.messageBase64),
      })
      const output = outputs[0]
      if (!output) throw new Error('The wallet returned no message signature')
      await submitResult({
        id: currentJob.id,
        outcome: 'signed_message',
        signatureBase64: encodeBase64(output.signature),
        signedMessageBase64: encodeBase64(output.signedMessage),
        walletAddress: account.address,
      })
    } else {
      const outputs = await wallet.features['solana:signTransaction'].signTransaction({
        account,
        chain: 'solana:devnet',
        transaction: decodeBase64(currentJob.transactionBase64),
      })
      const output = outputs[0]
      if (!output) throw new Error('The wallet returned no signed transaction')
      await submitResult({
        id: currentJob.id,
        outcome: 'signed_transaction',
        signedTransactionBase64: encodeBase64(output.signedTransaction),
        walletAddress: account.address,
      })
    }
    status.textContent = 'Wallet approval completed. Waiting for the runner.'
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Wallet approval failed'
  } finally {
    busy = false
    await refresh()
  }
}

async function reject(): Promise<void> {
  if (!currentJob || busy) return
  busy = true
  try {
    await submitResult({
      id: currentJob.id,
      outcome: 'rejected',
      reason: 'Rejected by the local operator',
    })
    status.textContent = 'Request rejected.'
  } finally {
    busy = false
    await refresh()
  }
}

connectButton.addEventListener('click', () => {
  void connectWallet().catch((error: unknown) => {
    status.textContent = error instanceof Error ? error.message : 'Wallet connection failed'
  })
})
approveButton.addEventListener('click', () => void approve())
rejectButton.addEventListener('click', () => void reject())

setInterval(() => {
  if (!busy) void refresh().catch(() => undefined)
}, 750)
void refresh()
