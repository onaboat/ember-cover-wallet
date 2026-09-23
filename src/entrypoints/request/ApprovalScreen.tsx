import { simulatedWalletImpact } from '../../signing/simulation-effects.ts'
import { signingPolicyMessage } from '../../signing/signing-policy.ts'
import type { SigningAcknowledgement, SigningConsent, SigningDisposition } from '../../signing/signing-policy.ts'
import { messageRisk } from '../../signing/message-risk.ts'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { approvalPresentation } from '../../signing/approval-presentation.ts'
import { TransactionAmounts, TransactionRecipients, TransactionWarnings } from './TransactionPresentation.tsx'

import type { PendingRequestView } from '../../background/request-service.ts'
import { getRequestApproval } from '../../background/request-service.ts'
import { getVaultService } from '../../background/vault-service.ts'
import type { CoverDebugInfo } from '../../cover/ember-types.ts'
import { bannerView } from '../../cover/cover-banner-view.ts'
import { BrandMark } from '../../ui/BrandMark.tsx'
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

export function coverDisplay(
  cover: NonNullable<PendingRequestView['cover']> | null,
  fallback: ReturnType<typeof bannerView> | null,
  expired: boolean,
  impactIncomplete: boolean,
): { label: string; body: string; tone: string; nextAction: 'setup' | 'retry' | 'reconnect' | null } | null {
  if (!fallback?.label) {
    return null
  }
  if (expired) {
    return {
      label: 'Cover expired',
      body: 'Recheck cover before signing.',
      tone: 'unavailable',
      nextAction: 'retry',
    }
  }
  if (cover?.debug?.stage === 'not_enrolled') {
    if (cover.debug.apiAttempted === false) {
      return {
        label: 'Ember connection needed',
        body: 'Reconnect this wallet so Ember can check whether your cover is active.',
        tone: 'unavailable',
        nextAction: 'reconnect',
      }
    }
    return {
      label: 'No active cover found',
      body: 'Ember checked this wallet but found no active cover entitlement.',
      tone: 'none',
      nextAction: 'setup',
    }
  }
  if (cover?.coverStatus === 'unavailable') {
    return {
      label: 'Cover unavailable',
      body: 'Ember could not complete the cover assessment for this transaction.',
      tone: 'unavailable',
      nextAction: 'retry',
    }
  }
  if (cover?.coverStatus === 'covered' && fallback.tone === 'covered' && impactIncomplete) {
    return {
      label: 'Covered',
      body: 'Cover is available for this approval. Some effects remain unknown.',
      tone: 'covered',
      nextAction: null,
    }
  }
  return {
    label: fallback.label,
    body: fallback.body,
    tone: fallback.tone,
    nextAction: null,
  }
}

function debugValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'Unknown'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

/** Only omit safety copy when the combined effects sentence covers the same fact. */
export function transactionSafetyAcknowledgement(disposition: SigningDisposition, effectsAcknowledgement: boolean): string | null {
  if (effectsAcknowledgement && disposition.status === 'acknowledge' && disposition.reason === 'unsupported_effects') return null
  return signingPolicyMessage(disposition)
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
      return 'Sign message'
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
    return 'Approve and sign'
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

function ImpactRows({ impact, testId = 'estimated-changes' }: { impact: TxWalletImpact; testId?: 'estimated-changes' | 'simulated-changes' | 'decoded-changes' }) {
  return (
    <section className="ec-review-card" data-testid={testId}>
      <h2>{impact.title}</h2>
      <dl>
        {impact.rows.map((row, index) => (
          <div key={`${index}:${row.label}`} data-tone={row.tone}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      {impact.warning ? <p data-testid={testId === 'simulated-changes' ? 'simulation-warning' : 'decoded-impact-warning'}>{impact.warning}</p> : null}
    </section>
  )
}

export interface ApprovalScreenProps {
  /** Called after a successful approve so the host wallet can return to the refreshed home. */
  onApproved: () => void
  /** Called after a reject (the host closes the approval window). */
  onRejected: () => void
  /** Called when the user chooses to set up cover; the host navigates to the in-app cover screen. */
  onSetupCover: () => void
  /** Reconnect the wallet's Ember session before rechecking this exact approval. */
  onReconnectCover: () => Promise<void>
}

export function ApprovalScreen({ onApproved, onRejected, onSetupCover, onReconnectCover }: ApprovalScreenProps) {
  const request = getRequestApproval()
  const vault = getVaultService()

  const [pending, setPending] = useState<PendingRequestView | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const [needsUnlock, setNeedsUnlock] = useState(false)
  const [password, setPassword] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refreshingCover, setRefreshingCover] = useState(false)
  const [error, setError] = useState('')
  const [nowMs, setNowMs] = useState(Date.now())
  const [txTab, setTxTab] = useState<TxTab>('details')
  const [messageTab, setMessageTab] = useState<MessageTab>('message')
  const [coverAcknowledged, setCoverAcknowledged] = useState(false)
  const [safetyAcknowledged, setSafetyAcknowledged] = useState(false)
  const [impactAcknowledged, setImpactAcknowledged] = useState(false)
  const [messageAcknowledged, setMessageAcknowledged] = useState(false)
  const [debugOpen, setDebugOpen] = useState(false)

  useEffect(() => {
    let active = true
    void (async () => {
      setAddress(await vault.getAddress())
      setNeedsUnlock(!(await vault.isUnlocked()))
    })()
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      if (!active) {
        return
      }
      try {
        const view = await request.get()
        if (!active) {
          return
        }
        setPending(view)
        if (
          view &&
          (view.type === 'signTransaction' || view.type === 'signMessage') &&
          view.coverChecking
        ) {
          pollTimer = setTimeout(() => void poll(), 400)
        }
      } catch {
        // The extension service worker can be waking up. Keep this display in
        // its safe pending state and retry the read; never invent a verdict.
        if (active) {
          pollTimer = setTimeout(() => void poll(), 400)
        }
      }
    }
    void poll()
    return () => {
      active = false
      if (pollTimer !== undefined) {
        clearTimeout(pollTimer)
      }
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
  const cover =
    pending?.type === 'signTransaction' || pending?.type === 'signMessage' ? pending.cover ?? null : null
  const checkingCover =
    (pending?.type === 'signTransaction' || pending?.type === 'signMessage') &&
    !batchUnsupported &&
    (refreshingCover || pending.coverChecking === true)
  const transactionBlocked = pending?.transactionPreflight?.status === 'blocked' ? pending.transactionPreflight : null
  const displayedCover = checkingCover || transactionBlocked ? null : cover
  const simulatedImpact = simulatedWalletImpact(displayedCover?.simulationEffects)
  const presentation = approvalPresentation(transactionSummary, signingAddress, displayedCover?.simulationEffects)
  const reviewExpiry = pending?.signingReview?.expiresAt ?? (displayedCover?.coverStatus === 'covered' ? displayedCover.decisionExpiresAt : undefined)
  const coverExpired = reviewExpiry !== undefined && !(nowMs < Date.parse(reviewExpiry))
  const coverBanner =
    pending?.type === 'signTransaction' || pending?.type === 'signMessage'
      ? bannerView(displayedCover ?? (!checkingCover ? { coverStatus: 'unavailable', riskBand: 'low' } : null), checkingCover)
      : null
  const impactIncomplete = pending?.type === 'signTransaction' && !!transactionImpact && !transactionImpact.isComplete
  const coverDisplayView = coverDisplay(displayedCover, coverBanner, coverExpired, impactIncomplete)
  const decodedMessage =
    pending?.type === 'signMessage'
      ? decodeMessages(pending.data as { message: Uint8Array | Record<string, number> }[])
      : ''
  const messageRiskView = pending?.type === 'signMessage'
    ? messageRisk(decodedMessage, pending.origin)
    : { requiresAck: false, warning: null }
  const signingReview = pending?.signingReview
  const signingBlocked = signingReview?.disposition.status === 'block'
  const safetyAckRequired = signingReview?.requiredAcknowledgements.includes('safety') ?? false
  const coverAckRequired = coverBanner?.showAck ?? false
  const impactAckRequired = impactIncomplete
  const messageAckRequired = pending?.type === 'signMessage' && messageRiskView.requiresAck
  const approveDisabled = pending?.recoveryRequired ? busy :
    busy || pending?.signingStarted === true ||
    !!transactionBlocked || signingBlocked ||
    (pending?.type !== 'connect' && (!signingReview || (!coverExpired && safetyAckRequired && !safetyAcknowledged))) ||
    batchUnsupported ||
    (!coverExpired &&
      (checkingCover ||
        (coverAckRequired && !coverAcknowledged) ||
        (impactAckRequired && !impactAcknowledged) ||
        (messageAckRequired && !messageAcknowledged)))
  const approveText = pending?.recoveryRequired ? (busy ? 'Saving…' : 'Retry saving signature') : signingBlocked ? 'Signing blocked' : pending
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
  const requestBadge = (() => {
    if (!pending) {
      return { label: 'REVIEW', tone: 'pending' }
    }
    if (pending.type === 'connect') {
      return { label: 'CONNECT', tone: 'pending' }
    }
    if (batchUnsupported) {
      return { label: 'BATCH', tone: 'failed' }
    }
    if (signingBlocked) return { label: 'SIGNING BLOCKED', tone: 'failed' }
    if (transactionBlocked) {
      return { label: transactionBlocked.reason === 'expired' ? 'EXPIRED' : 'CANNOT SIGN', tone: 'failed' }
    }
    if (coverExpired) {
      return { label: 'EXPIRED', tone: 'unavailable' }
    }
    if (checkingCover) {
      return { label: 'REVIEW', tone: 'pending' }
    }
    if (coverBanner?.tone === 'covered') {
      return impactIncomplete ? { label: 'REVIEW EFFECTS', tone: 'warning' } : { label: 'COVERED', tone: 'protected' }
    }
    if (coverBanner?.tone === 'warning') {
      return { label: 'WARNING', tone: 'setup' }
    }
    if (coverBanner?.tone === 'unavailable') {
      return { label: 'UNAVAILABLE', tone: 'unavailable' }
    }
    // "Review" means the tx is outside cover / needs a careful look — a caution
    // state, so it reads as warning-orange (matching the "Not covered" pill),
    // not the neutral blue of a loading/pending state.
    return { label: 'REVIEW', tone: 'warning' }
  })()

  useEffect(() => {
    setCoverAcknowledged(false)
    setSafetyAcknowledged(false)
  }, [coverBanner?.label, coverBanner?.ackLabel, signingReview?.reviewId])

  useEffect(() => {
    setImpactAcknowledged(false)
  }, [transactionImpact?.warning, signingReview?.reviewId])

  useEffect(() => {
    setMessageAcknowledged(false)
  }, [decodedMessage, signingReview?.reviewId])

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

  async function refreshCoverDecision(reconnect = false): Promise<void> {
    setRefreshingCover(true)
    setError('')
    try {
      if (reconnect) {
        if (!(await ensureUnlocked())) return
        await onReconnectCover()
      }
      const view = await request.refreshCover()
      setPending(view)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not recheck cover')
    } finally {
      setNowMs(Date.now())
      setRefreshingCover(false)
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
    if (coverExpired && !pending.recoveryRequired) {
      await refreshCoverDecision()
      return
    }
    setBusy(true)
    setError('')
    try {
      if (pending.recoveryRequired) {
        await request.retrySigned(pending.id)
        onApproved()
        return
      }
      if (!(await ensureUnlocked())) {
        setBusy(false)
        return
      }
      const acknowledged: SigningAcknowledgement[] = []
      if (coverAcknowledged) acknowledged.push('coverage')
      if (impactAcknowledged) acknowledged.push('effects')
      if (messageAcknowledged) acknowledged.push('message')
      if (safetyAcknowledged) acknowledged.push('safety')
      const consent: SigningConsent = { reviewId: signingReview?.reviewId ?? '', acknowledged }
      if (pending.type === 'connect') {
        await request.approveConnect(pending.id)
      } else if (pending.type === 'signMessage') {
        await request.approveSignMessage(pending.id, consent)
      } else {
        await request.approveSignTransaction(pending.id, consent)
      }
      onApproved()
    } catch (e) {
      const message = e instanceof Error ? e.message : 'failed'
      // Matches both 'vault is locked' and 'vault is locked out' (lockout) so a re-lock
      // mid-approval shows the recovery prompt instead of a raw error.
      if (message.startsWith('vault is locked')) {
        setNeedsUnlock(true)
        setError('Vault re-locked. Enter your password again.')
      } else {
        setError(message)
        setPending(await request.get())
      }
      setBusy(false)
    }
  }

  async function onReject() {
    await request.reject(pending?.id)
    onRejected()
  }

  function CoverDebugPanel({ debug }: { debug: CoverDebugInfo }) {
    const rows = [
      ['Wallet linked', debug.enrolled],
      ['API attempted', debug.apiAttempted],
      ['Stage', debug.stage],
      ['Proxy URL', debug.proxyBaseUrl],
      ['HTTP status', debug.httpStatus],
      ['Decision', debug.coverStatus],
      ['Risk', debug.riskBand],
      ['Error', debug.error],
    ] as const
    return (
      <details
        className="ec-debug"
        data-testid="cover-debug"
        open={debugOpen}
        onToggle={(event) => setDebugOpen(event.currentTarget.open)}
      >
        <summary>Cover debug</summary>
        <dl className="ec-debug-list">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{debugValue(value)}</dd>
            </div>
          ))}
        </dl>
        <pre>{JSON.stringify(debug, null, 2)}</pre>
      </details>
    )
  }

  function renderCoverDecisionPanel(amounts?: ReactNode) {
    if (signingBlocked && signingReview) {
      return <section className="ec-review-card ec-cover-decision" data-tone="blocked" data-testid="cover-section"><div role="alert" data-testid="signing-blocked">
        <h3>Signing blocked</h3>
        <p>{signingPolicyMessage(signingReview.disposition)}</p></div>
        {amounts}
      </section>
    }
    if (transactionBlocked) {
      return (
        <section className="ec-review-card ec-cover-decision" data-tone="blocked" data-testid="cover-section"><div role="alert" data-testid="transaction-preflight-error">
          <h3>{transactionBlocked.reason === 'expired' ? 'Transaction expired' : 'Transaction cannot be signed'}</h3>
          <p>{transactionBlocked.message}</p></div>
          {amounts}
          {'details' in transactionBlocked && transactionBlocked.details ? <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{transactionBlocked.details}</pre> : null}
          {transactionBlocked.reason !== 'expired' && transactionBlocked.reason !== 'invalid_transaction' ? (
            <button className="ec-secondary" disabled={busy || checkingCover} onClick={() => void refreshCoverDecision()}>Retry transaction check</button>
          ) : null}
        </section>
      )
    }
    if (!coverDisplayView) {
      return amounts ? <section className="ec-review-card ec-cover-decision" data-tone="checking" data-testid="cover-section">{amounts}</section> : null
    }
    return (
      <section
        aria-busy={checkingCover}
        aria-live="polite"
        className="ec-review-card ec-cover-decision"
        data-testid="cover-section"
        data-tone={checkingCover ? 'checking' : coverDisplayView.tone}
      >
        <div className="ec-cover-callout-head">
          <span className="ec-section-icon" aria-hidden="true">
            {checkingCover ? <span className="ec-cover-spinner" /> : <BrandMark title="Ember Cover" />}
          </span>
          <span className="ec-cover-callout-text">
            <span className="ec-cover-callout-title" data-testid="cover" data-tone={coverDisplayView.tone}>
              {coverDisplayView.label}
            </span>
            <span className="ec-help" data-testid="cover-body">{coverDisplayView.body}</span>
          </span>
        </div>
        {amounts}
        {coverDisplayView.nextAction === 'setup' ? (
          <div className="ec-actions">
            <button className="ec-secondary" data-testid="cover-next-step" onClick={onSetupCover} type="button">
              Set up cover
            </button>
          </div>
        ) : null}
        {coverDisplayView.nextAction === 'retry' ? (
          <div className="ec-actions">
            <button
              className="ec-secondary"
              data-testid="cover-retry"
              disabled={busy || checkingCover}
              onClick={() => void refreshCoverDecision()}
              type="button"
            >
              Retry cover check
            </button>
          </div>
        ) : null}
        {coverDisplayView.nextAction === 'reconnect' ? (
          <div className="ec-actions">
            <button
              className="ec-secondary"
              data-testid="cover-reconnect"
              disabled={busy || checkingCover}
              onClick={() => void refreshCoverDecision(true)}
              type="button"
            >
              Reconnect and check cover
            </button>
          </div>
        ) : null}
        <details className="ec-cover-details" data-testid="cover-details">
          <summary>Cover details</summary>
          <p>{coverDisplayView.body}</p>
          {displayedCover?.debug?.decisionReason === 'coverage_limit_reached' ? <p>Your cover allowance has been reached.</p> : null}
          {displayedCover?.capContext ? <p>Cover checks remaining: {displayedCover.capContext.remainingCoveredTxThisMonth}</p> : null}
          {displayedCover?.decisionExpiresAt ? <p>Assessment valid until {new Date(displayedCover.decisionExpiresAt).toLocaleTimeString()}. The wallet rechecks expired assessments before signing.</p> : null}
          {displayedCover?.debug?.requestId ? <p className="ec-full-address">Support reference: {displayedCover.debug?.requestId}</p> : null}
          {displayedCover?.coverStatus === 'covered' ? <p>Cover applies subject to the terms for this approval. Coverage does not remove transaction risks.</p> : null}
          {displayedCover?.debug ? <CoverDebugPanel debug={displayedCover.debug} /> : null}
        </details>
      </section>
    )
  }

  function renderActionFooter() {
    return (
      <>
        {pending?.type === 'signTransaction' && !coverExpired && !signingBlocked && !transactionBlocked && (safetyAckRequired || coverAckRequired || impactAckRequired) ? (
          <label className="ec-ack">
            <input data-testid="transaction-ack" type="checkbox"
              checked={(!safetyAckRequired || safetyAcknowledged) && (!coverAckRequired || coverAcknowledged) && (!impactAckRequired || impactAcknowledged)}
              onChange={event => {
                setSafetyAcknowledged(safetyAckRequired && event.currentTarget.checked)
                setCoverAcknowledged(coverAckRequired && event.currentTarget.checked)
                setImpactAcknowledged(impactAckRequired && event.currentTarget.checked)
              }} />
            <span>{[
              coverAckRequired && displayedCover?.coverStatus !== 'covered' ? 'I understand I am signing without cover.' : null,
              impactAckRequired ? 'Some balance or permission changes could not be fully estimated.' : null,
              safetyAckRequired && signingReview ? transactionSafetyAcknowledgement(signingReview.disposition, impactAckRequired) : null,
              coverAckRequired && displayedCover?.coverStatus === 'covered' ? 'I understand this transaction is high risk.' : null,
            ].filter(Boolean).join(' ')}</span>
          </label>
        ) : null}
        {pending?.type !== 'signTransaction' && !coverExpired && safetyAckRequired && signingReview && !signingBlocked ? (
          <label className="ec-ack">
            <input data-testid="safety-ack" type="checkbox" checked={safetyAcknowledged} onChange={(event) => setSafetyAcknowledged(event.target.checked)} />
            <span>{signingPolicyMessage(signingReview.disposition)} I understand and want to proceed.</span>
          </label>
        ) : null}
        {pending?.type !== 'signTransaction' && !signingBlocked && !coverExpired && coverAckRequired && coverBanner?.ackLabel ? (
          <label className="ec-ack">
            <input
              data-testid="cover-ack"
              type="checkbox"
              checked={coverAcknowledged}
              onChange={(e) => setCoverAcknowledged(e.currentTarget.checked)}
            />
            {coverBanner.ackLabel}
          </label>
        ) : null}
        {!signingBlocked && messageAckRequired ? (
          <label className="ec-ack">
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
          <label>
            Password
            <span className="ec-password-field">
              <input
                autoComplete="current-password"
                data-testid="password"
                type={passwordVisible ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
              />
              <button
                aria-label={passwordVisible ? 'Hide password' : 'Show password'}
                className="ec-password-toggle"
                onClick={() => setPasswordVisible((visible) => !visible)}
                type="button"
              >
                {passwordVisible ? 'Hide' : 'Show'}
              </button>
            </span>
          </label>
        ) : null}
        <div className="ec-actions ec-approval-actions">
          <button className="ec-secondary" data-testid="reject" disabled={busy || pending?.signingStarted} onClick={() => void onReject()}>
            Cancel
          </button>
          <button className="ec-primary" data-testid="approve" disabled={approveDisabled} onClick={() => void onApprove()}>
            {checkingCover ? <span className="ec-button-spinner" aria-hidden="true" /> : null}
            {approveText}
          </button>
        </div>
        {error ? <p data-testid="error">{error}</p> : null}
      </>
    )
  }

  if (!pending) {
    return (
      <section className="ec-task-screen ec-approval-screen" data-testid="approval-screen">
        <p className="ec-help">Loading request...</p>
      </section>
    )
  }

  return (
    <section className="ec-task-screen ec-approval-screen" data-testid="approval-screen">
      <div className="ec-screen-head">
        <div>
          <span className="ec-control-label">Approval</span>
          <h2>{pending.type === 'signTransaction' && !batchUnsupported ? presentation.title : requestTitle(pending, transactionSummary)}</h2>
        </div>
        <span className="ec-status-badge" data-tone={requestBadge.tone}>
          {requestBadge.label}
        </span>
      </div>
      <div className="ec-request-meta">
      {pending.origin ? (
        <p className="ec-origin" data-testid="origin">
          {pending.origin}
        </p>
      ) : null}
      <p className="ec-account" data-testid="account">Wallet · {shortAddress(signingAddress)}</p>
      </div>

      {pending.type === 'connect' ? (
        <section className="ec-panel" data-testid="connect-summary">
          <p>This lets this site view your public wallet address and request approvals.</p>
          <p className="ec-help">It cannot move funds without a separate signing approval.</p>
        </section>
      ) : null}

      {pending.type === 'signMessage' ? (
        <>
          {batchUnsupported ? (
            <section className="ec-panel" data-testid="batch-warning">
              <h2>Multiple messages</h2>
              <p>Ember can review one message at a time. Cancel and retry with a single message.</p>
            </section>
          ) : (
            <>
              <section className="ec-review-card" data-testid="message-overview">
                <h2>No transaction</h2>
                <p>This will not move funds, but it may prove ownership or authorize access.</p>
                {messageRiskView.warning ? <p data-testid="message-warning">{messageRiskView.warning}</p> : null}
              </section>
              {renderCoverDecisionPanel()}
              <div className="ec-tablist" role="tablist" aria-label="Message request">
                <button type="button" aria-selected={messageTab === 'message'} onClick={() => setMessageTab('message')}>
                  Message
                </button>
                <button type="button" aria-selected={messageTab === 'details'} onClick={() => setMessageTab('details')}>
                  Details
                </button>
              </div>
              {messageTab === 'message' ? (
                <pre data-testid="message">
                  {decodedMessage}
                </pre>
              ) : (
                <section className="ec-review-card" data-testid="message-details">
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
            <section className="ec-panel" data-testid="batch-warning">
              <h2>Multiple transactions</h2>
              <p>Ember can review one transaction at a time. Cancel and retry with a single transaction.</p>
            </section>
          ) : (
            <>
              <TransactionRecipients view={presentation} />
              {!signingBlocked && !transactionBlocked ? <TransactionWarnings view={presentation} /> : null}
              {renderCoverDecisionPanel(<TransactionAmounts view={presentation} />)}
            </>
          )}
          {!batchUnsupported ? <details className="ec-transaction-details" data-testid="transaction-details-disclosure">
            <summary>Transaction details</summary>
          {!batchUnsupported ? (
            <div className="ec-tablist" role="tablist" aria-label="Transaction request">
              <button type="button" aria-selected={txTab === 'details'} onClick={() => setTxTab('details')}>
                Details
              </button>
              <button type="button" aria-selected={txTab === 'raw'} onClick={() => setTxTab('raw')}>
                Raw
              </button>
            </div>
          ) : null}
          {!batchUnsupported && txTab === 'details' ? (
            <section className="ec-review-card" data-testid="tx-details">
              {transactionSummary ? (
                <>
                  <h2>Transaction details</h2>
                  {transactionImpact ? <ImpactRows impact={transactionImpact} testId="decoded-changes" /> : null}
                  {simulatedImpact ? <ImpactRows impact={simulatedImpact} testId="simulated-changes" /> : null}
                  <p>Fee payer {shortAddress(transactionSummary.feePayer)}</p>
                  <h3>Instructions</h3>
                  <ul>
                    {transactionSummary.instructions.map((ix, i) => (
                      <li key={i} className="ec-transaction-instruction">
                        {ix.instructionName ? `${ix.programName}: ${ix.instructionName}` : ix.programName}
                        {ix.effect.status === 'understood' ? (
                          <>
                            <p>{ix.effect.action.label}{ix.effect.action.amount ? `: ${ix.effect.action.amount}` : ''}</p>
                            {ix.effect.action.source ? <p>Source account {ix.effect.action.source}</p> : null}
                            {ix.effect.action.kind === 'authority_change'
                              ? <p>New authority {ix.effect.action.recipient ?? 'Authority removed'}</p>
                              : ix.effect.action.recipient ? <p>Destination account {ix.effect.action.recipient}</p> : null}
                            {ix.effect.action.tokenMint ? <p>Token mint {ix.effect.action.tokenMint}</p> : null}
                          </>
                        ) : ix.effect.status === 'unknown' ? <p>Effects unknown</p> : <p>Compute configuration</p>}
                      </li>
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
            <section className="ec-review-card" data-testid="tx-raw">
              <h2>Raw transaction</h2>
              <pre>{JSON.stringify(pending.data, null, 2)}</pre>
            </section>
          ) : null}
          </details> : null}
          {renderActionFooter()}
        </div>
      ) : null}

      {pending.type !== 'signTransaction' ? renderActionFooter() : null}
    </section>
  )
}
