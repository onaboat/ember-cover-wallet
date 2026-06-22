import { lazy, Suspense, useEffect, useState } from 'react'
import { address as toAddress } from '@solana/kit'

import { getCoverService } from '../../background/cover-service.ts'
import { getRequestApproval } from '../../background/request-service.ts'
import { getWalletTransferService, parseSolAmountToLamports } from '../../background/sol-transfer-service.ts'
import type { SolTransferPreview, SolTransferResult } from '../../background/sol-transfer-service.ts'
import { getSubscriptionService } from '../../background/subscription-service.ts'
import type {
  LocalSubscriptionState,
  SubscriptionActivationResult,
  SubscriptionPreview,
} from '../../background/subscription-service.ts'
import type { EmberBillingPeriod, EmberCoverPlan, EmberCoverPlanId } from '../../background/subscription-config.ts'
import { getVaultService } from '../../background/vault-service.ts'
import { formatLamportsAsSol } from '../../background/wallet-data-service.ts'
import type { WalletDataSnapshot } from '../../background/wallet-data-service.ts'
import { getWalletDataService } from '../../background/wallet-data-service.ts'
import type { WalletCluster } from '../../background/wallet-data-config.ts'
import { WALLET_CLUSTER_OPTIONS } from '../../background/wallet-data-config.ts'
import { coverCapReviewText, formatCoverStatusSnapshot } from '../../cover/cover-cap-view.ts'
import type { CoverStatusSnapshot } from '../../cover/ember-types.ts'
import { BrandMark } from '../../ui/BrandMark.tsx'
import { subscriptionStatusView } from '../../ui/subscription-status-view.ts'
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
  const subscriptions = getSubscriptionService()
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
  const [coverPlans, setCoverPlans] = useState<readonly EmberCoverPlan[]>([])
  const [selectedPlanId, setSelectedPlanId] = useState<EmberCoverPlanId>('core')
  const [selectedBillingPeriod, setSelectedBillingPeriod] = useState<EmberBillingPeriod>('monthly')
  const [subscriptionPreview, setSubscriptionPreview] = useState<SubscriptionPreview | null>(null)
  const [subscriptionState, setSubscriptionState] = useState<LocalSubscriptionState | null>(null)
  const [subscriptionResult, setSubscriptionResult] = useState<SubscriptionActivationResult | null>(null)
  const [subscriptionBusy, setSubscriptionBusy] = useState(false)
  const [subscriptionError, setSubscriptionError] = useState('')
  const [subscriptionNotice, setSubscriptionNotice] = useState('')
  const [subscriptionNeedsUnlock, setSubscriptionNeedsUnlock] = useState(false)
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
  const subscriptionView = subscriptionStatusView({
    cluster,
    coverEnrolled,
    coverStatusLoading,
    coverStatusSnapshot,
    subscriptionState,
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

  async function refreshSubscriptionState() {
    if (!address) return
    try {
      setCoverPlans(await subscriptions.plans())
      setSubscriptionState(await subscriptions.localSubscription(address))
    } catch {
      setSubscriptionError('Subscription state unavailable')
    }
  }

  useEffect(() => {
    if (view === 'account') {
      void refreshSubscriptionState()
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
    setSubscriptionPreview(null)
    setSubscriptionResult(null)
    setSubscriptionError('')
    setSubscriptionNotice('')
    setSubscriptionNeedsUnlock(false)
  }

  // Setup/Approve/Sync each need a fresh VAULT signature, and the vault can idle-lock while the
  // popup stays on the cover screen. Ensure it is unlocked before signing; if it is locked, prompt
  // for the password inline (reusing the unlock `password` state) instead of failing the action.
  async function ensureSubscriptionUnlocked(): Promise<boolean> {
    if (await vault.isUnlocked()) {
      return true
    }
    if (!password) {
      setSubscriptionNeedsUnlock(true)
      setSubscriptionError('Wallet locked. Enter your password to continue.')
      return false
    }
    try {
      await vault.unlock(password)
      setPassword('')
      setSubscriptionNeedsUnlock(false)
      return true
    } catch {
      setSubscriptionNeedsUnlock(true)
      setSubscriptionError('Wrong password')
      return false
    }
  }

  function handleSubscriptionError(e: unknown, fallback: string) {
    const message = errorMessage(e, fallback)
    if (isVaultLockedError(message)) {
      setSubscriptionNeedsUnlock(true)
      setSubscriptionError('Wallet re-locked. Enter your password and try again.')
    } else {
      setSubscriptionError(message)
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

  async function previewSelectedSubscription() {
    setSubscriptionBusy(true)
    setSubscriptionError('')
    setSubscriptionNotice('')
    setSubscriptionPreview(null)
    setSubscriptionResult(null)
    try {
      setSubscriptionPreview(
        await subscriptions.previewSubscription({
          planId: selectedPlanId,
          billingPeriod: selectedBillingPeriod,
          cluster,
        }),
      )
    } catch (e) {
      setSubscriptionError(errorMessage(e, 'Could not review subscription'))
    } finally {
      setSubscriptionBusy(false)
    }
  }

  async function setupSelectedSubscription() {
    setSubscriptionBusy(true)
    setSubscriptionError('')
    setSubscriptionNotice('')
    if (!(await ensureSubscriptionUnlocked())) {
      setSubscriptionBusy(false)
      return
    }
    try {
      const result = await subscriptions.setupSubscription({
        planId: selectedPlanId,
        billingPeriod: selectedBillingPeriod,
        cluster,
      })
      setSubscriptionState(result.state)
      setSubscriptionPreview(null)
      setSubscriptionResult(null)
      setSubscriptionNotice('Setup confirmed. Fund the USDC account, then review the subscription again.')
      await refreshSubscriptionState()
    } catch (e) {
      handleSubscriptionError(e, 'Could not complete subscription setup')
    } finally {
      setSubscriptionBusy(false)
    }
  }

  async function activateSelectedSubscription() {
    setSubscriptionBusy(true)
    setSubscriptionError('')
    setSubscriptionNotice('')
    if (!(await ensureSubscriptionUnlocked())) {
      setSubscriptionBusy(false)
      return
    }
    try {
      const result = await subscriptions.activateSubscription({
        planId: selectedPlanId,
        billingPeriod: selectedBillingPeriod,
        cluster,
      })
      setSubscriptionResult(result)
      setSubscriptionState(result.state)
      setSubscriptionPreview(result.preview)
      await refreshCoverState()
      await refreshSubscriptionState()
    } catch (e) {
      handleSubscriptionError(e, 'Could not approve subscription')
    } finally {
      setSubscriptionBusy(false)
    }
  }

  async function syncSubscriptionEntitlement() {
    setSubscriptionBusy(true)
    setSubscriptionError('')
    setSubscriptionNotice('')
    if (!(await ensureSubscriptionUnlocked())) {
      setSubscriptionBusy(false)
      return
    }
    try {
      const state = await subscriptions.syncEntitlement(address ?? undefined)
      setSubscriptionState(state)
      await refreshCoverState()
      if (state?.status === 'active') {
        setSubscriptionNotice('Cover entitlement synced.')
      } else if (state) {
        setSubscriptionNotice('Subscription is still pending API entitlement activation.')
      } else {
        setSubscriptionError('No subscription found for this wallet.')
      }
    } catch (e) {
      handleSubscriptionError(e, 'Could not sync cover entitlement')
    } finally {
      setSubscriptionBusy(false)
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
        <span className="ec-status-badge" data-tone={subscriptionView.badgeTone}>
          {subscriptionView.badgeLabel}
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
      subscriptionView.primaryAction === 'manage'
        ? 'Manage Cover'
        : subscriptionView.primaryAction === 'sync'
          ? 'Sync entitlement'
          : 'Set up cover'
    const actionTestId = subscriptionView.primaryAction === 'manage' ? 'manage-cover' : 'activate-cover'
    return (
      <section className="ec-cover-strip" data-testid="wallet-cover-status">
        <div className="ec-cover-strip__main">
          <span className="ec-section-icon" aria-hidden="true">
            <BrandMark title="Coverage" />
          </span>
          <div>
            <h2 className="ec-cover-title">{subscriptionView.title}</h2>
            <p className="ec-cover-detail">{subscriptionView.detail}</p>
          </div>
        </div>
        <div className="ec-cover-strip__side">
          <span className="ec-status-badge" data-tone={subscriptionView.badgeTone} data-testid="cover-status">
            {subscriptionView.badgeLabel}
          </span>
          <button
            className={subscriptionView.primaryAction === 'activate' ? 'ec-primary' : 'ec-secondary'}
            data-testid={actionTestId}
            onClick={openCoverActivation}
            type="button"
          >
            {actionLabel}
          </button>
        </div>
        {subscriptionView.metrics.length > 0 ? (
          <dl className="ec-metrics">
            {subscriptionView.metrics.map((metric) => (
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

  function planPrice(plan: EmberCoverPlan): string {
    return selectedBillingPeriod === 'monthly' ? `${plan.monthlyPriceUsdc} USDC / month` : `${plan.annualPriceUsdc} USDC / year`
  }

  function renderCoverActivation() {
    const selectedPlan = coverPlans.find((plan) => plan.id === selectedPlanId) ?? coverPlans[0]
    const canActivate =
      !!subscriptionPreview &&
      subscriptionPreview.errors.length === 0 &&
      subscriptionPreview.simulation.status === 'success' &&
      !subscriptionBusy
    const canSetup =
      !!subscriptionPreview &&
      subscriptionPreview.setupRequired &&
      !subscriptionBusy &&
      !subscriptionPreview.errors.includes('Not enough SOL for network fees.')
    const canSyncEntitlement =
      !!subscriptionState?.subscriptionSignature &&
      subscriptionState.status !== 'active' &&
      !subscriptionBusy
    const showPlanSelection = !canSyncEntitlement
    return (
      <section className="ec-task-screen" data-testid="cover-activation">
        <div className="ec-screen-head">
          {renderBackButton(() => setAccountScreen(approvalPending ? 'approval' : 'home'))}
          <div>
            <span className="ec-control-label">Coverage</span>
            <h2>Activate Cover</h2>
          </div>
        </div>
        {subscriptionState ? (
          <section className="ec-review-card" data-testid="local-subscription-state">
            <h3>Subscription</h3>
            <dl className="ec-data-list">
              <div>
                <dt>Status</dt>
                <dd>{subscriptionState.status}</dd>
              </div>
              <div>
                <dt>Wallet</dt>
                <dd>{shortAddress(subscriptionState.walletAddress)}</dd>
              </div>
              <div>
                <dt>Plan PDA</dt>
                <dd>{shortAddress(subscriptionState.planPda)}</dd>
              </div>
              <div>
                <dt>Subscription PDA</dt>
                <dd>{shortAddress(subscriptionState.subscriptionPda)}</dd>
              </div>
            </dl>
          </section>
        ) : null}
        {showPlanSelection ? (
          <>
            <div className="ec-tabs" data-testid="billing-period">
              <button
                aria-selected={selectedBillingPeriod === 'monthly'}
                onClick={() => {
                  setSelectedBillingPeriod('monthly')
                  setSubscriptionPreview(null)
                  setSubscriptionResult(null)
                  setSubscriptionNotice('')
                }}
              >
                Monthly
              </button>
              <button
                aria-selected={selectedBillingPeriod === 'annual'}
                onClick={() => {
                  setSelectedBillingPeriod('annual')
                  setSubscriptionPreview(null)
                  setSubscriptionResult(null)
                  setSubscriptionNotice('')
                }}
              >
                Annual
              </button>
            </div>
            <div className="ec-plan-grid" data-testid="cover-plan-options">
              {coverPlans.map((plan) => (
                <button
                  className="ec-plan-option"
                  aria-selected={selectedPlanId === plan.id}
                  data-testid={`cover-plan-${plan.id}`}
                  key={plan.id}
                  onClick={() => {
                    setSelectedPlanId(plan.id)
                    setSubscriptionPreview(null)
                    setSubscriptionResult(null)
                    setSubscriptionNotice('')
                  }}
                >
                  <strong>{plan.name}</strong>
                  <span>{planPrice(plan)}</span>
                  <span>${plan.coverCapUsd.toLocaleString()} cap · {plan.coveredTxAllowance} covered tx</span>
                </button>
              ))}
            </div>
            {selectedPlan ? (
              <p className="ec-help" data-testid="subscription-copy">
                This approves an onchain USDC subscription for Ember Cover. Ember can collect only according to this plan.
              </p>
            ) : null}
          </>
        ) : null}
        {subscriptionPreview ? (
          <section className="ec-review-card" data-testid="subscription-review">
            <h3>Subscription approval</h3>
            <dl className="ec-data-list">
              <div>
                <dt>Merchant</dt>
                <dd>Ember Cover</dd>
              </div>
              <div>
                <dt>Plan</dt>
                <dd>{subscriptionPreview.plan.name}</dd>
              </div>
              <div>
                <dt>Amount</dt>
                <dd>{subscriptionPreview.amountUsdc} USDC</dd>
              </div>
              <div>
                <dt>Billing period</dt>
                <dd>{subscriptionPreview.renewalPeriod}</dd>
              </div>
              <div>
                <dt>Token</dt>
                <dd>USDC</dd>
              </div>
              <div>
                <dt>Approved collector</dt>
                <dd>{shortAddress(subscriptionPreview.approvedPuller)}</dd>
              </div>
              <div>
                <dt>User wallet</dt>
                <dd>{shortAddress(subscriptionPreview.walletAddress)}</dd>
              </div>
              <div>
                <dt>Subscription program</dt>
                <dd>{shortAddress(subscriptionPreview.subscriptionProgram)}</dd>
              </div>
            </dl>
            {subscriptionPreview.setupRequired ? (
              <p data-testid="subscription-setup-note">Setup transaction required before subscription approval.</p>
            ) : null}
            <p data-testid="subscription-balances">
              USDC {subscriptionPreview.usdcBalance} · SOL lamports {subscriptionPreview.solBalanceLamports}
            </p>
            {subscriptionPreview.errors.length > 0 ? (
              <ul data-testid="subscription-errors">
                {subscriptionPreview.errors.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
            {subscriptionPreview.simulation.status === 'failure' ? (
              <p data-testid="subscription-simulation-error">Simulation failed: {subscriptionPreview.simulation.error}</p>
            ) : null}
          </section>
        ) : null}
        {subscriptionResult ? (
          <section className="ec-review-card" data-testid="subscription-result">
            <h3>{subscriptionResult.apiCoverActive ? 'Cover active' : 'Subscription confirmed'}</h3>
            <p>
              <a href={subscriptionResult.explorerUrl} rel="noreferrer" target="_blank">
                {shortAddress(subscriptionResult.signature)}
              </a>
            </p>
            {!subscriptionResult.apiCoverActive ? (
              <p>API entitlement is pending. Ember Cover decisions remain API-controlled.</p>
            ) : null}
          </section>
        ) : null}
        {subscriptionNotice ? <p data-testid="subscription-notice">{subscriptionNotice}</p> : null}
        {subscriptionError ? <p data-testid="subscription-error">{subscriptionError}</p> : null}
        {subscriptionNeedsUnlock ? (
          <input
            data-testid="subscription-unlock-password"
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Wallet password"
            type="password"
            value={password}
          />
        ) : null}
        <div className="ec-flow-actions">
          {canSyncEntitlement ? (
            <button className="ec-primary" data-testid="sync-subscription-entitlement" disabled={subscriptionBusy} onClick={() => void syncSubscriptionEntitlement()}>
              {subscriptionBusy ? 'Syncing...' : 'Sync cover entitlement'}
            </button>
          ) : !subscriptionPreview ? (
            <button className="ec-primary" data-testid="review-subscription" disabled={subscriptionBusy || !selectedPlan} onClick={() => void previewSelectedSubscription()}>
              {subscriptionBusy ? 'Checking...' : 'Review subscription'}
            </button>
          ) : subscriptionPreview.setupRequired ? (
            <button className="ec-primary" data-testid="setup-subscription" disabled={!canSetup} onClick={() => void setupSelectedSubscription()}>
              {subscriptionBusy ? 'Setting up...' : 'Create USDC setup'}
            </button>
          ) : (
            <button className="ec-primary" data-testid="approve-subscription" disabled={!canActivate} onClick={() => void activateSelectedSubscription()}>
              {subscriptionBusy ? 'Approving...' : 'Approve subscription'}
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
    const needsSync = subscriptionView.primaryAction === 'sync'
    return (
      <section className="ec-inline-cover" data-tone={needsSync ? 'unavailable' : 'none'} data-testid="send-cover-status">
        <span>{needsSync ? 'Cover status unavailable' : 'Cover is not active'}</span>
        <p>{subscriptionView.detail}</p>
        <button className="ec-secondary" onClick={openCoverActivation} type="button">
          {needsSync ? 'Sync cover' : 'Set up cover'}
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
