import { useEffect, useState } from 'react'
import { address as toAddress } from '@solana/kit'

import { getCoverService } from '../../background/cover-service.ts'
import { getWalletTransferService, parseSolAmountToLamports } from '../../background/sol-transfer-service.ts'
import type { SolTransferPreview, SolTransferResult } from '../../background/sol-transfer-service.ts'
import { getVaultService } from '../../background/vault-service.ts'
import { formatLamportsAsSol } from '../../background/wallet-data-service.ts'
import type { WalletDataSnapshot } from '../../background/wallet-data-service.ts'
import { getWalletDataService } from '../../background/wallet-data-service.ts'
import type { WalletCluster } from '../../background/wallet-data-config.ts'
import { WALLET_CLUSTER_OPTIONS } from '../../background/wallet-data-config.ts'
import { coverCapReviewText, formatCoverStatusSnapshot, formatLossCapSnapshot } from '../../cover/cover-cap-view.ts'
import type { CoverStatusSnapshot } from '../../cover/ember-types.ts'
import { QrCode } from './qr-code.tsx'

type View = 'loading' | 'create' | 'unlock' | 'account'
type MainTab = 'assets' | 'activity'
type AccountScreen = 'home' | 'receive' | 'send'
type SendStep = 'form' | 'review' | 'complete'

const BASE_FEE_LAMPORTS = 5_000n

function coverStatusLabel(status: string): string {
  if (status === 'covered') return 'Covered'
  if (status === 'not_covered') return 'Not covered'
  if (status === 'unsupported') return 'Not covered'
  if (status === 'unavailable') return 'Cover unavailable'
  return 'Cover status unknown'
}

function coverAccountStatus(snapshot: CoverStatusSnapshot | null): string {
  if (!snapshot) return 'Ember Cover enabled'
  if (!snapshot.subscriptionActive) return 'Cover subscription inactive'
  if (!snapshot.walletRegistered) return 'Wallet registration incomplete'
  return 'Ember Cover enabled'
}

function arrayOrEmpty<T>(value: T[] | readonly T[] | undefined): T[] | readonly T[] {
  return Array.isArray(value) ? value : []
}

function shortAddress(value: string | null | undefined): string {
  if (!value) return ''
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-8)}` : value
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

export function App() {
  const vault = getVaultService()
  const cover = getCoverService()
  const walletData = getWalletDataService()
  const transfers = getWalletTransferService()
  const [view, setView] = useState<View>('loading')
  const [mainTab, setMainTab] = useState<MainTab>('assets')
  const [accountScreen, setAccountScreen] = useState<AccountScreen>('home')
  const [address, setAddress] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [coverEnrolled, setCoverEnrolled] = useState<boolean | null>(null)
  const [coverStatusSnapshot, setCoverStatusSnapshot] = useState<CoverStatusSnapshot | null>(null)
  const [coverStatusLoading, setCoverStatusLoading] = useState(false)
  const [coverBusy, setCoverBusy] = useState(false)
  const [cluster, setCluster] = useState<WalletCluster>('devnet')
  const [snapshot, setSnapshot] = useState<WalletDataSnapshot | null>(null)
  const [walletDataLoading, setWalletDataLoading] = useState(false)
  const [walletDataError, setWalletDataError] = useState('')
  const [copied, setCopied] = useState(false)
  const [sendStep, setSendStep] = useState<SendStep>('form')
  const [sendRecipient, setSendRecipient] = useState('')
  const [sendAmount, setSendAmount] = useState('')
  const [sendPreview, setSendPreview] = useState<SolTransferPreview | null>(null)
  const [sendResult, setSendResult] = useState<SolTransferResult | null>(null)
  const [sendError, setSendError] = useState('')
  const [sendBusy, setSendBusy] = useState(false)
  const [sendPreviewLoading, setSendPreviewLoading] = useState(false)
  const [uncoveredAck, setUncoveredAck] = useState(false)
  const [highRiskAck, setHighRiskAck] = useState(false)
  const [selectedActivitySignature, setSelectedActivitySignature] = useState<string | null>(null)
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

  async function refresh() {
    if (!(await vault.hasVault())) {
      setView('create')
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

  async function onEnableCover() {
    setError('')
    setCoverBusy(true)
    try {
      const enrolled = await cover.enroll()
      setCoverEnrolled(enrolled)
      if (enrolled) {
        setCoverStatusSnapshot(await cover.status())
        void refreshWalletData()
      }
      if (!enrolled) {
        setError('Could not enable Ember Cover. Check the deployed cover service and try again.')
      }
    } catch (e) {
      setCoverEnrolled(false)
      setError(errorMessage(e, 'Could not enable Ember Cover'))
    } finally {
      setCoverBusy(false)
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
    setSendAmount('')
    setSendPreview(null)
    setSendResult(null)
    setSendError('')
    setUncoveredAck(false)
    setHighRiskAck(false)
  }

  async function loadSendPreview() {
    setSendPreviewLoading(true)
    setSendError('')
    setSendPreview(null)
    setUncoveredAck(false)
    setHighRiskAck(false)
    setNowMs(Date.now())
    try {
      setSendPreview(await transfers.previewSolTransfer({ amountSol: sendAmount, destination: recipientTrimmed }))
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

  function renderTabs() {
    return (
      <div data-testid="main-tabs" style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        <button
          aria-selected={mainTab === 'assets'}
          data-testid="tab-assets"
          onClick={() => {
            setMainTab('assets')
            setAccountScreen('home')
            setSelectedActivitySignature(null)
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
            setSelectedActivitySignature(null)
          }}
        >
          Activity
        </button>
      </div>
    )
  }

  function renderAssets() {
    return (
      <>
        <section data-testid="wallet-balance">
          <h2>Balance</h2>
          <p>{walletDataLoading && !snapshot ? 'Loading balance...' : snapshot ? `${snapshot.solBalance} SOL` : 'Balance unavailable'}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button data-testid="send-sol" onClick={openSend}>
              Send
            </button>
            <button data-testid="receive" onClick={() => setAccountScreen('receive')}>
              Receive
            </button>
            <button data-testid="refresh-wallet-data" disabled={walletDataLoading} onClick={() => void refreshWalletData()}>
              {walletDataLoading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </section>
        <section data-testid="wallet-cover-status">
          <h2>Ember Cover</h2>
          {coverEnrolled ? (
            <div>
              <p data-testid="cover-status">{coverAccountStatus(coverStatusSnapshot)}</p>
              {coverStatusLoading ? <p data-testid="cover-cap-status">Loading cover cap...</p> : null}
              {!coverStatusLoading && coverStatusSnapshot ? (
                <>
                  <p data-testid="cover-cap-status">{formatCoverStatusSnapshot(coverStatusSnapshot)}</p>
                  <p data-testid="cover-loss-cap">{formatLossCapSnapshot(coverStatusSnapshot)}</p>
                </>
              ) : null}
              {!coverStatusLoading && !coverStatusSnapshot ? (
                <p data-testid="cover-cap-status">Cover cap unavailable.</p>
              ) : null}
              <button data-testid="reenable-cover" disabled={coverBusy} onClick={() => void onEnableCover()}>
                {coverBusy ? 'Re-enabling...' : 'Re-enable'}
              </button>
            </div>
          ) : (
            <button data-testid="enable-cover" disabled={coverBusy} onClick={() => void onEnableCover()}>
              {coverBusy ? 'Enabling...' : 'Enable Ember Cover'}
            </button>
          )}
          {error ? <p data-testid="cover-error" style={{ color: '#b91c1c', fontSize: 12 }}>{error}</p> : null}
        </section>
        <section data-testid="wallet-tokens">
          <h2>Tokens</h2>
          {snapshot?.tokenBalancesUnavailable ? <p>Token balances unavailable.</p> : null}
          {snapshot && tokenBalances.length > 0 ? (
            <ul>
              {tokenBalances.map((token) => (
                <li key={token.tokenAccount} data-testid="wallet-token-item">
                  <span>{token.label}</span> <span>{token.uiAmount}</span>{' '}
                  <span>{shortAddress(token.mint)}</span>
                </li>
              ))}
            </ul>
          ) : snapshot && !snapshot.tokenBalancesUnavailable && !walletDataLoading ? (
            <p>No tokens found.</p>
          ) : null}
        </section>
      </>
    )
  }

  function renderReceive() {
    return (
      <section data-testid="receive-screen">
        <button onClick={() => setAccountScreen('home')}>Back</button>
        <h2>Receive</h2>
        <p>Only receive Solana assets on {cluster === 'mainnet-beta' ? 'Mainnet' : 'Devnet'}.</p>
        <p>Ember Cover applies when you sign a transaction, not when someone sends funds to this address.</p>
        {address ? <QrCode value={address} /> : null}
        <p data-testid="receive-address" style={{ overflowWrap: 'anywhere' }}>{address}</p>
        <button data-testid="copy-address" onClick={() => void onCopyAddress()}>
          {copied ? 'Copied' : 'Copy address'}
        </button>
        {'share' in navigator ? (
          <button data-testid="share-address" onClick={() => void onShareAddress()}>
            Share
          </button>
        ) : null}
        <button onClick={() => setAccountScreen('home')}>Done</button>
      </section>
    )
  }

  function renderSend() {
    if (sendStep === 'complete') {
      return (
        <section data-testid="send-complete">
          <h2>Send complete</h2>
          <p>{sendResult?.cover.label ?? 'Submitted'}</p>
          {sendResult ? (
            <p>
              <a href={sendResult.explorerUrl} rel="noreferrer" target="_blank">
                {shortAddress(sendResult.signature)}
              </a>
            </p>
          ) : null}
          <button
            onClick={() => {
              setAccountScreen('home')
              setSendStep('form')
            }}
          >
            Done
          </button>
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
            ? 'Cover cap unavailable.'
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
        <section data-testid="send-review">
          <button onClick={() => setSendStep('form')}>Back</button>
          <h2>Review send</h2>
          {sendPreviewLoading ? <p data-testid="send-preview-loading">Checking send...</p> : null}
          {sendPreview ? (
            <>
              <dl>
                <dt>You send</dt>
                <dd>{sendPreview.amountSol} SOL</dd>
                <dt>From</dt>
                <dd>{shortAddress(sendPreview.source)}</dd>
                <dt>To</dt>
                <dd>{shortAddress(sendPreview.destination)}</dd>
                <dt>Network fee</dt>
                <dd>{sendPreview.feeSol} SOL</dd>
                <dt>Network</dt>
                <dd>{cluster === 'mainnet-beta' ? 'Mainnet' : 'Devnet'}</dd>
                <dt>Total debit</dt>
                <dd>{sendPreview.totalDebitSol} SOL</dd>
                <dt>Balance after</dt>
                <dd>{sendPreview.balanceAfterSol} SOL</dd>
              </dl>
              <section data-testid="send-cover">
                <h3>{sendPreview.cover.label}</h3>
                <p>{sendPreview.cover.body}</p>
                {reviewCapText ? <p data-testid="send-cover-cap">{reviewCapText}</p> : null}
                {coverExpired ? (
                  <p data-testid="send-cover-expired">Cover check expired. Recheck cover before sending.</p>
                ) : coverSecondsLeft !== null && coverSecondsLeft <= 10 ? (
                  <p data-testid="send-cover-expiring">Cover check expires soon.</p>
                ) : null}
                {sendPreview.cover.requiresUncoveredAck ? (
                  <label>
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
                  <label>
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
          {sendError ? <p data-testid="send-error" style={{ color: '#b91c1c' }}>{sendError}</p> : null}
          <button data-testid="send-submit" disabled={!canSend} onClick={() => void onSendSol()}>
            {sendBusy
              ? 'Sending...'
              : sendPreview?.cover.requiresHighRiskAck
                ? 'Send high-risk transaction'
                : sendPreview?.cover.requiresUncoveredAck
                  ? 'Send without cover'
                  : 'Send'}
          </button>
          <button data-testid="send-recheck-cover" disabled={sendPreviewLoading || sendBusy} onClick={() => void loadSendPreview()}>
            Recheck cover
          </button>
        </section>
      )
    }

    return (
      <section data-testid="send-form">
        <button onClick={() => setAccountScreen('home')}>Back</button>
        <h2>Send SOL</h2>
        <label>
          To
          <input
            autoFocus
            data-testid="send-recipient-input"
            onChange={(event) => {
              setSendError('')
              setSendRecipient(event.currentTarget.value)
            }}
            placeholder="Wallet address"
            value={sendRecipient}
          />
        </label>
        <button data-testid="paste-recipient" onClick={() => void onPasteRecipient()}>
          Paste
        </button>
        {recipientError ? <p data-testid="send-recipient-error" style={{ color: '#b91c1c' }}>{recipientError}</p> : null}
        {selfSendError ? <p data-testid="send-self-error" style={{ color: '#b91c1c' }}>{selfSendError}</p> : null}
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
        <p>Available {snapshot ? `${snapshot.solBalance} SOL` : 'unavailable'}</p>
        {coverEnrolled ? (
          <p data-testid="send-cover-status">
            {coverStatusLoading
              ? 'Loading cover cap...'
              : coverStatusSnapshot
                ? formatCoverStatusSnapshot(coverStatusSnapshot)
                : 'Cover cap unavailable.'}
          </p>
        ) : null}
        {sendAmountError ? <p data-testid="send-amount-error" style={{ color: '#b91c1c' }}>{sendAmountError}</p> : null}
        <button data-testid="send-max" onClick={() => setSendAmount(maxSendableSol(snapshot))}>
          Max
        </button>
        {sendError ? <p data-testid="send-error" style={{ color: '#b91c1c' }}>{sendError}</p> : null}
        <button
          data-testid="send-review-next"
          disabled={!recipientValid || recipientIsSelf || !sendAmount.trim() || !!sendAmountError}
          onClick={() => {
            setSendStep('review')
            void loadSendPreview()
          }}
        >
          Review send
        </button>
      </section>
    )
  }

  function renderActivity() {
    const onchainSignatures = new Set(activity.map((item) => item.signature))
    const pendingEmber = emberActivity.filter((item) => !item.signature || !onchainSignatures.has(item.signature))
    const selectedActivity = selectedActivitySignature
      ? activity.find((item) => item.signature === selectedActivitySignature)
      : null
    const selectedCover = selectedActivity
      ? emberActivity.find((item) => item.signature === selectedActivity.signature)
      : null
    if (selectedActivity) {
      return (
        <section data-testid="activity-detail">
          <button onClick={() => setSelectedActivitySignature(null)}>Back</button>
          <h2>{selectedActivity.title}</h2>
          <dl>
            <dt>Status</dt>
            <dd>{selectedActivity.failed ? 'Failed' : selectedActivity.confirmationStatus ?? 'Pending'}</dd>
            {selectedActivity.amount ? (
              <>
                <dt>Amount</dt>
                <dd>{selectedActivity.amount}</dd>
              </>
            ) : null}
            {selectedActivity.counterparty ? (
              <>
                <dt>{selectedActivity.direction === 'received' ? 'From' : 'To'}</dt>
                <dd>{shortAddress(selectedActivity.counterparty)}</dd>
              </>
            ) : null}
            <dt>Signature</dt>
            <dd>
              <a href={selectedActivity.explorerUrl} rel="noreferrer" target="_blank">
                {shortAddress(selectedActivity.signature)}
              </a>
            </dd>
            <dt>Ember Cover</dt>
            <dd>
              {selectedCover
                ? coverStatusLabel(selectedCover.coverStatus)
                : selectedActivity.direction === 'received'
                  ? 'Receiving funds does not require a signature.'
                  : 'No cover record'}
            </dd>
          </dl>
        </section>
      )
    }
    return (
      <section data-testid="wallet-activity">
        <h2>Activity</h2>
        <p>Cover is attached to signed transactions. Receiving funds and copying your address do not create cover records.</p>
        {walletDataError ? <p data-testid="wallet-data-error">{walletDataError}</p> : null}
        {walletDataLoading && snapshot ? <p>Refreshing transactions...</p> : null}
        {snapshot && activity.length > 0 ? (
          <ul>
            {activity.map((tx) => {
              const emberRecord = emberActivity.find((item) => item.signature === tx.signature)
              return (
                <li key={tx.signature} data-testid="wallet-activity-item">
                  <button data-testid="activity-detail-open" onClick={() => setSelectedActivitySignature(tx.signature)}>
                    {tx.title}
                  </button>{' '}
                  <span>{tx.failed ? 'Failed' : tx.confirmationStatus ?? 'Pending'}</span>{' '}
                  <span>
                    {emberRecord
                      ? coverStatusLabel(emberRecord.coverStatus)
                      : tx.direction === 'received'
                        ? 'Not signed by you'
                        : 'No cover record'}
                  </span>
                  {emberRecord?.amount ? <span> {emberRecord.amount}</span> : null}
                  {!emberRecord?.amount && tx.amount ? <span> {tx.amount}</span> : null}
                  {emberRecord?.recipient ? <span> to {shortAddress(emberRecord.recipient)}</span> : null}
                  {!emberRecord?.recipient && tx.counterparty && tx.direction === 'sent' ? (
                    <span> to {shortAddress(tx.counterparty)}</span>
                  ) : null}
                  {tx.blockTime ? <span> {new Date(tx.blockTime * 1000).toLocaleDateString()}</span> : null}
                </li>
              )
            })}
          </ul>
        ) : snapshot && !walletDataLoading ? (
          <p>No transactions found.</p>
        ) : null}
        {snapshot?.emberActivityUnavailable ? <p>Ember activity unavailable.</p> : null}
        {pendingEmber.length > 0 ? (
          <>
            <h3>Pending cover records</h3>
            <ul data-testid="ember-activity">
              {pendingEmber.map((item) => (
                <li key={item.id} data-testid="ember-activity-item">
                  <span>{item.title}</span> <span>{coverStatusLabel(item.coverStatus)}</span>
                  {item.amount ? <span> {item.amount}</span> : null}
                  {item.recipient ? <span> to {shortAddress(item.recipient)}</span> : null}
                  {item.onchainStatus ? <span> {item.onchainStatus}</span> : null}
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
      <div style={{ padding: 16, width: 360 }}>
        <p data-testid="address" style={{ overflowWrap: 'anywhere' }}>{address}</p>
        <div data-testid="wallet-cluster">
          <label>
            Network{' '}
            <select data-testid="cluster-select" onChange={(event) => void onClusterChange(event.target.value as WalletCluster)} value={cluster}>
              {WALLET_CLUSTER_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {renderTabs()}
        {mainTab === 'assets' && accountScreen === 'home' ? renderAssets() : null}
        {mainTab === 'assets' && accountScreen === 'receive' ? renderReceive() : null}
        {mainTab === 'assets' && accountScreen === 'send' ? renderSend() : null}
        {mainTab === 'activity' ? renderActivity() : null}
        <button data-testid="lock" onClick={() => void vault.lock().then(refresh)}>Lock</button>
      </div>
    )
  }
  return (
    <div style={{ padding: 16, width: 320 }}>
      <h1>{view === 'create' ? 'Create your Ember wallet' : 'Unlock'}</h1>
      <input data-testid="password" onChange={(event) => setPassword(event.target.value)} type="password" value={password} />
      <button data-testid="submit" onClick={() => void (view === 'create' ? onCreate() : onUnlock())}>
        {authBusy ? (view === 'create' ? 'Creating...' : 'Unlocking...') : view === 'create' ? 'Create' : 'Unlock'}
      </button>
      {authBusy ? <p data-testid="auth-busy">{view === 'create' ? 'Creating wallet...' : 'Unlocking...'}</p> : null}
      {error ? <p data-testid="error">{error}</p> : null}
    </div>
  )
}
