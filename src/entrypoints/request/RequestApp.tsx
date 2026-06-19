import { useEffect, useState } from 'react'

import type { PendingRequestView } from '../../background/request-service.ts'
import { getRequestApproval } from '../../background/request-service.ts'
import { getVaultService } from '../../background/vault-service.ts'
import { coverCapReviewText } from '../../cover/cover-cap-view.ts'
import type { CoverDebugInfo } from '../../cover/ember-types.ts'
import { bannerView } from '../../cover/cover-banner-view.ts'
import { decodeMessages } from './decode-messages.ts'
import { decodeTransactionSummary, estimateWalletImpact } from './decode-transaction.ts'
import type { TxSummary, TxWalletImpact } from './decode-transaction.ts'

type TxTab = 'details' | 'raw'
type MessageTab = 'message' | 'details'

function shortAddress(value: string | null | undefined): string {
  return value && value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value ?? ''
}

function requestAccountAddress(pending: PendingRequestView | null): string | null {
  if (!pending || (pending.type !== 'signMessage' && pending.type !== 'signTransaction')) {
    return null
  }
  const first = (pending.data as { account?: { address?: string } }[])[0]
  return first?.account?.address ?? null
}

function requestTitle(pending: PendingRequestView, summary: TxSummary | null): string {
  if (pending.type === 'connect') {
    return 'Connect wallet'
  }
  if (pending.type === 'signMessage') {
    const messageCount = (pending.data as unknown[]).length
    if (messageCount > 1) {
      return 'Review multiple messages'
    }
    return 'Sign message'
  }
  const transactionCount = (pending.data as unknown[]).length
  if (transactionCount > 1) {
    return 'Review multiple transactions'
  }
  return summary?.primaryAction.label ?? 'Review transaction'
}

function hostFromOrigin(origin: string | undefined): string | null {
  if (!origin) {
    return null
  }
  try {
    return new URL(origin).host.toLowerCase()
  } catch {
    return null
  }
}

function hostsFromMessage(message: string): string[] {
  const hosts = new Set<string>()
  for (const match of message.matchAll(/\bhttps?:\/\/[^\s"'<>]+/gi)) {
    try {
      hosts.add(new URL(match[0]).host.toLowerCase())
    } catch {
      // Ignore text that looks like a URL but is not valid enough to compare.
    }
  }
  for (const match of message.matchAll(/^\s*(domain|uri):\s*([^\s]+)\s*$/gim)) {
    const value = match[2] ?? ''
    try {
      hosts.add(new URL(value.startsWith('http') ? value : `https://${value}`).host.toLowerCase())
    } catch {
      // Ignore non-host values.
    }
  }
  return [...hosts]
}

function messageRisk(message: string, origin: string | undefined): { requiresAck: boolean; warning: string | null } {
  if (message.startsWith('0x') || message.length > 500) {
    return {
      requiresAck: true,
      warning: 'This message is not human-readable or is unusually long.',
    }
  }
  const originHost = hostFromOrigin(origin)
  const mismatchedHost = originHost ? hostsFromMessage(message).find((host) => host !== originHost) : null
  if (mismatchedHost) {
    return {
      requiresAck: true,
      warning: 'This message references a different site.',
    }
  }
  if (/\b(authorize|permission|delegate|sign in|login|access|session|nonce|withdraw|transfer)\b/i.test(message)) {
    return {
      requiresAck: true,
      warning: 'This message may authorize access with this site.',
    }
  }
  return { requiresAck: false, warning: null }
}

function approvalLabel(args: {
  pending: PendingRequestView
  busy: boolean
  batchUnsupported: boolean
  checkingCover: boolean
  coverExpired: boolean
  coverApproveLabel: string | null
  coverAckRequired: boolean
  coverAcknowledged: boolean
  impactAckRequired: boolean
  impactAcknowledged: boolean
  messageAckRequired: boolean
  messageAcknowledged: boolean
}): string {
  if (args.busy) {
    if (args.coverExpired) {
      return 'Rechecking cover...'
    }
    return args.pending.type === 'connect' ? 'Connecting...' : 'Signing...'
  }
  if (args.batchUnsupported) {
    return 'Cannot sign batch'
  }
  if (args.pending.type === 'connect') {
    return 'Connect'
  }
  if (args.pending.type === 'signMessage') {
    if (args.coverExpired) {
      return 'Recheck cover'
    }
    if (args.checkingCover) {
      return 'Checking cover...'
    }
    if (args.coverAckRequired && !args.coverAcknowledged && args.coverApproveLabel) {
      return args.coverApproveLabel
    }
    return args.messageAckRequired && !args.messageAcknowledged ? 'Acknowledge message risk' : 'Sign message'
  }
  if (args.coverExpired) {
    return 'Recheck cover'
  }
  if (args.checkingCover) {
    return 'Checking cover...'
  }
  if (args.impactAckRequired && !args.impactAcknowledged && !args.coverApproveLabel) {
    return 'Acknowledge unknown changes'
  }
  if (args.coverApproveLabel) {
    return args.coverApproveLabel
  }
  if (args.impactAckRequired) {
    return 'Sign anyway'
  }
  return 'Approve and sign'
}

function ImpactRows({ impact }: { impact: TxWalletImpact }) {
  return (
    <section data-testid="estimated-changes">
      <h2>{impact.title}</h2>
      <dl>
        {impact.rows.map((row) => (
          <div key={`${row.label}:${row.value}`} data-tone={row.tone}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      {impact.warning ? <p data-testid="impact-warning">{impact.warning}</p> : null}
    </section>
  )
}

export function RequestApp() {
  const request = getRequestApproval()
  const vault = getVaultService()

  const [pending, setPending] = useState<PendingRequestView | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const [needsUnlock, setNeedsUnlock] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [coverGaveUp, setCoverGaveUp] = useState(false)
  const [nowMs, setNowMs] = useState(Date.now())
  const [txTab, setTxTab] = useState<TxTab>('details')
  const [messageTab, setMessageTab] = useState<MessageTab>('message')
  const [coverAcknowledged, setCoverAcknowledged] = useState(false)
  const [impactAcknowledged, setImpactAcknowledged] = useState(false)
  const [messageAcknowledged, setMessageAcknowledged] = useState(false)

  useEffect(() => {
    let active = true
    void (async () => {
      setAddress(await vault.getAddress())
      setNeedsUnlock(!(await vault.isUnlocked()))
    })()
    let polls = 0
    const poll = async (): Promise<void> => {
      if (!active) {
        return
      }
      const view = await request.get()
      if (!active) {
        return
      }
      setPending(view)
      polls += 1
      // Keep polling until the cover decision resolves (fail-open ~1.5s) or we give up.
      if ((view?.type === 'signTransaction' || view?.type === 'signMessage') && !view.cover && polls < 5) {
        setTimeout(() => void poll(), 400)
      } else {
        setCoverGaveUp((view?.type === 'signTransaction' || view?.type === 'signMessage') && !view.cover)
      }
    }
    void poll()
    return () => {
      active = false
    }
  }, [])

  const transactionData =
    pending?.type === 'signTransaction'
      ? (pending.data as { transaction: Uint8Array | Record<string, number> }[])
      : []
  const transactionCount = transactionData.length
  const messageCount = pending?.type === 'signMessage' ? (pending.data as unknown[]).length : 0
  const batchUnsupported =
    (pending?.type === 'signTransaction' && transactionCount !== 1) ||
    (pending?.type === 'signMessage' && messageCount !== 1)
  const transactionSummary = transactionData[0] ? decodeTransactionSummary(transactionData[0].transaction) : null
  const signingAddress = requestAccountAddress(pending) ?? address
  const transactionImpact =
    pending?.type === 'signTransaction' ? estimateWalletImpact(transactionSummary, signingAddress) : null
  const fallbackCover: NonNullable<PendingRequestView['cover']> | null =
    (pending?.type === 'signTransaction' || pending?.type === 'signMessage') && coverGaveUp
      ? ({
          coverStatus: 'unavailable',
          riskBand: 'severe',
          decisionExpiresAt: new Date(0).toISOString(),
          debug: {
            stage: 'approval_poll_timeout',
            apiAttempted: false,
          },
        } as NonNullable<PendingRequestView['cover']>)
      : null
  const cover =
    pending?.type === 'signTransaction' || pending?.type === 'signMessage' ? pending.cover ?? fallbackCover : null
  const coverExpired =
    cover?.coverStatus === 'covered' &&
    cover.decisionExpiresAt !== undefined &&
    nowMs >= Date.parse(cover.decisionExpiresAt)
  const checkingCover =
    (pending?.type === 'signTransaction' || pending?.type === 'signMessage') && !cover && !batchUnsupported
  const coverBanner =
    pending?.type === 'signTransaction' || pending?.type === 'signMessage' ? bannerView(cover, checkingCover) : null
  const coverCapText =
    cover?.capContext
      ? coverCapReviewText(cover.coverStatus, cover.capContext, cover.coveredTxCountImpact ?? 0)
      : cover?.coverStatus === 'covered'
        ? 'Cover usage unavailable.'
        : ''
  const decodedMessage =
    pending?.type === 'signMessage'
      ? decodeMessages(pending.data as { message: Uint8Array | Record<string, number> }[])
      : ''
  const messageRiskView = pending?.type === 'signMessage'
    ? messageRisk(decodedMessage, pending.origin)
    : { requiresAck: false, warning: null }
  const coverAckRequired = coverBanner?.showAck ?? false
  const impactAckRequired = pending?.type === 'signTransaction' && !!transactionImpact && !transactionImpact.isComplete
  const messageAckRequired = pending?.type === 'signMessage' && messageRiskView.requiresAck
  const approveDisabled =
    busy ||
    batchUnsupported ||
    (!coverExpired &&
      (checkingCover ||
        (coverAckRequired && !coverAcknowledged) ||
        (impactAckRequired && !impactAcknowledged) ||
        (messageAckRequired && !messageAcknowledged)))
  const approveText = pending
    ? approvalLabel({
        pending,
        busy,
        batchUnsupported,
        checkingCover,
        coverExpired,
        coverApproveLabel: coverBanner?.approveLabel ?? null,
        coverAckRequired,
        coverAcknowledged,
        impactAckRequired,
        impactAcknowledged,
        messageAckRequired,
        messageAcknowledged,
      })
    : 'Approve'

  useEffect(() => {
    setCoverAcknowledged(false)
  }, [coverBanner?.label, coverBanner?.ackLabel])

  useEffect(() => {
    setImpactAcknowledged(false)
  }, [transactionImpact?.warning])

  useEffect(() => {
    setMessageAcknowledged(false)
  }, [decodedMessage])

  useEffect(() => {
    setTxTab('details')
    setMessageTab('message')
  }, [pending?.type, pending?.origin])

  useEffect(() => {
    if (
      (pending?.type !== 'signTransaction' && pending?.type !== 'signMessage') ||
      !cover?.decisionExpiresAt
    ) {
      return
    }
    const timer = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pending?.type, cover?.decisionExpiresAt])

  async function refreshCoverDecision(): Promise<void> {
    setBusy(true)
    setError('')
    setCoverGaveUp(false)
    try {
      const view = await request.refreshCover()
      setPending(view)
      if ((view?.type === 'signTransaction' || view?.type === 'signMessage') && !view.cover) {
        setCoverGaveUp(true)
      }
    } catch (e) {
      setCoverGaveUp(true)
      setError(e instanceof Error ? e.message : 'Could not recheck cover')
    } finally {
      setNowMs(Date.now())
      setBusy(false)
    }
  }

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
    if (!pending || approveDisabled) {
      return
    }
    if (coverExpired) {
      await refreshCoverDecision()
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
      } else if (pending.type === 'signMessage') {
        await request.approveSignMessage()
      } else {
        await request.approveSignTransaction()
      }
      window.close()
    } catch (e) {
      const message = e instanceof Error ? e.message : 'failed'
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

  function CoverDebugPanel({ debug }: { debug: CoverDebugInfo }) {
    return (
      <details data-testid="cover-debug" style={{ margin: '8px 0' }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>Cover debug</summary>
        <pre
          style={{
            background: '#f4f4f5',
            borderRadius: 6,
            fontSize: 11,
            lineHeight: 1.35,
            margin: '6px 0',
            maxHeight: 180,
            overflow: 'auto',
            padding: 8,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {JSON.stringify(debug, null, 2)}
        </pre>
      </details>
    )
  }

  if (!pending) {
    return <p style={{ padding: 16 }}>No pending request.</p>
  }

  return (
    <div style={{ padding: 16, width: 360 }}>
      <h1>{requestTitle(pending, transactionSummary)}</h1>
      {pending.origin ? (
        <p data-testid="origin" style={{ fontWeight: 700, fontSize: 16 }}>
          {pending.origin}
        </p>
      ) : null}
      <p data-testid="account">{address}</p>

      {pending.type === 'connect' ? (
        <section data-testid="connect-summary">
          <p>This site can view your wallet address and request approvals.</p>
        </section>
      ) : null}

      {pending.type === 'signMessage' ? (
        <>
          {batchUnsupported ? (
            <section data-testid="batch-warning">
              <h2>Multiple messages</h2>
              <p>Ember can review one message at a time. Cancel and retry with a single message.</p>
            </section>
          ) : (
            <>
              <section data-testid="message-overview">
                <h2>No transaction</h2>
                <p>This will not move funds, but it may prove ownership or authorize access.</p>
                {messageRiskView.warning ? <p data-testid="message-warning">{messageRiskView.warning}</p> : null}
              </section>
              {coverBanner?.label ? (
                <section data-testid="cover-section">
                  <h2>Cover</h2>
                  <p data-testid="cover" data-tone={coverExpired ? 'unavailable' : coverBanner.tone}>
                    {coverExpired ? 'Cover expired' : coverBanner.label}
                  </p>
                  <p data-testid="cover-body">
                    {coverExpired ? 'Recheck cover before signing.' : coverBanner.body}
                  </p>
                  {coverCapText ? <p data-testid="cover-cap">{coverCapText}</p> : null}
                  {cover?.debug?.stage === 'not_enrolled' ? (
                    <p data-testid="cover-next-step">Activate Ember Cover from the wallet before signing protected approvals.</p>
                  ) : null}
                  {cover?.debug ? <CoverDebugPanel debug={cover.debug} /> : null}
                </section>
              ) : null}
              <div role="tablist" aria-label="Message request">
                <button type="button" aria-selected={messageTab === 'message'} onClick={() => setMessageTab('message')}>
                  Message
                </button>
                <button type="button" aria-selected={messageTab === 'details'} onClick={() => setMessageTab('details')}>
                  Details
                </button>
              </div>
              {messageTab === 'message' ? (
                <pre data-testid="message" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {decodedMessage}
                </pre>
              ) : (
                <section data-testid="message-details">
                  <h2>Message details</h2>
                  <p>Characters {decodedMessage.length}</p>
                  <p>Signer {shortAddress(signingAddress)}</p>
                </section>
              )}
            </>
          )}
        </>
      ) : null}

      {pending.type === 'signTransaction' ? (
        <div data-testid="tx">
          {batchUnsupported ? (
            <section data-testid="batch-warning">
              <h2>Multiple transactions</h2>
              <p>Ember can review one transaction at a time. Cancel and retry with a single transaction.</p>
            </section>
          ) : transactionImpact ? (
            <>
              <ImpactRows impact={transactionImpact} />
              {transactionSummary?.warnings.length ? (
                <ul data-testid="tx-warnings">
                  {transactionSummary.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
          {!batchUnsupported && pending.type === 'signTransaction' && coverBanner?.label ? (
            <section data-testid="cover-section">
              <h2>Cover</h2>
              <p data-testid="cover" data-tone={coverExpired ? 'unavailable' : coverBanner.tone}>
                {coverExpired ? 'Cover expired' : coverBanner.label}
              </p>
              <p data-testid="cover-body">
                {coverExpired ? 'Recheck cover before signing.' : coverBanner.body}
              </p>
              {coverCapText ? <p data-testid="cover-cap">{coverCapText}</p> : null}
              {cover?.debug?.stage === 'not_enrolled' ? (
                <p data-testid="cover-next-step">Activate Ember Cover from the wallet before signing protected approvals.</p>
              ) : null}
              {cover?.debug ? <CoverDebugPanel debug={cover.debug} /> : null}
            </section>
          ) : null}
          {!batchUnsupported ? (
            <div role="tablist" aria-label="Transaction request">
              <button type="button" aria-selected={txTab === 'details'} onClick={() => setTxTab('details')}>
                Details
              </button>
              <button type="button" aria-selected={txTab === 'raw'} onClick={() => setTxTab('raw')}>
                Raw
              </button>
            </div>
          ) : null}
          {!batchUnsupported && txTab === 'details' ? (
            <section data-testid="tx-details">
              {transactionSummary ? (
                <>
                  <h2>Transaction details</h2>
                  {transactionSummary.primaryAction.amount ? <p>Amount {transactionSummary.primaryAction.amount}</p> : null}
                  {transactionSummary.primaryAction.recipient ? <p>To {shortAddress(transactionSummary.primaryAction.recipient)}</p> : null}
                  {transactionSummary.primaryAction.tokenMint ? <p>Token {shortAddress(transactionSummary.primaryAction.tokenMint)}</p> : null}
                  <p>Fee payer {shortAddress(transactionSummary.feePayer)}</p>
                  <h3>Instructions</h3>
                  <ul>
                    {transactionSummary.instructions.map((ix, i) => (
                      <li key={i}>{ix.instructionName ? `${ix.programName}: ${ix.instructionName}` : ix.programName}</li>
                    ))}
                  </ul>
                  {transactionSummary.instructions.length === 0 ? <p>No instructions</p> : null}
                </>
              ) : (
                <p>Transaction details unavailable.</p>
              )}
            </section>
          ) : null}
          {!batchUnsupported && txTab === 'raw' ? (
            <section data-testid="tx-raw">
              <h2>Raw transaction</h2>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{JSON.stringify(pending.data, null, 2)}</pre>
            </section>
          ) : null}
        </div>
      ) : null}

      {!coverExpired && coverAckRequired && coverBanner?.ackLabel ? (
        <label>
          <input
            data-testid="cover-ack"
            type="checkbox"
            checked={coverAcknowledged}
            onChange={(e) => setCoverAcknowledged(e.currentTarget.checked)}
          />
          {coverBanner.ackLabel}
        </label>
      ) : null}
      {impactAckRequired ? (
        <label>
          <input
            data-testid="impact-ack"
            type="checkbox"
            checked={impactAcknowledged}
            onChange={(e) => setImpactAcknowledged(e.currentTarget.checked)}
          />
          I understand balance changes could not be fully estimated.
        </label>
      ) : null}
      {messageAckRequired ? (
        <label>
          <input
            data-testid="message-ack"
            type="checkbox"
            checked={messageAcknowledged}
            onChange={(e) => setMessageAcknowledged(e.currentTarget.checked)}
          />
          I understand this message may authorize access.
        </label>
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
        <button data-testid="approve" disabled={approveDisabled} onClick={() => void onApprove()}>
          {approveText}
        </button>
        <button data-testid="reject" disabled={busy} onClick={() => void onReject()}>
          Cancel
        </button>
      </div>
      {error ? <p data-testid="error">{error}</p> : null}
    </div>
  )
}
