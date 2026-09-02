import { lazy, Suspense, useEffect, useState } from 'react'
import { address as toAddress } from '@solana/kit'
import type {
  ClaimEligibilityResponse,
  WalletClaimResponse,
} from '@embercover/wallet-sdk'

import { getCoverService } from '../../background/cover-service.ts'
import { getCoveragePaymentService } from '../../background/coverage-payment-service.ts'
import type {
  CoverageOfferView,
  CoveragePaymentPreview,
  CoveragePaymentResult,
  LocalCoveragePaymentState,
} from '../../background/coverage-payment-service.ts'
import type { EmberSessionStatus } from '../../background/ember-client-coordinator.ts'
import type { WalletLifecycleSnapshot } from '../../background/ember-lifecycle-store.ts'
import { getRequestApproval } from '../../background/request-service.ts'
import {
  getWalletTransferService,
  parseSolAmountToLamports,
  parseTokenAmountToBaseUnits,
} from '../../background/sol-transfer-service.ts'
import type { SolTransferPreview, SolTransferResult } from '../../background/sol-transfer-service.ts'
import type { WalletTransferAsset } from '../../background/sol-transfer-service.ts'
import { getVaultService } from '../../background/vault-service.ts'
import { formatLamportsAsSol } from '../../background/wallet-data-service.ts'
import type { WalletDataSnapshot } from '../../background/wallet-data-service.ts'
import { getWalletDataService } from '../../background/wallet-data-service.ts'
import type { WalletCluster } from '../../background/wallet-data-config.ts'
import {
  DEFAULT_WALLET_CLUSTER,
  WALLET_CLUSTER_OPTIONS,
} from '../../background/wallet-data-config.ts'
import { coverCapReviewText, formatCoverStatusSnapshot } from '../../cover/cover-cap-view.ts'
import { EMBER_CONFIG } from '../../cover/ember-config.ts'
import type { CoverStatusSnapshot } from '../../cover/ember-types.ts'
import { coverStatusActive } from '../../cover/ember-types.ts'
import { BrandMark } from '../../ui/BrandMark.tsx'
import { coveragePaymentStatusView } from '../../ui/coverage-payment-status-view.ts'
import { isVaultLockedError } from '../../vault/vault-lock.ts'
import { QrCode } from './qr-code.tsx'

// Lazy so the toolbar popup (which never decodes raw dapp transactions) does not eagerly
// pull in the transaction/message decoders. Only the approval window mounts this screen.
const ApprovalScreen = lazy(() =>
  import('../request/ApprovalScreen.tsx').then((m) => ({ default: m.ApprovalScreen })),
)

type WalletMode = 'wallet' | 'approval'
type View = 'loading' | 'create' | 'unlock' | 'recover' | 'account'
type MainTab = 'assets' | 'activity'
type AccountScreen =
  | 'home'
  | 'receive'
  | 'send'
  | 'cover'
  | 'settings'
  | 'approval'
  | 'activity-detail'
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

function formatBaseUnits(value: string, decimals: number): string {
  const amount = BigInt(value)
  const divisor = 10n ** BigInt(decimals)
  const whole = amount / divisor
  const fraction = (amount % divisor).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

function formatUsdMicros(value: string): string {
  const amount = BigInt(value)
  const whole = (amount / 1_000_000n).toLocaleString('en-US')
  const fraction = (amount % 1_000_000n)
    .toString()
    .padStart(6, '0')
    .replace(/0+$/, '')
    .padEnd(2, '0')
  return `$${whole}.${fraction}`
}

function usdToMicros(value: string): string {
  const trimmed = value.trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(trimmed)) {
    throw new Error('Enter a positive USD amount with at most 6 decimal places')
  }
  const [whole = '0', fraction = ''] = trimmed.split('.')
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
  if (micros <= 0n) throw new Error('Claim amount must be greater than zero')
  return micros.toString()
}

function tokenInitial(iconText: string, mint: string): string {
  return (iconText[0] ?? mint[0] ?? 'T').toUpperCase()
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

function walletTransactionStatusLabel(status: string | null): string {
  if (status === 'signed') return 'Signed · broadcast not yet observed'
  if (status === 'broadcast') return 'Broadcast · waiting for confirmation'
  if (status === 'processed') return 'Processed'
  if (status === 'confirmed') return 'Confirmed'
  if (status === 'finalized') return 'Finalized'
  if (status === 'failed') return 'Failed'
  if (status === 'expired') return 'Expired'
  return 'Status unknown'
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function paymentErrorMessage(error: unknown, fallback: string): string {
  const message = typeof error === 'string' ? error : errorMessage(error, fallback)
  const messages: readonly [string, string][] = [
    ['tx_not_confirmed', 'The payment is not confirmed yet. Retry activation without paying again.'],
    ['rpc_unavailable', 'Solana confirmation is temporarily unavailable. Retry activation without paying again.'],
    ['cluster_mismatch', 'The payment was made on the wrong Solana network.'],
    ['amount_too_low', 'The confirmed payment amount was below the required 1 USDC.'],
    ['no_matching_transfer', 'The confirmed transaction did not contain the required Ember treasury payment.'],
    ['payment_already_used', 'This payment signature has already been used for another entitlement.'],
    ['cover_status_unavailable', 'Live cover status is unavailable. Check again before approving another payment.'],
  ]
  return messages.find(([code]) => message.includes(code))?.[1] ?? message
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

function amountValidation(
  amount: string,
  snapshot: WalletDataSnapshot | null,
  asset: WalletTransferAsset,
): string {
  if (!amount.trim()) return ''
  try {
    if (asset.kind === 'sol') {
      const lamports = parseSolAmountToLamports(amount)
      if (snapshot && lamports > BigInt(snapshot.lamports) - BASE_FEE_LAMPORTS) {
        return `Not enough SOL for amount and network fee. Max is ${maxSendableSol(snapshot)} SOL.`
      }
    } else {
      const baseUnits = parseTokenAmountToBaseUnits(amount, asset.decimals)
      if (baseUnits > BigInt(asset.rawBalance)) {
        return `Not enough ${asset.symbol}.`
      }
    }
    return ''
  } catch (error) {
    return errorMessage(error, `Enter a valid ${asset.symbol} amount`)
  }
}

export function App({ mode = 'wallet' }: AppProps = {}) {
  const vault = getVaultService()
  const cover = getCoverService()
  const payments = getCoveragePaymentService()
  const walletData = getWalletDataService()
  const transfers = getWalletTransferService()
  const approval = getRequestApproval()
  const [view, setView] = useState<View>('loading')
  const [mainTab, setMainTab] = useState<MainTab>('assets')
  const [accountScreen, setAccountScreen] = useState<AccountScreen>(mode === 'approval' ? 'approval' : 'home')
  const [approvalPending, setApprovalPending] = useState(mode === 'approval')
  const [address, setAddress] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [error, setError] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [coverEnrolled, setCoverEnrolled] = useState<boolean | null>(null)
  const [coverSession, setCoverSession] = useState<EmberSessionStatus | null>(null)
  const [coverLifecycle, setCoverLifecycle] = useState<WalletLifecycleSnapshot | null>(null)
  const [coverStatusSnapshot, setCoverStatusSnapshot] = useState<CoverStatusSnapshot | null>(null)
  const [coverStatusLoading, setCoverStatusLoading] = useState(false)
  const [coverageOffers, setCoverageOffers] = useState<CoverageOfferView[]>([])
  const [selectedOfferId, setSelectedOfferId] = useState('')
  const [termsAccepted, setTermsAccepted] = useState(false)
  const [paymentPreview, setPaymentPreview] = useState<CoveragePaymentPreview | null>(null)
  const [paymentState, setPaymentState] = useState<LocalCoveragePaymentState | null>(null)
  const [paymentResult, setPaymentResult] = useState<CoveragePaymentResult | null>(null)
  const [paymentBusy, setPaymentBusy] = useState(false)
  const [paymentError, setPaymentError] = useState('')
  const [paymentNotice, setPaymentNotice] = useState('')
  const [paymentNeedsUnlock, setPaymentNeedsUnlock] = useState(false)
  const [cluster, setCluster] = useState<WalletCluster>(DEFAULT_WALLET_CLUSTER)
  const [snapshot, setSnapshot] = useState<WalletDataSnapshot | null>(null)
  const [walletDataLoading, setWalletDataLoading] = useState(false)
  const [walletDataError, setWalletDataError] = useState('')
  const [copied, setCopied] = useState(false)
  const [sendStep, setSendStep] = useState<SendStep>('form')
  const [sendRecipient, setSendRecipient] = useState('')
  const [sendRecipientFromClipboard, setSendRecipientFromClipboard] = useState(false)
  const [sendAmount, setSendAmount] = useState('')
  const [sendAssetId, setSendAssetId] = useState('sol')
  const [sendPreview, setSendPreview] = useState<SolTransferPreview | null>(null)
  const [sendResult, setSendResult] = useState<SolTransferResult | null>(null)
  const [sendError, setSendError] = useState('')
  const [sendBusy, setSendBusy] = useState(false)
  const [sendPreviewLoading, setSendPreviewLoading] = useState(false)
  const [uncoveredAck, setUncoveredAck] = useState(false)
  const [highRiskAck, setHighRiskAck] = useState(false)
  const [nowMs, setNowMs] = useState(Date.now())
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null)
  const [claimEligibility, setClaimEligibility] = useState<ClaimEligibilityResponse | null>(null)
  const [claimResult, setClaimResult] = useState<WalletClaimResponse | null>(null)
  const [claimAmountUsd, setClaimAmountUsd] = useState('')
  const [claimStatement, setClaimStatement] = useState('')
  const [claimBusy, setClaimBusy] = useState(false)
  const [claimError, setClaimError] = useState('')
  const [copiedActivityId, setCopiedActivityId] = useState<string | null>(null)
  const [backupPassword, setBackupPassword] = useState('')
  const [backupPasswordVisible, setBackupPasswordVisible] = useState(false)
  const [backupBlob, setBackupBlob] = useState('')
  const [backupFileName, setBackupFileName] = useState('')
  const [backupConfirm, setBackupConfirm] = useState('')
  const [resetConfirm, setResetConfirm] = useState('')
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupError, setBackupError] = useState('')
  const [backupNotice, setBackupNotice] = useState('')
  const tokenBalances = arrayOrEmpty(snapshot?.tokenBalances)
  const emberActivity = arrayOrEmpty(snapshot?.emberActivity)
  const activity = arrayOrEmpty(snapshot?.activity)
  const recipientTrimmed = sendRecipient.trim()
  const recipientValid = recipientTrimmed ? isValidSolanaAddress(recipientTrimmed) : false
  const recipientIsSelf = !!address && recipientTrimmed === address
  const recipientError = recipientTrimmed && !recipientValid ? 'Enter a valid Solana address.' : ''
  const selectedToken = tokenBalances.find((token) => token.tokenAccount === sendAssetId)
  const sendAsset: WalletTransferAsset = selectedToken
    ? {
        kind: 'token',
        symbol: selectedToken.symbol,
        name: selectedToken.name,
        trusted: selectedToken.trusted,
        mint: selectedToken.mint,
        tokenAccount: selectedToken.tokenAccount,
        programId: selectedToken.programId,
        decimals: selectedToken.decimals,
        rawBalance: selectedToken.rawAmount,
      }
    : { kind: 'sol', symbol: 'SOL' }
  const selfSendError = recipientIsSelf ? `You cannot send ${sendAsset.symbol} to this wallet.` : ''
  const sendAmountError = amountValidation(sendAmount, snapshot, sendAsset)
  const paymentStatusView = coveragePaymentStatusView({
    cluster,
    coverEnrolled,
    coverStatusLoading,
    coverStatusSnapshot,
    nowMs,
    paymentState,
  })

  async function refresh() {
    if (!(await vault.hasVault())) {
      setAddress(null)
      setView('create')
      return
    }
    const currentAddress = await vault.getAddress()
    setAddress(currentAddress)
    // Approval mode bypasses the standalone unlock view ONLY while a request is pending: the
    // approval screen carries its own inline unlock so the cover banner and password coexist on
    // one screen while locked. With no pending request the window is a plain wallet and must
    // respect the lock state (otherwise locking it would still show an unlocked-looking home).
    if (mode === 'approval' && (await approval.get())) {
      setView('account')
      return
    }
    if (await vault.isUnlocked()) {
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
      const session = await cover.sessionStatus()
      const enrolled = session.phase === 'active'
      setCoverSession(session)
      setCoverEnrolled(enrolled)
      if (enrolled) {
        const [status, lifecycle] = await Promise.all([
          cover.status(),
          cover.lifecycle(),
        ])
        setCoverStatusSnapshot(status)
        setCoverLifecycle(lifecycle)
      } else {
        setCoverStatusSnapshot(null)
        setCoverLifecycle(null)
      }
    } catch {
      setCoverSession(null)
      setCoverEnrolled(false)
      setCoverStatusSnapshot(null)
      setCoverLifecycle(null)
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
    setSendAssetId('sol')
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
    setTermsAccepted(false)
    if (coverEnrolled) {
      void loadCoverageOffers()
    }
  }

  function resetRecoveryForm() {
    setBackupPassword('')
    setBackupBlob('')
    setBackupFileName('')
    setBackupConfirm('')
    setResetConfirm('')
    setBackupError('')
    setBackupNotice('')
  }

  function openSettings() {
    resetRecoveryForm()
    setAccountScreen('settings')
  }

  async function readBackupFile(file: File | undefined) {
    setBackupError('')
    setBackupNotice('')
    setBackupBlob('')
    setBackupFileName('')
    if (!file) {
      return
    }
    if (file.size > 64 * 1024) {
      setBackupError('Backup file is too large.')
      return
    }
    try {
      setBackupBlob(await file.text())
      setBackupFileName(file.name)
    } catch {
      setBackupError('Could not read the selected backup file.')
    }
  }

  async function exportEncryptedBackup() {
    if (!backupPassword) {
      setBackupError('Enter your wallet password to export the backup.')
      return
    }
    setBackupBusy(true)
    setBackupError('')
    setBackupNotice('')
    try {
      const encryptedBackup = await vault.exportBackup(backupPassword)
      const url = URL.createObjectURL(
        new Blob([encryptedBackup], { type: 'application/json' }),
      )
      const link = document.createElement('a')
      link.href = url
      link.download = `ember-wallet-${address?.slice(-8) ?? 'backup'}.json`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1_000)
      setBackupPassword('')
      setBackupNotice('Encrypted backup downloaded. Store it separately from its password.')
    } catch (e) {
      const message = errorMessage(e, 'Could not export the encrypted backup.')
      setBackupError(
        message.toLowerCase().includes('locked out')
          ? 'Too many failed password attempts. Wait one minute and try again.'
          : message.toLowerCase().includes('no vault')
            ? 'No wallet is available to back up.'
            : 'Wrong password. No backup was exported.',
      )
    } finally {
      setBackupBusy(false)
    }
  }

  async function importEncryptedBackup() {
    const replacePhrase = address ? `REPLACE ${address.slice(-4)}` : ''
    if (!backupBlob) {
      setBackupError('Select an Ember encrypted backup file.')
      return
    }
    if (!backupPassword) {
      setBackupError('Enter the password that encrypts this backup.')
      return
    }
    if (replacePhrase && backupConfirm !== replacePhrase) {
      setBackupError(`Type ${replacePhrase} to replace this wallet.`)
      return
    }
    setBackupBusy(true)
    setBackupError('')
    setBackupNotice('')
    try {
      const importedAddress = await vault.importBackup(backupBlob, backupPassword)
      await vault.unlock(backupPassword)
      setAddress(importedAddress)
      setCluster(DEFAULT_WALLET_CLUSTER)
      setSnapshot(null)
      setMainTab('assets')
      setAccountScreen('home')
      setView('account')
      resetRecoveryForm()
      await refreshWalletData(importedAddress)
      await refreshCoverState()
    } catch (e) {
      setBackupError(errorMessage(e, 'Could not import the encrypted backup.'))
    } finally {
      setBackupBusy(false)
    }
  }

  async function resetWallet() {
    const phrase = address ? `RESET ${address.slice(-4)}` : 'RESET'
    if (resetConfirm !== phrase) {
      setBackupError(`Type ${phrase} to permanently reset this wallet.`)
      return
    }
    setBackupBusy(true)
    setBackupError('')
    setBackupNotice('')
    try {
      await vault.resetVault()
      setAddress(null)
      setSnapshot(null)
      setCoverEnrolled(null)
      setCoverStatusSnapshot(null)
      setPaymentState(null)
      setCluster(DEFAULT_WALLET_CLUSTER)
      setPassword('')
      resetRecoveryForm()
      setView('create')
    } catch (e) {
      setBackupError(errorMessage(e, 'Could not reset this wallet.'))
    } finally {
      setBackupBusy(false)
    }
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
    const message = paymentErrorMessage(e, fallback)
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

  async function connectEmberSession() {
    setPaymentBusy(true)
    setPaymentError('')
    setPaymentNotice('')
    if (!(await ensurePaymentUnlocked())) {
      setPaymentBusy(false)
      return
    }
    try {
      if (!(await cover.enroll())) {
        throw new Error('The Ember session challenge was not completed')
      }
      await refreshCoverState()
      await loadCoverageOffers()
      setPaymentNotice('Ember session connected. No wallet spending permission was granted.')
    } catch (e) {
      handlePaymentError(e, 'Could not connect the Ember session')
    } finally {
      setPaymentBusy(false)
    }
  }

  async function disconnectEmberSession() {
    setPaymentBusy(true)
    setPaymentError('')
    try {
      await cover.revoke()
      setCoverageOffers([])
      setSelectedOfferId('')
      setTermsAccepted(false)
      await refreshCoverState()
      setPaymentNotice('Ember session revoked. Existing server records were not deleted.')
    } catch (e) {
      setPaymentError(errorMessage(e, 'Could not revoke the Ember session'))
    } finally {
      setPaymentBusy(false)
    }
  }

  async function loadCoverageOffers() {
    setPaymentError('')
    try {
      const offers = await payments.offers()
      setCoverageOffers(offers)
      setSelectedOfferId((current) =>
        offers.some((offer) => offer.offerId === current)
          ? current
          : (offers[0]?.offerId ?? ''),
      )
    } catch (e) {
      setCoverageOffers([])
      setPaymentError(errorMessage(e, 'Could not load authoritative Ember offers'))
    }
  }

  async function previewCoverPayment() {
    setPaymentBusy(true)
    setPaymentError('')
    setPaymentNotice('')
    setPaymentPreview(null)
    setPaymentResult(null)
    try {
      if (!selectedOfferId) throw new Error('Select an Ember offer')
      setPaymentPreview(
        await payments.previewPayment({
          acceptedTerms: termsAccepted,
          cluster,
          offerId: selectedOfferId,
        }),
      )
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
      if (!paymentPreview) throw new Error('Review a current quote before paying')
      const result = await payments.activatePayment(paymentPreview.quoteId)
      setPaymentResult(result)
      setPaymentState(result.state)
      if (result.coverActive) {
        setPaymentNotice('Payment confirmed and Ember Cover is active.')
      } else {
        setPaymentNotice('Signed payment saved. Retry verification without signing again.')
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
      if (result.coverActive) {
        setPaymentNotice('Cover activation completed. No second payment was made.')
      } else {
        setPaymentNotice(
          paymentErrorMessage(
            result.state.lastError,
            'Payment verification or coverage activation is still pending.',
          ),
        )
      }
    } catch (e) {
      handlePaymentError(e, 'Could not retry payment activation')
    } finally {
      setPaymentBusy(false)
    }
  }

  async function checkClaimEligibility(decisionId: string) {
    setClaimBusy(true)
    setClaimError('')
    setClaimResult(null)
    try {
      setClaimEligibility(await cover.claimEligibility(decisionId))
    } catch (e) {
      setClaimEligibility(null)
      setClaimError(errorMessage(e, 'Could not verify claim eligibility'))
    } finally {
      setClaimBusy(false)
    }
  }

  async function submitDirectLossClaim(decisionId: string) {
    setClaimBusy(true)
    setClaimError('')
    try {
      if (!claimEligibility?.eligible || claimEligibility.decisionId !== decisionId) {
        throw new Error('Refresh claim eligibility before submitting')
      }
      if (claimStatement.trim().length < 20) {
        throw new Error('Describe what happened in at least 20 characters')
      }
      const claim = await cover.createClaim({
        claimedAmountMicros: usdToMicros(claimAmountUsd),
        decisionId,
        lossEvent: 'direct_malicious_signing_loss',
        statement: claimStatement.trim(),
      })
      setClaimResult(claim)
      setClaimEligibility(null)
      await refreshCoverState()
    } catch (e) {
      setClaimError(errorMessage(e, 'Could not submit the claim'))
    } finally {
      setClaimBusy(false)
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
      setSendPreview(
        await transfers.previewTransfer({
          amount: sendAmount,
          asset: sendAsset,
          cluster,
          destination: recipientTrimmed,
        }),
      )
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
      const result = await transfers.sendTransfer({
        amount: sendAmount,
        asset: sendAsset,
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
      setSendError(errorMessage(e, `Could not send ${sendAsset.symbol}`))
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
        <button
          className="ec-quiet-button"
          data-testid="wallet-settings"
          onClick={openSettings}
          type="button"
        >
          Backup
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
        : paymentStatusView.primaryAction === 'connect'
          ? 'Connect Ember'
        : paymentStatusView.primaryAction === 'sync'
          ? 'Retry activation'
          : paymentStatusView.primaryAction === 'refresh'
            ? 'Check cover'
          : 'Activate cover'
    const actionTestId =
      paymentStatusView.primaryAction === 'manage'
        ? 'manage-cover'
        : paymentStatusView.primaryAction === 'refresh'
          ? 'refresh-cover-status'
          : 'activate-cover'
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
            onClick={
              paymentStatusView.primaryAction === 'refresh'
                ? () => void refreshCoverState()
                : openCoverActivation
            }
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
                  <span className="ec-token-avatar" aria-hidden="true">{tokenInitial(token.iconText, token.mint)}</span>
                  <span className="ec-token-main">
                    <span className="ec-token-name">{token.name} · {token.symbol}</span>
                    <span className="ec-token-mint">
                      {shortAddress(token.mint)} · {token.trusted ? 'Verified by Ember' : 'Unverified token'}
                    </span>
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
    const selectedOffer = coverageOffers.find((offer) => offer.offerId === selectedOfferId)
    const canStartPayment =
      coverEnrolled === true && paymentStatusView.primaryAction === 'activate'
    const canPay =
      canStartPayment &&
      !!paymentPreview &&
      paymentPreview.errors.length === 0 &&
      paymentPreview.simulation.status === 'success' &&
      !paymentBusy
    const canRetry =
      paymentStatusView.primaryAction === 'sync' &&
      !!paymentState?.paymentSignature &&
      !paymentBusy
    return (
      <section className="ec-task-screen" data-testid="cover-activation">
        <div className="ec-screen-head">
          {renderBackButton(() => setAccountScreen(approvalPending ? 'approval' : 'home'))}
          <div>
            <span className="ec-control-label">Server-authoritative coverage</span>
            <h2>Activate Ember Cover</h2>
          </div>
        </div>
        <p className="ec-help" data-testid="payment-copy">
          Ember supplies the offer, terms, price, treasury, and expiry. The wallet verifies a
          signed quote and the {EMBER_CONFIG.expectedCluster === 'devnet' ? 'Solana Devnet' : 'Solana Mainnet'} identity before it can prepare a one-off token
          transfer. This is not a subscription or token spending approval.
        </p>
        {EMBER_CONFIG.environment === 'sandbox' ? (
          <p className="ec-warning" data-testid="devnet-qa-warning">
            Devnet QA only. This exercises synthetic claims, refund accounting, and Devnet USDC
            payouts—without creating insurance or real-world liability.
          </p>
        ) : null}
        <section className="ec-review-card" data-testid="ember-session-state">
          <h3>Ember session</h3>
          <p>
            {coverSession?.phase === 'active'
              ? `Connected until ${coverSession.expiresAt ?? 'unknown'}`
              : coverSession?.phase === 'configuration_required'
                ? coverSession.problems.join('; ')
                : 'Not connected'}
          </p>
          <p className="ec-help">
            The wallet signs one ownership challenge. A short-lived API-only key handles later
            requests and cannot move funds.
          </p>
          {coverEnrolled ? (
            <button
              className="ec-secondary"
              disabled={paymentBusy}
              onClick={() => void disconnectEmberSession()}
              type="button"
            >
              Revoke session
            </button>
          ) : (
            <button
              className="ec-primary"
              data-testid="connect-ember-session"
              disabled={paymentBusy || coverSession?.phase === 'configuration_required'}
              onClick={() => void connectEmberSession()}
              type="button"
            >
              {paymentBusy ? 'Connecting...' : 'Connect Ember'}
            </button>
          )}
        </section>
        {coverLifecycle ? (
          <section className="ec-review-card" data-testid="ember-lifecycle-authority">
            <h3>Ember records</h3>
            <p>
              Authority: {coverLifecycle.authority}
              {coverLifecycle.error ? ` · ${coverLifecycle.error}` : ''}
            </p>
            {coverLifecycle.claims.length > 0 ? (
              <ul>
                {coverLifecycle.claims.map((claim) => (
                  <li key={claim.claimId}>
                    Claim {shortAddress(claim.claimId)} · {claim.state}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ec-help">No claims are recorded for this Ember wallet subject.</p>
            )}
          </section>
        ) : null}
        {coverEnrolled ? (
          <section className="ec-review-card" data-testid="coverage-offer">
            <h3>Current offer</h3>
            {coverageOffers.length > 0 ? (
              <>
                <label>
                  Offer
                  <select
                    data-testid="coverage-offer-select"
                    onChange={(event) => {
                      setSelectedOfferId(event.currentTarget.value)
                      setTermsAccepted(false)
                      setPaymentPreview(null)
                    }}
                    value={selectedOfferId}
                  >
                    {coverageOffers.map((offer) => (
                      <option key={offer.offerId} value={offer.offerId}>
                        {offer.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedOffer ? (
                  <dl className="ec-data-list">
                    <div>
                      <dt>Price</dt>
                      <dd>
                        {formatBaseUnits(
                          selectedOffer.priceBaseUnits,
                          selectedOffer.paymentAssetDecimals,
                        )}{' '}
                        {selectedOffer.paymentAsset}
                      </dd>
                    </div>
                    <div>
                      <dt>Duration</dt>
                      <dd>
                        {selectedOffer.coverageDurationMonths} months /{' '}
                        {selectedOffer.benefitPeriodCount} activation-anchored periods
                      </dd>
                    </div>
                    <div>
                      <dt>Benefit per period</dt>
                      <dd>{formatUsdMicros(selectedOffer.benefitPeriodLimitMicros)}</dd>
                    </div>
                    <div>
                      <dt>Annual maximum</dt>
                      <dd>{formatUsdMicros(selectedOffer.aggregateLimitMicros)}</dd>
                    </div>
                    <div>
                      <dt>Transaction checks</dt>
                      <dd>{selectedOffer.coveredTransactionLimit}</dd>
                    </div>
                    <div>
                      <dt>Waiting period</dt>
                      <dd>{selectedOffer.waitingPeriodDays} days</dd>
                    </div>
                    <div>
                      <dt>Terms version</dt>
                      <dd>{selectedOffer.termsVersion}</dd>
                    </div>
                    <div>
                      <dt>Terms SHA-256</dt>
                      <dd title={selectedOffer.termsSha256}>
                        {shortAddress(selectedOffer.termsSha256)}
                      </dd>
                    </div>
                  </dl>
                ) : null}
                <label>
                  <input
                    checked={termsAccepted}
                    data-testid="accept-coverage-terms"
                    onChange={(event) => {
                      setTermsAccepted(event.currentTarget.checked)
                      setPaymentPreview(null)
                    }}
                    type="checkbox"
                  />{' '}
                  I accept this exact offer version and terms hash.
                </label>
              </>
            ) : (
              <button
                className="ec-secondary"
                disabled={paymentBusy}
                onClick={() => void loadCoverageOffers()}
                type="button"
              >
                Load current offers
              </button>
            )}
          </section>
        ) : null}
        {paymentState ? (
          <section className="ec-review-card" data-testid="local-payment-state">
            <h3>Local recovery record</h3>
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
                <dt>Quote</dt>
                <dd>{shortAddress(paymentState.quote.payload.quoteId)}</dd>
              </div>
              <div>
                <dt>Cover ends</dt>
                <dd>{paymentState.coverageEndsAt ?? 'Not server-confirmed'}</dd>
              </div>
            </dl>
            {paymentState.lastError ? <p>{paymentState.lastError}</p> : null}
          </section>
        ) : null}
        {paymentPreview ? (
          <section className="ec-review-card" data-testid="payment-review">
            <h3>Verified quote and simulated payment</h3>
            <dl className="ec-data-list">
              <div>
                <dt>Offer</dt>
                <dd>{paymentPreview.offerId} v{paymentPreview.offerVersion}</dd>
              </div>
              <div>
                <dt>Amount</dt>
                <dd>{paymentPreview.amountDisplay} {paymentPreview.asset}</dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>
                  {paymentPreview.durationMonths} months /{' '}
                  {paymentPreview.benefitPeriodCount} activation-anchored periods
                </dd>
              </div>
              <div>
                <dt>Benefit per period</dt>
                <dd>{formatUsdMicros(paymentPreview.benefitPeriodLimitMicros)}</dd>
              </div>
              <div>
                <dt>Network</dt>
                <dd>{clusterLabel(paymentPreview.cluster)}</dd>
              </div>
              <div>
                <dt>Protected and payer wallet</dt>
                <dd title={paymentPreview.walletAddress}>{shortAddress(paymentPreview.walletAddress)}</dd>
              </div>
              <div>
                <dt>Treasury token account</dt>
                <dd title={paymentPreview.treasuryTokenAccount}>
                  {shortAddress(paymentPreview.treasuryTokenAccount)}
                </dd>
              </div>
              <div>
                <dt>Payment mint</dt>
                <dd title={paymentPreview.tokenMint}>{shortAddress(paymentPreview.tokenMint)}</dd>
              </div>
              <div>
                <dt>Quote reference</dt>
                <dd title={paymentPreview.quoteReference}>
                  {shortAddress(paymentPreview.quoteReference)}
                </dd>
              </div>
              <div>
                <dt>Quote expires</dt>
                <dd>{paymentPreview.quoteExpiresAt}</dd>
              </div>
              <div>
                <dt>Estimated network fee</dt>
                <dd>{paymentPreview.feeLamports} lamports</dd>
              </div>
            </dl>
            <p data-testid="payment-balances">
              Token base units {paymentPreview.tokenBalanceBaseUnits} · SOL{' '}
              {formatLamportsAsSol(BigInt(paymentPreview.solBalanceLamports))}
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
            <h3>{paymentResult.coverActive ? 'Cover active' : 'Activation pending'}</h3>
            {paymentResult.explorerUrl && paymentResult.state.paymentSignature ? (
              <p>
                <a href={paymentResult.explorerUrl} rel="noreferrer" target="_blank">
                  {shortAddress(paymentResult.state.paymentSignature)}
                </a>
              </p>
            ) : null}
            {!paymentResult.coverActive ? (
              <p>Your signed payment is saved. Recover it; do not sign another payment.</p>
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
          {!coverEnrolled ? null : canRetry ? (
            <button
              className="ec-primary"
              data-testid="retry-payment-activation"
              disabled={paymentBusy}
              onClick={() => void syncCoverPayment()}
            >
              {paymentBusy ? 'Retrying...' : 'Retry activation'}
            </button>
          ) : paymentStatusView.primaryAction === 'refresh' ? (
            <button
              className="ec-secondary"
              data-testid="refresh-cover-status"
              disabled={coverStatusLoading}
              onClick={() => void refreshCoverState()}
            >
              {coverStatusLoading ? 'Checking...' : 'Check cover status'}
            </button>
          ) : !canStartPayment ? (
            <button
              className="ec-secondary"
              onClick={() => setAccountScreen(approvalPending ? 'approval' : 'home')}
            >
              Done
            </button>
          ) : !paymentPreview ? (
            <button
              className="ec-primary"
              data-testid="review-cover-payment"
              disabled={paymentBusy || !selectedOfferId || !termsAccepted}
              onClick={() => void previewCoverPayment()}
            >
              {paymentBusy ? 'Checking...' : 'Accept terms and verify quote'}
            </button>
          ) : (
            <button
              className="ec-primary"
              data-testid="pay-and-activate-cover"
              disabled={!canPay}
              onClick={() => void activateCoverPayment()}
            >
              {paymentBusy
                ? 'Submitting...'
                : `Pay ${paymentPreview.amountDisplay} ${paymentPreview.asset} and activate cover`}
            </button>
          )}
        </div>
      </section>
    )
  }

  function renderRecoveryTools(includeExport: boolean) {
    const replacePhrase = address ? `REPLACE ${address.slice(-4)}` : ''
    const resetPhrase = address ? `RESET ${address.slice(-4)}` : 'RESET'
    return (
      <div className="ec-recovery-tools">
        <section className="ec-review-card ec-recovery-intro">
          <h3>Recovery limits</h3>
          <p className="ec-help">
            Ember backups are encrypted with your wallet password. A backup cannot recover a
            forgotten backup password. Reset creates a different wallet and cannot recover funds
            from the old address.
          </p>
          {address ? <p className="ec-account">{address}</p> : null}
        </section>

        <label>
          Wallet or backup password
          <span className="ec-password-field">
            <input
              autoComplete="current-password"
              data-testid="backup-password"
              onChange={(event) => setBackupPassword(event.currentTarget.value)}
              type={backupPasswordVisible ? 'text' : 'password'}
              value={backupPassword}
            />
            <button
              aria-label={backupPasswordVisible ? 'Hide backup password' : 'Show backup password'}
              className="ec-password-toggle"
              onClick={() => setBackupPasswordVisible((visible) => !visible)}
              type="button"
            >
              {backupPasswordVisible ? 'Hide' : 'Show'}
            </button>
          </span>
        </label>

        {includeExport ? (
          <section className="ec-review-card">
            <h3>Export encrypted backup</h3>
            <p className="ec-help">
              Download the encrypted wallet key. Keep the file and password in separate secure
              places.
            </p>
            <button
              className="ec-secondary"
              data-testid="export-backup"
              disabled={backupBusy}
              onClick={() => void exportEncryptedBackup()}
              type="button"
            >
              {backupBusy ? 'Working...' : 'Download encrypted backup'}
            </button>
          </section>
        ) : null}

        <section className="ec-review-card">
          <h3>Import encrypted backup</h3>
          <p className="ec-help">
            The file is validated and decrypted before the current wallet is replaced.
          </p>
          <label className="ec-file-picker">
            Backup file
            <input
              accept="application/json,.json"
              data-testid="backup-file"
              onChange={(event) => void readBackupFile(event.currentTarget.files?.[0])}
              type="file"
            />
          </label>
          {backupFileName ? <p className="ec-help">Selected: {backupFileName}</p> : null}
          {replacePhrase ? (
            <label>
              Confirm replacement
              <input
                autoComplete="off"
                data-testid="backup-replace-confirm"
                onChange={(event) => setBackupConfirm(event.currentTarget.value)}
                placeholder={replacePhrase}
                value={backupConfirm}
              />
            </label>
          ) : null}
          <button
            className="ec-primary"
            data-testid="import-backup"
            disabled={backupBusy || !backupBlob}
            onClick={() => void importEncryptedBackup()}
            type="button"
          >
            {backupBusy ? 'Validating...' : address ? 'Validate and replace wallet' : 'Import wallet'}
          </button>
        </section>

        {address ? (
          <section className="ec-review-card ec-danger-zone">
            <h3>Reset wallet</h3>
            <p className="ec-help">
              This permanently removes the encrypted key, cover session, saved payment, activity
              records, and connected sites from this browser.
            </p>
            <label>
              Type {resetPhrase}
              <input
                autoComplete="off"
                data-testid="reset-confirm"
                onChange={(event) => setResetConfirm(event.currentTarget.value)}
                placeholder={resetPhrase}
                value={resetConfirm}
              />
            </label>
            <button
              className="ec-danger-button"
              data-testid="reset-wallet"
              disabled={backupBusy}
              onClick={() => void resetWallet()}
              type="button"
            >
              Permanently reset wallet
            </button>
          </section>
        ) : null}

        {backupNotice ? <p data-testid="backup-notice">{backupNotice}</p> : null}
        {backupError ? <p data-testid="backup-error">{backupError}</p> : null}
      </div>
    )
  }

  function renderSettings() {
    return (
      <section className="ec-task-screen" data-testid="wallet-settings-screen">
        <div className="ec-screen-head">
          {renderBackButton(() => setAccountScreen('home'))}
          <div>
            <span className="ec-control-label">Wallet safety</span>
            <h2>Backup and recovery</h2>
          </div>
        </div>
        {renderRecoveryTools(true)}
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
    if (coverStatusSnapshot && coverStatusActive(coverStatusSnapshot, nowMs)) {
      return (
        <section className="ec-inline-cover" data-tone="covered" data-testid="send-cover-status">
          <span>Protected</span>
          <p>{formatCoverStatusSnapshot(coverStatusSnapshot)}</p>
        </section>
      )
    }
    const needsSync = paymentStatusView.primaryAction === 'sync'
    const needsRefresh = paymentStatusView.primaryAction === 'refresh'
    return (
      <section
        className="ec-inline-cover"
        data-tone={needsSync || needsRefresh ? 'unavailable' : 'none'}
        data-testid="send-cover-status"
      >
        <span>{needsSync || needsRefresh ? 'Cover status unavailable' : 'Cover is not active'}</span>
        <p>{paymentStatusView.detail}</p>
        <button
          className="ec-secondary"
          onClick={needsRefresh ? () => void refreshCoverState() : openCoverActivation}
          type="button"
        >
          {needsRefresh ? 'Check cover' : needsSync ? 'Retry activation' : 'Activate cover'}
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
              <h2>Send submitted</h2>
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
                  <dd>{sendPreview.amount} {sendPreview.asset.symbol}</dd>
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
                {sendPreview.asset.kind === 'token' ? (
                  <>
                    <div>
                      <dt>Token mint</dt>
                      <dd title={sendPreview.asset.mint}>{shortAddress(sendPreview.asset.mint)}</dd>
                    </div>
                    <div>
                      <dt>Token program</dt>
                      <dd>
                        {sendPreview.asset.programId === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
                          ? 'Token-2022'
                          : 'SPL Token'}
                      </dd>
                    </div>
                    <div>
                      <dt>Recipient token account</dt>
                      <dd title={sendPreview.destinationTokenAccount ?? undefined}>
                        {shortAddress(sendPreview.destinationTokenAccount)}
                      </dd>
                    </div>
                    <div>
                      <dt>Account creation</dt>
                      <dd>
                        {sendPreview.createsDestinationTokenAccount
                          ? `${sendPreview.accountRentSol} SOL estimated rent`
                          : 'Existing account'}
                      </dd>
                    </div>
                    <div>
                      <dt>Token identity</dt>
                      <dd>{sendPreview.asset.trusted ? 'Verified by Ember' : 'Unverified — verify the mint address'}</dd>
                    </div>
                  </>
                ) : null}
                <div>
                  <dt>Network</dt>
                  <dd>{cluster === 'mainnet-beta' ? 'Mainnet' : 'Devnet'}</dd>
                </div>
                <div>
                  <dt>{sendPreview.asset.kind === 'sol' ? 'Total debit' : 'SOL fee and rent'}</dt>
                  <dd>{sendPreview.totalDebitSol} SOL</dd>
                </div>
                <div>
                  <dt>Balance after</dt>
                  <dd>{sendPreview.balanceAfterSol} SOL</dd>
                </div>
                {sendPreview.asset.kind === 'token' ? (
                  <div>
                    <dt>{sendPreview.asset.symbol} after</dt>
                    <dd>{sendPreview.tokenBalanceAfter}</dd>
                  </div>
                ) : null}
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
                <p data-testid="send-simulation-error">
                  Simulation failed: {sendPreview.simulation.error ?? 'unknown runtime error'}. The
                  transaction was not signed or sent.
                </p>
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
            <h2>Send</h2>
          </div>
        </div>
        <label>
          Asset
          <select
            data-testid="send-asset-select"
            onChange={(event) => {
              setSendAssetId(event.currentTarget.value)
              setSendAmount('')
              setSendPreview(null)
              setSendError('')
            }}
            value={sendAssetId}
          >
            <option value="sol">SOL — {snapshot?.solBalance ?? 'unavailable'}</option>
            {tokenBalances.map((token) => (
              <option key={token.tokenAccount} value={token.tokenAccount}>
                {token.trusted ? token.symbol : `Unknown ${shortAddress(token.mint)}`} — {token.uiAmount}
              </option>
            ))}
          </select>
        </label>
        {sendAsset.kind === 'token' ? (
          <p className="ec-help" data-testid="send-token-identity">
            {sendAsset.trusted ? `${sendAsset.name ?? sendAsset.symbol} · Verified by Ember` : 'Unverified token'} ·
            {' '}Mint {shortAddress(sendAsset.mint)} ·{' '}
            {sendAsset.programId === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
              ? 'Token-2022'
              : 'SPL Token'}
          </p>
        ) : null}
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
          <button
            className="ec-quiet-button"
            data-testid="send-max"
            onClick={() => setSendAmount(selectedToken?.uiAmount ?? maxSendableSol(snapshot))}
          >
            Max
          </button>
        </div>
        <p className="ec-help">
          Available{' '}
          {sendAsset.kind === 'sol'
            ? snapshot
              ? `${snapshot.solBalance} SOL`
              : 'unavailable'
            : `${selectedToken?.uiAmount ?? '0'} ${sendAsset.symbol}`}
          {sendAsset.kind === 'token' ? ` · ${snapshot?.solBalance ?? '0'} SOL for fees/rent` : ''}
        </p>
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
    const localOnlyEmber = emberActivity.filter((item) => !item.signature || !onchainSignatures.has(item.signature))
    const settledEmber = localOnlyEmber.filter((item) =>
      item.onchainStatus === 'confirmed' ||
      item.onchainStatus === 'finalized' ||
      item.onchainStatus === 'failed' ||
      item.onchainStatus === 'expired',
    )
    const pendingEmber = localOnlyEmber.filter((item) => !settledEmber.includes(item))
    const renderLocalActivityRow = (item: (typeof emberActivity)[number]) => (
      <li className="ec-activity-row" key={item.id} data-testid="ember-activity-item">
        <button
          className="ec-activity-row__button"
          onClick={() => {
            setSelectedActivityId(item.id)
            setClaimEligibility(null)
            setClaimResult(null)
            setClaimError('')
            setClaimAmountUsd('')
            setClaimStatement('')
            setAccountScreen('activity-detail')
          }}
          type="button"
        >
          <span
            className="ec-activity-avatar"
            data-direction={
              item.onchainStatus === 'failed' || item.onchainStatus === 'expired'
                ? 'failed'
                : item.onchainStatus === 'confirmed' || item.onchainStatus === 'finalized'
                  ? 'sent'
                  : 'pending'
            }
            aria-hidden="true"
          >
            {item.onchainStatus === 'confirmed' || item.onchainStatus === 'finalized' ? '✓' : item.onchainStatus === 'failed' || item.onchainStatus === 'expired' ? '!' : '…'}
          </span>
          <span className="ec-activity-main">
            <span className="ec-activity-title">{item.title ?? 'Signed transaction'}</span>
            <span className="ec-activity-meta">
              {walletTransactionStatusLabel(item.onchainStatus)}
              {item.recipient ? ` · to ${shortAddress(item.recipient)}` : ''}
            </span>
          </span>
          <span className="ec-activity-side">
            {item.amount ? <span className="ec-activity-amount">{item.amount}</span> : null}
            <span className="ec-activity-meta">{new Date(item.timestamp).toLocaleDateString()}</span>
            <span className="ec-cover-pill" data-tone={coverTone(item.coverStatus)}>{coverStatusLabel(item.coverStatus)}</span>
          </span>
          <span className="ec-activity-chevron" aria-hidden="true">›</span>
        </button>
      </li>
    )
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
                  <button
                    className="ec-activity-row__button"
                    onClick={() => {
                      setSelectedActivityId(tx.signature)
                      setClaimEligibility(null)
                      setClaimResult(null)
                      setClaimError('')
                      setClaimAmountUsd('')
                      setClaimStatement('')
                      setAccountScreen('activity-detail')
                    }}
                    type="button"
                  >
                    <span className="ec-activity-avatar" data-direction={tx.direction} aria-hidden="true">
                      {tx.direction === 'received' ? '↓' : tx.direction === 'sent' ? '↑' : '•'}
                    </span>
                    <span className="ec-activity-main">
                      <span className="ec-activity-title">{emberRecord?.title ?? tx.title}</span>
                      <span className="ec-activity-meta">
                        {activityState(tx.failed, tx.confirmationStatus)}
                        {counterparty ? ` · ${tx.direction === 'received' ? 'from' : 'to'} ${shortAddress(counterparty)}` : ''}
                      </span>
                    </span>
                    <span className="ec-activity-side">
                      {amount ? <span className="ec-activity-amount">{amount}</span> : null}
                      <span className="ec-activity-meta">{activityDate(tx.blockTime)}</span>
                      {coverStatus !== 'unknown' ? (
                        <span className="ec-cover-pill" data-tone={coverTone(coverStatus)}>{coverStatusLabel(coverStatus)}</span>
                      ) : null}
                    </span>
                    <span className="ec-activity-chevron" aria-hidden="true">›</span>
                  </button>
                </li>
              )
            })}
          </ul>
        ) : snapshot && settledEmber.length === 0 && !walletDataLoading && !snapshot.activityUnavailable ? (
          <p>No transactions found.</p>
        ) : null}
        {settledEmber.length > 0 ? (
          <ul className="ec-activity-list" data-testid="settled-ember-activity">
            {settledEmber.map(renderLocalActivityRow)}
          </ul>
        ) : null}
        {snapshot?.emberActivityUnavailable ? <p>Ember activity unavailable.</p> : null}
        {pendingEmber.length > 0 ? (
          <>
            <div className="ec-section-heading">
              <h3>Pending transactions</h3>
              <p className="ec-help">The wallet will keep checking these in the background.</p>
            </div>
            <ul className="ec-activity-list" data-testid="ember-activity">
              {pendingEmber.map(renderLocalActivityRow)}
            </ul>
          </>
        ) : null}
      </section>
    )
  }

  function renderActivityDetail() {
    const tx = activity.find((item) => item.signature === selectedActivityId)
    const emberRecord = emberActivity.find(
      (item) => item.id === selectedActivityId || item.signature === selectedActivityId,
    )
    if (!tx && !emberRecord) {
      return (
        <section className="ec-task-screen" data-testid="activity-detail">
          {renderBackButton(() => setAccountScreen('home'))}
          <p>Transaction details are unavailable.</p>
        </section>
      )
    }
    const signature = tx?.signature ?? emberRecord?.signature ?? null
    const status = tx
      ? activityState(tx.failed, tx.confirmationStatus)
      : walletTransactionStatusLabel(emberRecord?.onchainStatus ?? null)
    const timestamp = tx?.blockTime
      ? new Date(tx.blockTime * 1000)
      : emberRecord?.timestamp
        ? new Date(emberRecord.timestamp)
        : null
    const title = emberRecord?.title ?? tx?.title ?? 'Transaction'
    const amount = emberRecord?.amount ?? tx?.amount
    const counterparty = emberRecord?.recipient ?? tx?.counterparty
    const programs = emberRecord?.programs.length ? emberRecord.programs : tx?.programs ?? []
    const decisionId = emberRecord?.requestId ?? null
    const existingClaim = decisionId
      ? coverLifecycle?.claims.find((claim) => claim.decisionId === decisionId) ?? null
      : null
    return (
      <section className="ec-task-screen ec-activity-detail" data-testid="activity-detail">
        <div className="ec-screen-head">
          {renderBackButton(() => {
            setAccountScreen('home')
            setMainTab('activity')
          })}
          <div>
            <span className="ec-control-label">{clusterLabel(cluster)}</span>
            <h2>{title}</h2>
          </div>
        </div>
        <section
          className="ec-activity-status-card"
          data-tone={
            tx?.failed || emberRecord?.onchainStatus === 'failed' || emberRecord?.onchainStatus === 'expired'
              ? 'failed'
              : tx || emberRecord?.onchainStatus === 'confirmed' || emberRecord?.onchainStatus === 'finalized'
                ? 'confirmed'
                : 'pending'
          }
        >
          <span>{status}</span>
          <p>
            {tx
              ? 'This transaction was found on-chain.'
              : emberRecord?.onchainStatus === 'confirmed' || emberRecord?.onchainStatus === 'finalized'
                ? 'The network has confirmed this transaction. Detailed indexing may still be catching up.'
                : 'The wallet signed this transaction. It may still be awaiting broadcast or RPC indexing.'}
          </p>
        </section>
        {emberRecord?.failureReason ? <p data-testid="activity-failure-reason">{emberRecord.failureReason}</p> : null}
        <dl className="ec-data-list">
          <div>
            <dt>Date</dt>
            <dd>{timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp.toLocaleString() : 'Pending'}</dd>
          </div>
          {amount ? (
            <div>
              <dt>Transaction result</dt>
              <dd>{tx?.direction === 'received' ? '+' : '-'}{amount}</dd>
            </div>
          ) : null}
          {counterparty ? (
            <div>
              <dt>{tx?.direction === 'received' ? 'From' : 'To'}</dt>
              <dd title={counterparty}>{shortAddress(counterparty)}</dd>
            </div>
          ) : null}
          {emberRecord?.source ? (
            <div>
              <dt>Source</dt>
              <dd title={emberRecord.source}>{shortAddress(emberRecord.source)}</dd>
            </div>
          ) : null}
          {emberRecord?.tokenMint ? (
            <div>
              <dt>Token mint</dt>
              <dd title={emberRecord.tokenMint}>{shortAddress(emberRecord.tokenMint)}</dd>
            </div>
          ) : null}
          {tx?.feeLamports ? (
            <div>
              <dt>Network fee</dt>
              <dd>{formatLamportsAsSol(BigInt(tx.feeLamports))} SOL</dd>
            </div>
          ) : null}
          {tx ? (
            <div>
              <dt>Slot</dt>
              <dd>{tx.slot}</dd>
            </div>
          ) : null}
          {emberRecord?.cluster ? (
            <div>
              <dt>Network</dt>
              <dd>{clusterLabel(emberRecord.cluster)}</dd>
            </div>
          ) : null}
          {emberRecord?.lastCheckedAt ? (
            <div>
              <dt>Last checked</dt>
              <dd>{new Date(emberRecord.lastCheckedAt).toLocaleString()}</dd>
            </div>
          ) : null}
          {programs.length > 0 ? (
            <div>
              <dt>Programs</dt>
              <dd>{programs.join(', ')}</dd>
            </div>
          ) : null}
        </dl>
        {emberRecord ? (
          <section className="ec-review-card ec-activity-cover-detail">
            <h3>Ember Cover</h3>
            <dl className="ec-data-list">
              <div>
                <dt>Status</dt>
                <dd><span className="ec-cover-pill" data-tone={coverTone(emberRecord.coverStatus)}>{coverStatusLabel(emberRecord.coverStatus)}</span></dd>
              </div>
              <div>
                <dt>Risk</dt>
                <dd>{emberRecord.riskBand ?? 'Unknown'}</dd>
              </div>
              {emberRecord.dappOrigin ? (
                <div>
                  <dt>Site</dt>
                  <dd>{emberRecord.dappOrigin}</dd>
                </div>
              ) : null}
              {emberRecord.requestId ? (
                <div>
                  <dt>Decision</dt>
                  <dd title={emberRecord.requestId}>{shortAddress(emberRecord.requestId)}</dd>
                </div>
              ) : null}
              <div>
                <dt>Record authority</dt>
                <dd>{coverLifecycle?.authority ?? 'unavailable'}</dd>
              </div>
            </dl>
          </section>
        ) : null}
        {decisionId && emberRecord?.coverStatus === 'covered' ? (
          <section className="ec-review-card" data-testid="activity-claim">
            <h3>Claim</h3>
            <p className="ec-help">
              Claim eligibility and status come from Ember. Submitting a claim starts human review;
              it does not trigger an automatic payout.
            </p>
            {existingClaim ? (
              <dl className="ec-data-list">
                <div>
                  <dt>Claim</dt>
                  <dd title={existingClaim.claimId}>{shortAddress(existingClaim.claimId)}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{existingClaim.state}</dd>
                </div>
                {existingClaim.timeline.at(-1) ? (
                  <div>
                    <dt>Latest update</dt>
                    <dd>{existingClaim.timeline.at(-1)?.status}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Last server version</dt>
                  <dd>{existingClaim.version}</dd>
                </div>
              </dl>
            ) : (
              <>
                {!claimEligibility ? (
                  <button
                    className="ec-secondary"
                    data-testid="check-claim-eligibility"
                    disabled={claimBusy || !coverEnrolled}
                    onClick={() => void checkClaimEligibility(decisionId)}
                    type="button"
                  >
                    {claimBusy ? 'Checking...' : 'Check claim eligibility'}
                  </button>
                ) : (
                  <section>
                    <p data-testid="claim-eligibility">
                      {claimEligibility.eligible
                        ? 'Eligible for claim intake.'
                        : claimEligibility.reason ?? 'Not eligible for claim intake.'}
                    </p>
                    {claimEligibility.directLossDeadline ? (
                      <p className="ec-help">
                        Direct-loss deadline: {claimEligibility.directLossDeadline}
                      </p>
                    ) : null}
                    {claimEligibility.eligible ? (
                      <>
                        <label>
                          Claimed loss in USD
                          <input
                            data-testid="claim-amount"
                            inputMode="decimal"
                            onChange={(event) => setClaimAmountUsd(event.currentTarget.value)}
                            placeholder="0.00"
                            value={claimAmountUsd}
                          />
                        </label>
                        <label>
                          What happened
                          <textarea
                            data-testid="claim-statement"
                            onChange={(event) => setClaimStatement(event.currentTarget.value)}
                            value={claimStatement}
                          />
                        </label>
                        <button
                          className="ec-primary"
                          data-testid="submit-claim"
                          disabled={claimBusy || !claimAmountUsd.trim() || claimStatement.trim().length < 20}
                          onClick={() => void submitDirectLossClaim(decisionId)}
                          type="button"
                        >
                          {claimBusy ? 'Submitting...' : 'Submit claim for review'}
                        </button>
                      </>
                    ) : null}
                  </section>
                )}
              </>
            )}
            {claimResult ? (
              <p data-testid="claim-result">
                Claim {shortAddress(claimResult.claimId)} submitted with status {claimResult.state}.
              </p>
            ) : null}
            {claimError ? <p data-testid="claim-error">{claimError}</p> : null}
          </section>
        ) : null}
        {signature ? (
          <section className="ec-review-card">
            <h3>Transaction ID</h3>
            <p className="ec-account" title={signature}>{shortAddress(signature)}</p>
            <div className="ec-action-pair">
              <button
                className="ec-secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(signature).then(() => {
                    setCopiedActivityId(signature)
                    setTimeout(() => setCopiedActivityId(null), 1500)
                  })
                }}
                type="button"
              >
                {copiedActivityId === signature ? 'Copied' : 'Copy ID'}
              </button>
              {tx?.explorerUrl || emberRecord?.explorerUrl ? (
                <a className="ec-primary ec-button-link" href={tx?.explorerUrl ?? emberRecord?.explorerUrl} rel="noreferrer" target="_blank">
                  Explorer
                </a>
              ) : null}
            </div>
          </section>
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
          {accountScreen === 'settings' ? renderSettings() : null}
          {accountScreen === 'activity-detail' ? renderActivityDetail() : null}
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
  if (view === 'recover') {
    return (
      <div className="ec-auth-shell ec-recovery-shell">
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
        {renderBackButton(() => {
          resetRecoveryForm()
          void refresh()
        })}
        <div>
          <span className="ec-control-label">Wallet safety</span>
          <h1>Restore or reset</h1>
        </div>
        {renderRecoveryTools(false)}
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
      <label>
        Password
        <span className="ec-password-field">
          <input
            autoComplete={view === 'create' ? 'new-password' : 'current-password'}
            data-testid="password"
            onChange={(event) => setPassword(event.target.value)}
            type={passwordVisible ? 'text' : 'password'}
            value={password}
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
      {view === 'create' ? <p className="ec-help">Use at least 8 characters. Any mix is allowed and there is no maximum length.</p> : null}
      <button className="ec-primary" data-testid="submit" onClick={() => void (view === 'create' ? onCreate() : onUnlock())}>
        {authBusy ? (view === 'create' ? 'Creating...' : 'Secure unlocking...') : view === 'create' ? 'Create' : 'Unlock'}
      </button>
      <button
        className="ec-link-button"
        data-testid="open-recovery"
        onClick={() => {
          resetRecoveryForm()
          setView('recover')
        }}
        type="button"
      >
        {view === 'create' ? 'Import encrypted backup' : 'Restore or reset wallet'}
      </button>
      {authBusy ? <p data-testid="auth-busy">{view === 'create' ? 'Creating wallet...' : 'Secure unlocking...'}</p> : null}
      {error ? <p data-testid="error">{error}</p> : null}
    </div>
  )
}
