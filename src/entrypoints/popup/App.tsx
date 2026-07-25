import { lazy, Suspense, useEffect, useState } from 'react'
import { address as toAddress } from '@solana/kit'

import { getCoverService } from '../../background/cover-service.ts'
import { getPrepaidPaymentService } from '../../background/prepaid-payment-service.ts'
import type {
  LocalPrepaidPaymentState,
  PrepaidPaymentPreview,
  PrepaidPaymentResult,
} from '../../background/prepaid-payment-service.ts'
import { getRequestApproval } from '../../background/request-service.ts'
import { getWalletTransferService, parseSolAmountToLamports } from '../../background/sol-transfer-service.ts'
import type { SolTransferPreview, SolTransferResult } from '../../background/sol-transfer-service.ts'
import { getVaultService } from '../../background/vault-service.ts'
import { formatLamportsAsSol } from '../../background/wallet-data-service.ts'
import type { WalletDataSnapshot } from '../../background/wallet-data-service.ts'
import { getWalletDataService } from '../../background/wallet-data-service.ts'
import type { WalletCluster } from '../../background/wallet-data-config.ts'
import { WALLET_CLUSTER_OPTIONS } from '../../background/wallet-data-config.ts'
import { coverCapReviewText, formatCoverStatusSnapshot } from '../../cover/cover-cap-view.ts'
import type { CoverStatusSnapshot } from '../../cover/ember-types.ts'
import { BrandMark } from '../../ui/BrandMark.tsx'
import { prepaidPaymentStatusView } from '../../ui/prepaid-payment-status-view.ts'
import { isVaultLockedError } from '../../vault/vault-lock.ts'
import { QrCode } from './qr-code.tsx'

// Lazy so the toolbar popup (which never decodes raw dapp transactions) does not eagerly
// pull in the transaction/message decoders. Only the approval window mounts this screen.
const ApprovalScreen = lazy(() =>
  import('../request/ApprovalScreen.tsx').then((m) => ({ default: m.ApprovalScreen })),
)

type WalletMode = 'wallet' | 'approval'
type View = 'loading' | 'create' | 'unlock' | 'account'
type MainTab = 'assets' | 'activity'
type AccountScreen = 'home' | 'receive' | 'send' | 'cover' | 'approval'
type SendStep = 'form' | 'review' | 'complete'

interface AppProps {
  /** 'approval' is rendered in the dapp approval window: it surfaces the pending request as a
   *  screen inside this same wallet shell and returns to home after a successful sign. */
  mode?: WalletMode
}

const BASE_FEE_LAMPORTS = 5_000n

function coverStatusLabel(status: string): string {
  if (status === 'covered') return 'Covered'
  if (status === 'not_covered') return 'Not covered'
  if (status === 'unsupported') return 'Not covered'
  if (status === 'unavailable') return 'Cover unavailable'
  return 'Cover status unknown'
}

function coverTone(status: string): string {
  if (status === 'covered') return 'covered'
  if (status === 'unavailable') return 'unavailable'
  if (status === 'not_covered' || status === 'unsupported') return 'none'
  return 'unknown'
}

function arrayOrEmpty<T>(value: T[] | readonly T[] | undefined): T[] | readonly T[] {
  return Array.isArray(value) ? value : []
}

function shortAddress(value: string | null | undefined): string {
  if (!value) return ''
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-8)}` : value
}

function clusterLabel(cluster: WalletCluster): string {
  return cluster === 'mainnet-beta' ? 'Mainnet' : 'Devnet'
}

function tokenInitial(label: string, mint: string): string {
  const trimmed = label.replace(/^Token\s+/i, '').trim()
  return (trimmed[0] ?? mint[0] ?? 'T').toUpperCase()
}

function activityDate(blockTime: number | null): string {
  return blockTime ? new Date(blockTime * 1000).toLocaleDateString() : 'Pending'
}

function activityState(failed: boolean, confirmationStatus: string | null): string {
  if (failed) return 'Failed'
  if (confirmationStatus === 'finalized') return 'Finalized'
  if (confirmationStatus) return confirmationStatus
  return 'Pending'
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function maxSendableSol(snapshot: WalletDataSnapshot | null): string {
  if (!snapshot) return '0'
  const balance = BigInt(snapshot.lamports)
  const max = balance > BASE_FEE_LAMPORTS ? balance - BASE_FEE_LAMPORTS : 0n
  return formatLamportsAsSol(max)
}

function isValidSolanaAddress(value: string): boolean {
  try {
    toAddress(value)
    return true
  } catch {
    return false
  }
}

function amountValidation(amount: string, snapshot: WalletDataSnapshot | null): string {
  if (!amount.trim()) return ''
  try {
    const lamports = parseSolAmountToLamports(amount)
    if (snapshot && lamports > BigInt(snapshot.lamports) - BASE_FEE_LAMPORTS) {
      return `Not enough SOL for amount and network fee. Max is ${maxSendableSol(snapshot)} SOL.`
    }
    return ''
  } catch (error) {
    return errorMessage(error, 'Enter a valid SOL amount')
  }
}

export function App({ mode = 'wallet' }: AppProps = {}) {
  const vault = getVaultService()
  const cover = getCoverService()
  const payments = getPrepaidPaymentService()
  const walletData = getWalletDataService()
  const transfers = getWalletTransferService()
  const approval = getRequestApproval()
  const [view, setView] = useState<View>('loading')
  const [mainTab, setMainTab] = useState<MainTab>('assets')
  const [accountScreen, setAccountScreen] = useState<AccountScreen>(mode === 'approval' ? 'approval' : 'home')
  const [approvalPending, setApprovalPending] = useState(mode === 'approval')
  const [address, setAddress] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [coverEnrolled, setCoverEnrolled] = useState<boolean | null>(null)
  const [coverStatusSnapshot, setCoverStatusSnapshot] = useState<CoverStatusSnapshot | null>(null)
  const [coverStatusLoading, setCoverStatusLoading] = useState(false)
  const [paymentPreview, setPaymentPreview] = useState<PrepaidPaymentPreview | null>(null)
  const [paymentState, setPaymentState] = useState<LocalPrepaidPaymentState | null>(null)
  const [paymentResult, setPaymentResult] = useState<PrepaidPaymentResult | null>(null)
  const [paymentBusy, setPaymentBusy] = useState(false)
  const [paymentError, setPaymentError] = useState('')
  const [paymentNotice, setPaymentNotice] = useState('')
  const [paymentNeedsUnlock, setPaymentNeedsUnlock] = useState(false)
  const [cluster, setCluster] = useState<WalletCluster>('devnet')
  const [snapshot, setSnapshot] = useState<WalletDataSnapshot | null>(null)
  const [walletDataLoading, setWalletDataLoading] = useState(false)
  const [walletDataError, setWalletDataError] = useState('')
  const [copied, setCopied] = useState(false)
  const [sendStep, setSendStep] = useState<SendStep>('form')
  const [sendRecipient, setSendRecipient] = useState('')
  const [sendRecipientFromClipboard, setSendRecipientFromClipboard] = useState(false)
  const [sendAmount, setSendAmount] = useState('')
  const [sendPreview, setSendPreview] = useState<SolTransferPreview | null>(null)
  const [sendResult, setSendResult] = useState<SolTransferResult | null>(null)
  const [sendError, setSendError] = useState('')
  const [sendBusy, setSendBusy] = useState(false)
  const [sendPreviewLoading, setSendPreviewLoading] = useState(false)
  const [uncoveredAck, setUncoveredAck] = useState(false)
  const [highRiskAck, setHighRiskAck] = useState(false)
  const [nowMs, setNowMs] = useState(Date.now())
  const tokenBalances = arrayOrEmpty(snapshot?.tokenBalances)
  const emberActivity = arrayOrEmpty(snapshot?.emberActivity)
  const activity = arrayOrEmpty(snapshot?.activity)
  const recipientTrimmed = sendRecipient.trim()
  const recipientValid = recipientTrimmed ? isValidSolanaAddress(recipientTrimmed) : false
  const recipientIsSelf = !!address && recipientTrimmed === address
  const recipientError = recipientTrimmed && !recipientValid ? 'Enter a valid Solana address.' : ''
  const selfSendError = recipientIsSelf ? 'You cannot send SOL to this wallet.' : ''
  const sendAmountError = amountValidation(sendAmount, snapshot)
  const paymentStatusView = prepaidPaymentStatusView({
    cluster,
    coverEnrolled,
    coverStatusLoading,
    coverStatusSnapshot,
    paymentState,
  })

  async function refresh() {
    if (!(await vault.hasVault())) {
      setView('create')
      return
    }
    // Approval mode bypasses the standalone unlock view ONLY while a request is pending: the
    // approval screen carries its own inline unlock so the cover banner and password coexist on
    // one screen while locked. With no pending request the window is a plain wallet and must
    // respect the lock state (otherwise locking it would still show an unlocked-looking home).
    if (mode === 'approval' && (await approval.get())) {
      setAddress(await vault.getAddress())
      setView('account')
      return
    }
    if (await vault.isUnlocked()) {
      setAddress(await vault.getAddress())
      setView('account')
      return
    }
    setView('unlock')
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function refreshCoverState() {
    setCoverStatusLoading(true)
    try {
      const enrolled = await cover.isEnrolled()
      setCoverEnrolled(enrolled)
      setCoverStatusSnapshot(enrolled ? await cover.status() : null)
    } catch {
      setCoverEnrolled(false)
      setCoverStatusSnapshot(null)
    } finally {
      setCoverStatusLoading(false)
    }
  }

  useEffect(() => {
    if (view === 'account') {
      void refreshCoverState()
    }
  }, [view])

  useEffect(() => {
    if (mode !== 'wallet' || view !== 'account' || window.location.hash !== '#cover') {
      return
    }
    openCoverActivation()
    window.history.replaceState(null, '', window.location.pathname)
  }, [view])

  // Approval window: read the pending request once to decide whether to show the approval
  // screen. If nothing is pending (e.g. it already resolved), fall back to the wallet home.
  useEffect(() => {
    if (mode !== 'approval') {
      return
    }
    let active = true
    void (async () => {
      const pending = await approval.get()
      if (!active) {
        return
      }
      if (pending) {
        setApprovalPending(true)
        setAccountScreen('approval')
      } else {
        setApprovalPending(false)
        setAccountScreen('home')
      }
    })()
    return () => {
      active = false
    }
  }, [])

  async function refreshPaymentState() {
    if (!address) return
    try {
      setPaymentState(await payments.localPayment(address))
    } catch {
      setPaymentError('Payment state unavailable')
    }
  }

  useEffect(() => {
    if (view === 'account') {
      void refreshPaymentState()
    }
  }, [view, address])

  async function refreshWalletData(walletAddress = address) {
    if (!walletAddress) return
    setWalletDataLoading(true)
    setWalletDataError('')
    try {
      const next = await walletData.getSnapshot(walletAddress, 10)
      setSnapshot(next)
      setCluster(next.cluster)
    } catch {
      setWalletDataError('Wallet data unavailable')
    } finally {
      setWalletDataLoading(false)
    }
  }

  useEffect(() => {
    if (view === 'account' && address) {
      void refreshWalletData(address)
    }
  }, [view, address])

  useEffect(() => {
    if (sendStep !== 'review' || !sendPreview?.cover.decisionExpiresAt) {
      return
    }
    const timer = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [sendStep, sendPreview?.cover.decisionExpiresAt])

  async function onClusterChange(nextCluster: WalletCluster) {
    const previousCluster = cluster
    setCluster(nextCluster)
    setWalletDataError('')
    try {
      await walletData.setCluster(nextCluster)
      await refreshWalletData()
    } catch {
      setCluster(previousCluster)
      setWalletDataError('Could not switch cluster')
    }
  }

  async function onCopyAddress() {
    if (!address) return
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setWalletDataError('Could not copy address')
    }
  }

  async function onPasteRecipient() {
    setSendError('')
    try {
      setSendRecipient((await navigator.clipboard.readText()).trim())
      setSendRecipientFromClipboard(true)
    } catch {
      setSendError('Could not read clipboard. Paste the address manually.')
    }
  }

  async function onShareAddress() {
    if (!address || !('share' in navigator)) return
    try {
      await navigator.share({ text: address, title: 'Ember wallet address' })
    } catch {
      // User cancellation should not become an error state.
    }
  }

  async function onCreate() {
    setError('')
    setAuthBusy(true)
    try {
      setAddress(await vault.createVault(password))
      await vault.unlock(password)
      setPassword('')
      setView('account')
    } catch (e) {
      setError(errorMessage(e, 'failed'))
    } finally {
      setAuthBusy(false)
    }
  }

  async function onUnlock() {
    setError('')
    setAuthBusy(true)
    try {
      await vault.unlock(password)
      setPassword('')
      await refresh()
    } catch {
      setError('Wrong password')
    } finally {
      setAuthBusy(false)
    }
  }

  function openSend() {
    setAccountScreen('send')
    setMainTab('assets')
    setSendStep('form')
    setSendRecipient('')
    setSendRecipientFromClipboard(false)
    setSendAmount('')
    setSendPreview(null)
    setSendResult(null)
    setSendError('')
    setUncoveredAck(false)
    setHighRiskAck(false)
  }

  function openCoverActivation() {
    setAccountScreen('cover')
    setMainTab('assets')
    setPaymentPreview(null)
    setPaymentResult(null)
    setPaymentError('')
    setPaymentNotice('')
    setPaymentNeedsUnlock(false)
  }

  // Payment and activation can need vault signatures, and the vault can idle-lock while this
  // screen is open. Prompt inline instead of discarding the reviewed payment.
  async function ensurePaymentUnlocked(): Promise<boolean> {
    if (await vault.isUnlocked()) {
      return true
    }
    if (!password) {
      setPaymentNeedsUnlock(true)
      setPaymentError('Wallet locked. Enter your password to continue.')
      return false
    }
    try {
      await vault.unlock(password)
      setPassword('')
      setPaymentNeedsUnlock(false)
      return true
    } catch {
      setPaymentNeedsUnlock(true)
      setPaymentError('Wrong password')
      return false
    }
  }

  function handlePaymentError(e: unknown, fallback: string) {
    const message = errorMessage(e, fallback)
    if (isVaultLockedError(message)) {
      setPaymentNeedsUnlock(true)
      setPaymentError('Wallet re-locked. Enter your password and try again.')
    } else {
      setPaymentError(message)
    }
  }

  // Approval window: after a successful sign, return to the refreshed wallet home and stay open.
  function onApprovalApproved() {
    setApprovalPending(false)
    setAccountScreen('home')
    setMainTab('assets')
    void refreshWalletData()
    void refreshCoverState()
  }

  // Approval window: reject closes the window (request-service removes it); nothing to show.
  function onApprovalRejected() {
    setApprovalPending(false)
    setAccountScreen('home')
  }

  async function previewCoverPayment() {
    setPaymentBusy(true)
    setPaymentError('')
    setPaymentNotice('')
    setPaymentPreview(null)
    setPaymentResult(null)
    try {
      setPaymentPreview(await payments.previewPayment({ cluster }))
    } catch (e) {
      setPaymentError(errorMessage(e, 'Could not review the one-off payment'))
    } finally {
      setPaymentBusy(false)
    }
  }

  async function activateCoverPayment() {
    setPaymentBusy(true)
    setPaymentError('')
    setPaymentNotice('')
    if (!(await ensurePaymentUnlocked())) {
      setPaymentBusy(false)
      return
    }
    try {
      const result = await payments.activatePayment({ cluster })
      setPaymentResult(result)
      setPaymentState(result.state)
      if (result.apiCoverActive) {
        setPaymentNotice('Payment confirmed and Ember Cover is active.')
      } else {
        setPaymentNotice('Payment saved. Retry activation without paying again.')
      }
      await refreshCoverState()
      await refreshPaymentState()
      await refreshWalletData()
    } catch (e) {
      handlePaymentError(e, 'Could not complete the cover payment')
      await refreshPaymentState()
    } finally {
      setPaymentBusy(false)
    }
  }

  async function syncCoverPayment() {
    setPaymentBusy(true)
    setPaymentError('')
    setPaymentNotice('')
    if (!(await ensurePaymentUnlocked())) {
      setPaymentBusy(false)
      return
    }
    try {
      const result = await payments.syncPayment(address ?? undefined)
      if (!result) {
        setPaymentError('No saved one-off payment was found for this wallet.')
        return
      }
      setPaymentResult(result)
      setPaymentState(result.state)
      await refreshCoverState()
      if (result.apiCoverActive) {
        setPaymentNotice('Cover activation completed. No second payment was made.')
      } else {
        setPaymentNotice(result.activationError ?? 'Payment confirmation or API activation is still pending.')
      }
    } catch (e) {
      handlePaymentError(e, 'Could not retry payment activation')
    } finally {
      setPaymentBusy(false)
    }
  }

  async function loadSendPreview() {
    setSendPreviewLoading(true)
    setSendError('')
    setSendPreview(null)
    setUncoveredAck(false)
    setHighRiskAck(false)
    setNowMs(Date.now())
    try {
      setSendPreview(await transfers.previewSolTransfer({ amountSol: sendAmount, cluster, destination: recipientTrimmed }))
      void refreshCoverState()
    } catch (e) {
      setSendError(errorMessage(e, 'Could not review send'))
    } finally {
      setSendPreviewLoading(false)
    }
  }

  async function onSendSol() {
    setSendBusy(true)
    setSendError('')
    try {
      const result = await transfers.sendSolTransfer({
        amountSol: sendAmount,
        cluster,
        destination: recipientTrimmed,
        acknowledgeHighRisk: highRiskAck,
        acknowledgeUncovered: uncoveredAck,
      })
      setSendResult(result)
      setSendStep('complete')
      void refreshWalletData()
      void refreshCoverState()
    } catch (e) {
      setSendError(errorMessage(e, 'Could not send SOL'))
    } finally {
      setSendBusy(false)
    }
  }

  function renderTopbar() {
    return (
      <header className="ec-topbar">
        <div className="ec-brand">
          <span className="ec-mark-frame">
            <BrandMark className="ec-brand-mark" title="Ember Cover" />
          </span>
          <span className="ec-brand-copy">
            <span className="ec-brand-name">Ember</span>
            <span className="ec-brand-subtitle">Cover wallet</span>
          </span>
        </div>
        <span className="ec-status-badge" data-tone={paymentStatusView.badgeTone}>
          {paymentStatusView.badgeLabel}
        </span>
      </header>
    )
  }

  function renderBackButton(onClick: () => void) {
    return (
      <button aria-label="Back" className="ec-back-button" onClick={onClick} type="button">
        <span aria-hidden="true">←</span>
        <span>Back</span>
      </button>
    )
  }

  function renderWalletControls() {
    return (
      <section className="ec-wallet-controls">
        <button
          className="ec-address-chip"
          data-testid="address"
          title={copied ? 'Copied' : 'Copy address'}
          onClick={() => void onCopyAddress()}
          type="button"
        >
          <span className="ec-wallet-address">{address}</span>
          {copied ? <span className="ec-address-copy" data-testid="copy">Copied</span> : null}
        </button>
        <label className="ec-network-control" data-testid="wallet-cluster">
          <span className="ec-control-label">Network</span>
          <select data-testid="cluster-select" onChange={(event) => void onClusterChange(event.target.value as WalletCluster)} value={cluster}>
            {WALLET_CLUSTER_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button className="ec-quiet-button" data-testid="lock" onClick={() => void vault.lock().then(refresh)} type="button">
          Lock
        </button>
      </section>
    )
  }

  function renderTabs() {
    return (
      <nav className="ec-bottom-nav" data-testid="main-tabs" aria-label="Wallet">
        <button
          aria-selected={mainTab === 'assets'}
          data-testid="tab-assets"
          onClick={() => {
            setMainTab('assets')
            setAccountScreen('home')
          }}
        >
          Assets
        </button>
        <button
          aria-selected={mainTab === 'activity'}
          data-testid="tab-activity"
          onClick={() => {
            setMainTab('activity')
            setAccountScreen('home')
          }}
        >
          Activity
        </button>
      </nav>
    )
  }

  function renderCoverStatusCard() {
    const actionLabel =
      paymentStatusView.primaryAction === 'manage'
        ? 'Manage Cover'
        : paymentStatusView.primaryAction === 'sync'
          ? 'Retry activation'
          : 'Activate cover'
    const actionTestId = paymentStatusView.primaryAction === 'manage' ? 'manage-cover' : 'activate-cover'
    return (
      <section className="ec-cover-strip" data-testid="wallet-cover-status">
        <div className="ec-cover-strip__main">
          <span className="ec-section-icon" aria-hidden="true">
            <BrandMark title="Coverage" />
          </span>
          <div>
            <h2 className="ec-cover-title">{paymentStatusView.title}</h2>
            <p className="ec-cover-detail">{paymentStatusView.detail}</p>
          </div>
        </div>
        <div className="ec-cover-strip__side">
          <span className="ec-status-badge" data-tone={paymentStatusView.badgeTone} data-testid="cover-status">
            {paymentStatusView.badgeLabel}
          </span>
          <button
            className={paymentStatusView.primaryAction === 'activate' ? 'ec-primary' : 'ec-secondary'}
            data-testid={actionTestId}
            onClick={openCoverActivation}
            type="button"
          >
            {actionLabel}
          </button>
        </div>
        {paymentStatusView.metrics.length > 0 ? (
          <dl className="ec-metrics">
            {paymentStatusView.metrics.map((metric) => (
              <div className="ec-metric-row" key={metric.label}>
                <dt>{metric.label}</dt>
                <dd>{metric.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {error ? <p data-testid="cover-error">{error}</p> : null}
      </section>
    )
  }

  function renderAssets() {
    return (
      <section className="ec-account-card" data-testid="wallet-balance">
        <div className="ec-account-balance">
          <div className="ec-panel-head">
            <span className="ec-section-label">Balance</span>
            <button
              className="ec-quiet-button"
              data-testid="refresh-wallet-data"
              disabled={walletDataLoading}
              onClick={() => void refreshWalletData()}
              type="button"
            >
              {walletDataLoading ? 'Refreshing' : 'Refresh'}
            </button>
          </div>
          <p className="ec-balance-value">{walletDataLoading && !snapshot ? 'Loading...' : snapshot ? `${snapshot.solBalance} SOL` : 'Unavailable'}</p>
          <div className="ec-action-pair">
            <button className="ec-primary" data-testid="send-sol" onClick={openSend}>
              Send
            </button>
            <button className="ec-secondary" data-testid="receive" onClick={() => setAccountScreen('receive')}>
              Receive
            </button>
          </div>
        </div>
        {renderCoverStatusCard()}
        <div className="ec-token-section" data-testid="wallet-tokens">
          {snapshot?.tokenBalancesUnavailable ? <span className="ec-muted">Tokens unavailable</span> : null}
          {snapshot && tokenBalances.length > 0 ? (
            <ul className="ec-token-list">
              {tokenBalances.map((token) => (
                <li className="ec-token-row" key={token.tokenAccount} data-testid="wallet-token-item">
                  <span className="ec-token-avatar" aria-hidden="true">{tokenInitial(token.label, token.mint)}</span>
                  <span className="ec-token-main">
                    <span className="ec-token-name">{token.label}</span>
                    <span className="ec-token-mint">{shortAddress(token.mint)}</span>
                  </span>
                  <span className="ec-token-amount">{token.uiAmount}</span>
                </li>
              ))}
            </ul>
          ) : snapshot && !walletDataLoading ? (
            <p className="ec-help">No tokens to show yet.</p>
          ) : null}
        </div>
      </section>
    )
  }

  function renderCoverActivation() {
    const canPay =
      !!paymentPreview &&
      paymentPreview.errors.length === 0 &&
      paymentPreview.simulation.status === 'success' &&
      !paymentBusy
    const canRetry = !!paymentState?.paymentSignature && paymentState.status !== 'active' && !paymentBusy
    return (
      <section className="ec-task-screen" data-testid="cover-activation">
        <div className="ec-screen-head">
          {renderBackButton(() => setAccountScreen(approvalPending ? 'approval' : 'home'))}
          <div>
            <span className="ec-control-label">One-off payment</span>
            <h2>Activate Ember Cover</h2>
          </div>
        </div>
        <p className="ec-help" data-testid="payment-copy">
          Pay 1 Devnet USDC once for 30 days of Core cover. This is a token transfer, not a recurring
          subscription or spending approval.
        </p>
        {paymentState ? (
          <section className="ec-review-card" data-testid="local-payment-state">
            <h3>Saved payment</h3>
            <dl className="ec-data-list">
              <div>
                <dt>Status</dt>
                <dd>{paymentState.status}</dd>
              </div>
              <div>
                <dt>Wallet</dt>
                <dd>{shortAddress(paymentState.walletAddress)}</dd>
              </div>
              <div>
                <dt>Payment</dt>
                <dd>
                  <a
                    href={`https://explorer.solana.com/tx/${encodeURIComponent(paymentState.paymentSignature)}?cluster=devnet`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {shortAddress(paymentState.paymentSignature)}
                  </a>
                </dd>
              </div>
              <div>
                <dt>Cover ends</dt>
                <dd>{paymentState.currentPeriodEnd ?? 'Pending activation'}</dd>
              </div>
            </dl>
            {paymentState.lastError ? <p>{paymentState.lastError}</p> : null}
          </section>
        ) : null}
        {paymentPreview ? (
          <section className="ec-review-card" data-testid="payment-review">
            <h3>Review one-off payment</h3>
            <dl className="ec-data-list">
              <div>
                <dt>Plan</dt>
                <dd>{paymentPreview.tier}</dd>
              </div>
              <div>
                <dt>Amount</dt>
                <dd>{paymentPreview.amountUsdc} USDC</dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{paymentPreview.periodDays} days</dd>
              </div>
              <div>
                <dt>Network</dt>
                <dd>{clusterLabel(paymentPreview.cluster)}</dd>
              </div>
              <div>
                <dt>From wallet</dt>
                <dd title={paymentPreview.walletAddress}>{shortAddress(paymentPreview.walletAddress)}</dd>
              </div>
              <div>
                <dt>Treasury token account</dt>
                <dd title={paymentPreview.treasuryTokenAccount}>
                  {shortAddress(paymentPreview.treasuryTokenAccount)}
                </dd>
              </div>
              <div>
                <dt>USDC mint</dt>
                <dd title={paymentPreview.tokenMint}>{shortAddress(paymentPreview.tokenMint)}</dd>
              </div>
              <div>
                <dt>Fee payer</dt>
                <dd>{shortAddress(paymentPreview.walletAddress)}</dd>
              </div>
              <div>
                <dt>Estimated network fee</dt>
                <dd>{paymentPreview.feeLamports} lamports</dd>
              </div>
            </dl>
            <p data-testid="payment-balances">
              USDC {paymentPreview.usdcBalance} · SOL {formatLamportsAsSol(BigInt(paymentPreview.solBalanceLamports))}
            </p>
            {paymentPreview.errors.length > 0 ? (
              <ul data-testid="payment-errors">
                {paymentPreview.errors.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
            {paymentPreview.simulation.status === 'success' ? (
              <p data-testid="payment-simulation-success">Simulation passed. Nothing has been signed or sent yet.</p>
            ) : null}
            {paymentPreview.simulation.status === 'failure' ? (
              <p data-testid="payment-simulation-error">Simulation failed: {paymentPreview.simulation.error}</p>
            ) : null}
          </section>
        ) : null}
        {paymentResult ? (
          <section className="ec-review-card" data-testid="payment-result">
            <h3>{paymentResult.apiCoverActive ? 'Cover active' : 'Activation pending'}</h3>
            <p>
              <a href={paymentResult.explorerUrl} rel="noreferrer" target="_blank">
                {shortAddress(paymentResult.signature)}
              </a>
            </p>
            {!paymentResult.apiCoverActive ? (
              <p>Your signed payment is saved. Retry activation; do not submit another payment.</p>
            ) : null}
          </section>
        ) : null}
        {paymentNotice ? <p data-testid="payment-notice">{paymentNotice}</p> : null}
        {paymentError ? <p data-testid="payment-error">{paymentError}</p> : null}
        {paymentNeedsUnlock ? (
          <input
            data-testid="payment-unlock-password"
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Wallet password"
            type="password"
            value={password}
          />
        ) : null}
        <div className="ec-flow-actions">
          {canRetry ? (
            <button
              className="ec-primary"
              data-testid="retry-payment-activation"
              disabled={paymentBusy}
              onClick={() => void syncCoverPayment()}
            >
              {paymentBusy ? 'Retrying...' : 'Retry activation'}
            </button>
          ) : !paymentPreview ? (
            <button
              className="ec-primary"
              data-testid="review-cover-payment"
              disabled={paymentBusy}
              onClick={() => void previewCoverPayment()}
            >
              {paymentBusy ? 'Checking...' : 'Review one-off payment'}
            </button>
          ) : (
            <button
              className="ec-primary"
              data-testid="pay-and-activate-cover"
              disabled={!canPay}
              onClick={() => void activateCoverPayment()}
            >
              {paymentBusy ? 'Submitting...' : `Pay ${paymentPreview.amountUsdc} USDC and activate cover`}
            </button>
          )}
        </div>
      </section>
    )
  }

  function renderReceive() {
    return (
      <section className="ec-task-screen" data-testid="receive-screen">
        <div className="ec-screen-head">
          {renderBackButton(() => setAccountScreen('home'))}
          <div>
            <span className="ec-control-label">{clusterLabel(cluster)}</span>
            <h2>Receive</h2>
          </div>
        </div>
        <p className="ec-help">Only receive Solana assets on {cluster === 'mainnet-beta' ? 'Mainnet' : 'Devnet'}.</p>
        <p className="ec-help">Ember Cover applies when you sign a transaction, not when someone sends funds to this address.</p>
        <div className="ec-qr-wrap">{address ? <QrCode value={address} /> : null}</div>
        <p className="ec-address-box" data-testid="receive-address">{address}</p>
        <div className="ec-flow-actions">
          <button className="ec-primary" data-testid="copy-address" onClick={() => void onCopyAddress()}>
            {copied ? 'Copied' : 'Copy address'}
          </button>
          {'share' in navigator ? (
            <button className="ec-secondary" data-testid="share-address" onClick={() => void onShareAddress()}>
              Share
            </button>
          ) : null}
        </div>
      </section>
    )
  }

  function renderSendCoverState() {
    if (coverStatusLoading) {
      return (
        <section className="ec-inline-cover" data-tone="checking" data-testid="send-cover-status">
          <span>Checking cover...</span>
          <p>Ember is checking this wallet's cover status.</p>
        </section>
      )
    }
    if (coverStatusSnapshot?.subscriptionActive && coverStatusSnapshot.walletRegistered) {
      return (
        <section className="ec-inline-cover" data-tone="covered" data-testid="send-cover-status">
          <span>Protected</span>
          <p>{formatCoverStatusSnapshot(coverStatusSnapshot)}</p>
        </section>
      )
    }
    const needsSync = paymentStatusView.primaryAction === 'sync'
    return (
      <section className="ec-inline-cover" data-tone={needsSync ? 'unavailable' : 'none'} data-testid="send-cover-status">
        <span>{needsSync ? 'Cover status unavailable' : 'Cover is not active'}</span>
        <p>{paymentStatusView.detail}</p>
        <button className="ec-secondary" onClick={openCoverActivation} type="button">
          {needsSync ? 'Retry activation' : 'Activate cover'}
        </button>
      </section>
    )
  }

  function renderSend() {
    if (sendStep === 'complete') {
      return (
        <section className="ec-task-screen" data-testid="send-complete">
          <div className="ec-screen-head">
            <span className="ec-screen-head__spacer" />
            <div>
              <span className="ec-control-label">Submitted</span>
              <h2>Send complete</h2>
            </div>
          </div>
          <p className="ec-help">{sendResult?.cover.label ?? 'Submitted'}</p>
          {sendResult ? (
            <p>
              <a href={sendResult.explorerUrl} rel="noreferrer" target="_blank">
                {shortAddress(sendResult.signature)}
              </a>
            </p>
          ) : null}
          <div className="ec-flow-actions">
            <button
              className="ec-primary"
              onClick={() => {
                setAccountScreen('home')
                setSendStep('form')
              }}
            >
              Done
            </button>
          </div>
        </section>
      )
    }

    if (sendStep === 'review') {
      const coverExpiresAt = sendPreview?.cover.coverStatus === 'covered' ? Date.parse(sendPreview.cover.decisionExpiresAt) : null
      const coverExpired = coverExpiresAt !== null && nowMs >= coverExpiresAt
      const coverSecondsLeft = coverExpiresAt === null ? null : Math.max(0, Math.ceil((coverExpiresAt - nowMs) / 1000))
      const reviewCapText = sendPreview
        ? sendPreview.cover.capContext
          ? coverCapReviewText(
              sendPreview.cover.coverStatus,
              sendPreview.cover.capContext,
              sendPreview.cover.coveredTxCountImpact ?? 0,
            )
          : sendPreview.cover.coverStatus === 'covered'
            ? 'Cover usage unavailable.'
            : ''
        : ''
      const canSend =
        !!sendPreview &&
        !sendPreviewLoading &&
        !sendBusy &&
        !coverExpired &&
        sendPreview.simulation.status === 'success' &&
        (!sendPreview.cover.requiresUncoveredAck || uncoveredAck) &&
        (!sendPreview.cover.requiresHighRiskAck || highRiskAck)
      return (
        <section className="ec-task-screen" data-testid="send-review">
          <div className="ec-screen-head">
            {renderBackButton(() => setSendStep('form'))}
            <div>
              <span className="ec-control-label">{clusterLabel(cluster)}</span>
              <h2>Review send</h2>
            </div>
          </div>
          {sendPreviewLoading ? <p data-testid="send-preview-loading">Checking send...</p> : null}
          {sendPreview ? (
            <>
              <dl className="ec-data-list">
                <div>
                  <dt>Outgoing</dt>
                  <dd>{sendPreview.amountSol} SOL</dd>
                </div>
                <div>
                  <dt>From</dt>
                  <dd>{shortAddress(sendPreview.source)}</dd>
                </div>
                <div>
                  <dt>To</dt>
                  <dd data-testid="send-review-destination">{sendPreview.destination}</dd>
                </div>
                <div>
                  <dt>Network fee</dt>
                  <dd>{sendPreview.feeSol} SOL</dd>
                </div>
                <div>
                  <dt>Network</dt>
                  <dd>{cluster === 'mainnet-beta' ? 'Mainnet' : 'Devnet'}</dd>
                </div>
                <div>
                  <dt>Total debit</dt>
                  <dd>{sendPreview.totalDebitSol} SOL</dd>
                </div>
                <div>
                  <dt>Balance after</dt>
                  <dd>{sendPreview.balanceAfterSol} SOL</dd>
                </div>
              </dl>
              <section className="ec-review-card ec-cover-decision" data-testid="send-cover">
                <h3>{sendPreview.cover.label}</h3>
                <p className="ec-help">{sendPreview.cover.body}</p>
                {reviewCapText ? <p data-testid="send-cover-cap">{reviewCapText}</p> : null}
                {coverExpired ? (
                  <p data-testid="send-cover-expired">Cover check expired. Recheck cover before sending.</p>
                ) : coverSecondsLeft !== null && coverSecondsLeft <= 10 ? (
                  <p data-testid="send-cover-expiring">Cover check expires soon.</p>
                ) : null}
                {sendPreview.cover.requiresUncoveredAck ? (
                  <label className="ec-ack">
                    <input
                      checked={uncoveredAck}
                      data-testid="send-uncovered-ack"
                      onChange={(event) => setUncoveredAck(event.currentTarget.checked)}
                      type="checkbox"
                    />{' '}
                    I understand this send will not be covered.
                  </label>
                ) : null}
                {sendPreview.cover.requiresHighRiskAck ? (
                  <label className="ec-ack">
                    <input
                      checked={highRiskAck}
                      data-testid="send-risk-ack"
                      onChange={(event) => setHighRiskAck(event.currentTarget.checked)}
                      type="checkbox"
                    />{' '}
                    I understand this covered send is high risk.
                  </label>
                ) : null}
              </section>
              {sendPreview.simulation.status === 'failure' ? (
                <p data-testid="send-simulation-error">Simulation failed. The transaction was not sent.</p>
              ) : null}
            </>
          ) : null}
          {sendError ? <p data-testid="send-error">{sendError}</p> : null}
          <div className="ec-flow-actions">
            <button className="ec-primary" data-testid="send-submit" disabled={!canSend} onClick={() => void onSendSol()}>
              {sendBusy
                ? 'Sending...'
                : sendPreview?.cover.requiresHighRiskAck
                  ? 'Send high-risk transaction'
                  : sendPreview?.cover.requiresUncoveredAck
                    ? 'Send without cover'
                    : 'Send'}
            </button>
            <button className="ec-link-button" data-testid="send-recheck-cover" disabled={sendPreviewLoading || sendBusy} onClick={() => void loadSendPreview()}>
              Recheck cover
            </button>
          </div>
        </section>
      )
    }

    return (
      <section className="ec-task-screen ec-form-grid" data-testid="send-form">
        <div className="ec-screen-head">
          {renderBackButton(() => setAccountScreen('home'))}
          <div>
            <span className="ec-control-label">{clusterLabel(cluster)}</span>
            <h2>Send SOL</h2>
          </div>
        </div>
        <div className="ec-field-with-action">
          <label>
            To
            <input
              autoFocus
              data-testid="send-recipient-input"
              onChange={(event) => {
                setSendError('')
                setSendRecipientFromClipboard(false)
                setSendRecipient(event.currentTarget.value)
              }}
              placeholder="Wallet address"
              value={sendRecipient}
            />
          </label>
          <button className="ec-quiet-button" data-testid="paste-recipient" onClick={() => void onPasteRecipient()}>
            Paste
          </button>
        </div>
        {sendRecipientFromClipboard && recipientTrimmed ? (
          <p data-testid="paste-recipient-warning">
            Pasted from clipboard. Verify this matches the address you copied: {recipientTrimmed}
          </p>
        ) : null}
        {recipientError ? <p data-testid="send-recipient-error">{recipientError}</p> : null}
        {selfSendError ? <p data-testid="send-self-error">{selfSendError}</p> : null}
        <div className="ec-field-with-action">
          <label>
            Amount
            <input
              data-testid="send-amount-input"
              inputMode="decimal"
              onChange={(event) => {
                setSendError('')
                setSendAmount(event.currentTarget.value)
              }}
              placeholder="0"
              value={sendAmount}
            />
          </label>
          <button className="ec-quiet-button" data-testid="send-max" onClick={() => setSendAmount(maxSendableSol(snapshot))}>
            Max
          </button>
        </div>
        <p className="ec-help">Available {snapshot ? `${snapshot.solBalance} SOL` : 'unavailable'}</p>
        {renderSendCoverState()}
        {sendAmountError ? <p data-testid="send-amount-error">{sendAmountError}</p> : null}
        {sendError ? <p data-testid="send-error">{sendError}</p> : null}
        <div className="ec-flow-actions">
          <button
            className="ec-primary"
            data-testid="send-review-next"
            disabled={!recipientValid || recipientIsSelf || !sendAmount.trim() || !!sendAmountError}
            onClick={() => {
              setSendStep('review')
              void loadSendPreview()
            }}
          >
            Review send
          </button>
        </div>
      </section>
    )
  }

  function renderActivity() {
    const onchainSignatures = new Set(activity.map((item) => item.signature))
    const pendingEmber = emberActivity.filter((item) => !item.signature || !onchainSignatures.has(item.signature))
    return (
      <section className="ec-account-card" data-testid="wallet-activity">
        <h2>Activity</h2>
        {walletDataError ? <p data-testid="wallet-data-error">{walletDataError}</p> : null}
        {walletDataLoading && snapshot ? <p>Refreshing transactions...</p> : null}
        {snapshot?.activityUnavailable ? <p data-testid="wallet-activity-unavailable">Transaction history unavailable.</p> : null}
        {snapshot && activity.length > 0 ? (
          <ul className="ec-activity-list">
            {activity.map((tx) => {
              const emberRecord = emberActivity.find((item) => item.signature === tx.signature)
              const coverStatus = emberRecord?.coverStatus ?? 'unknown'
              const amount = emberRecord?.amount ?? tx.amount
              const counterparty = emberRecord?.recipient ?? tx.counterparty
              return (
                <li className="ec-activity-row" key={tx.signature} data-testid="wallet-activity-item">
                  <span className="ec-activity-main">
                    <span className="ec-activity-title">{emberRecord?.title ?? tx.title}</span>
                    <span className="ec-activity-meta">
                      {activityState(tx.failed, tx.confirmationStatus)} · {activityDate(tx.blockTime)}
                      {counterparty ? ` · ${tx.direction === 'received' ? 'from' : 'to'} ${shortAddress(counterparty)}` : ''}
                    </span>
                  </span>
                  <span className="ec-activity-side">
                    {amount ? <span className="ec-activity-amount">{amount}</span> : null}
                    {coverStatus !== 'unknown' ? (
                      <span className="ec-cover-pill" data-tone={coverTone(coverStatus)}>{coverStatusLabel(coverStatus)}</span>
                    ) : null}
                    <a className="ec-link-button" href={tx.explorerUrl} rel="noreferrer" target="_blank">
                      Explorer
                    </a>
                  </span>
                </li>
              )
            })}
          </ul>
        ) : snapshot && !walletDataLoading && !snapshot.activityUnavailable ? (
          <p>No transactions found.</p>
        ) : null}
        {snapshot?.emberActivityUnavailable ? <p>Ember activity unavailable.</p> : null}
        {pendingEmber.length > 0 ? (
          <>
            <h3>Pending cover records</h3>
            <ul className="ec-activity-list" data-testid="ember-activity">
              {pendingEmber.map((item) => (
                <li className="ec-activity-row" key={item.id} data-testid="ember-activity-item">
                  <span className="ec-activity-main">
                    <span className="ec-activity-title">{item.title ?? 'Transaction'}</span>
                    <span className="ec-activity-meta">
                      {item.onchainStatus ?? 'Pending'}
                      {item.recipient ? ` · to ${shortAddress(item.recipient)}` : ''}
                    </span>
                  </span>
                  <span className="ec-activity-side">
                    {item.amount ? <span className="ec-activity-amount">{item.amount}</span> : null}
                    <span className="ec-cover-pill" data-tone={coverTone(item.coverStatus)}>{coverStatusLabel(item.coverStatus)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
    )
  }

  if (view === 'loading') return <p>Loading...</p>
  if (view === 'account') {
    return (
      <div className="ec-shell">
        {renderTopbar()}
        <main className="ec-shell__main">
          {accountScreen === 'home' ? (
            <>
              {renderWalletControls()}
              {mainTab === 'assets' ? renderAssets() : renderActivity()}
            </>
          ) : null}
          {mainTab === 'assets' && accountScreen === 'receive' ? renderReceive() : null}
          {mainTab === 'assets' && accountScreen === 'send' ? renderSend() : null}
          {mainTab === 'assets' && accountScreen === 'cover' ? renderCoverActivation() : null}
          {accountScreen === 'approval' ? (
            <Suspense fallback={<section className="ec-task-screen"><p className="ec-help">Loading request...</p></section>}>
              <ApprovalScreen
                onApproved={onApprovalApproved}
                onRejected={onApprovalRejected}
                onSetupCover={openCoverActivation}
              />
            </Suspense>
          ) : null}
        </main>
        {accountScreen === 'home' ? renderTabs() : null}
      </div>
    )
  }
  return (
    <div className="ec-auth-shell">
      <header className="ec-topbar">
        <div className="ec-brand">
          <span className="ec-mark-frame">
            <BrandMark className="ec-brand-mark" title="Ember Cover" />
          </span>
          <span className="ec-brand-copy">
            <span className="ec-brand-name">Ember</span>
            <span className="ec-brand-subtitle">Cover wallet</span>
          </span>
        </div>
      </header>
      <h1>{view === 'create' ? 'Create your Ember wallet' : 'Unlock'}</h1>
      <input data-testid="password" onChange={(event) => setPassword(event.target.value)} type="password" value={password} />
      <button className="ec-primary" data-testid="submit" onClick={() => void (view === 'create' ? onCreate() : onUnlock())}>
        {authBusy ? (view === 'create' ? 'Creating...' : 'Secure unlocking...') : view === 'create' ? 'Create' : 'Unlock'}
      </button>
      {authBusy ? <p data-testid="auth-busy">{view === 'create' ? 'Creating wallet...' : 'Secure unlocking...'}</p> : null}
      {error ? <p data-testid="error">{error}</p> : null}
    </div>
  )
}
