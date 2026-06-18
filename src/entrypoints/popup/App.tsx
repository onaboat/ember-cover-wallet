import { useEffect, useState } from 'react'

import { getCoverService } from '../../background/cover-service.ts'
import { getVaultService } from '../../background/vault-service.ts'
import type { WalletDataSnapshot } from '../../background/wallet-data-service.ts'
import { getWalletDataService } from '../../background/wallet-data-service.ts'
import type { WalletCluster } from '../../background/wallet-data-config.ts'
import { WALLET_CLUSTER_OPTIONS } from '../../background/wallet-data-config.ts'

type View = 'loading' | 'create' | 'unlock' | 'account'

function coverStatusLabel(status: string): string {
  if (status === 'covered') {
    return 'Covered by Ember'
  }
  if (status === 'not_covered') {
    return 'Not covered'
  }
  if (status === 'unavailable') {
    return 'Cover unavailable'
  }
  return 'Cover status unknown'
}

function arrayOrEmpty<T>(value: T[] | readonly T[] | undefined): T[] | readonly T[] {
  return Array.isArray(value) ? value : []
}

export function App() {
  const vault = getVaultService()
  const cover = getCoverService()
  const walletData = getWalletDataService()
  const [view, setView] = useState<View>('loading')
  const [address, setAddress] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [coverEnrolled, setCoverEnrolled] = useState<boolean | null>(null)
  const [coverBusy, setCoverBusy] = useState(false)
  const [cluster, setCluster] = useState<WalletCluster>('devnet')
  const [snapshot, setSnapshot] = useState<WalletDataSnapshot | null>(null)
  const [walletDataLoading, setWalletDataLoading] = useState(false)
  const [walletDataError, setWalletDataError] = useState('')
  const [copied, setCopied] = useState(false)
  const tokenBalances = arrayOrEmpty(snapshot?.tokenBalances)
  const emberActivity = arrayOrEmpty(snapshot?.emberActivity)
  const activity = arrayOrEmpty(snapshot?.activity)

  async function refresh() {
    if (!(await vault.hasVault())) { setView('create'); return }
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

  useEffect(() => {
    if (view === 'account') {
      void cover.isEnrolled().then(setCoverEnrolled)
    }
  }, [view])

  async function refreshWalletData(walletAddress = address) {
    if (!walletAddress) {
      return
    }
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
    if (!address) {
      return
    }
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setWalletDataError('Could not copy address')
    }
  }

  async function onEnableCover() {
    setError('')
    setCoverBusy(true)
    try {
      const enrolled = await cover.enroll()
      setCoverEnrolled(enrolled)
      if (!enrolled) {
        setError('Could not enable Ember Cover. Check the deployed cover service and try again.')
      }
    } catch (e) {
      setCoverEnrolled(false)
      setError(e instanceof Error ? e.message : 'Could not enable Ember Cover')
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
      setError(e instanceof Error ? e.message : 'failed')
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

  if (view === 'loading') return <p>Loading…</p>
  if (view === 'account') {
    return (
      <div style={{ padding: 16, width: 320 }}>
        <p data-testid="address">{address}</p>
        <button data-testid="copy-address" onClick={() => void onCopyAddress()}>
          {copied ? 'Copied' : 'Copy address'}
        </button>
        <div data-testid="wallet-cluster">
          <label>
            Cluster{' '}
            <select
              data-testid="cluster-select"
              value={cluster}
              onChange={(e) => void onClusterChange(e.target.value as WalletCluster)}
            >
              {WALLET_CLUSTER_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <section data-testid="wallet-balance">
          <h2>Balance</h2>
          <p>
            {walletDataLoading && !snapshot ? 'Loading balance…' : snapshot ? `${snapshot.solBalance} SOL` : 'Balance unavailable'}
          </p>
          <button
            data-testid="refresh-wallet-data"
            disabled={walletDataLoading}
            onClick={() => void refreshWalletData()}
          >
            {walletDataLoading ? 'Refreshing…' : 'Refresh'}
          </button>
        </section>
        <section data-testid="wallet-tokens">
          <h2>Tokens</h2>
          {snapshot?.tokenBalancesUnavailable ? <p>Token balances unavailable.</p> : null}
          {snapshot && tokenBalances.length > 0 ? (
            <ul>
              {tokenBalances.map((token) => (
                <li key={token.tokenAccount} data-testid="wallet-token-item">
                  <span>{token.label}</span>{' '}
                  <span>{token.uiAmount}</span>{' '}
                  <span>{token.mint.slice(0, 8)}…{token.mint.slice(-8)}</span>
                </li>
              ))}
            </ul>
          ) : snapshot && !snapshot.tokenBalancesUnavailable && !walletDataLoading ? (
            <p>No tokens found.</p>
          ) : null}
        </section>
        {coverEnrolled ? (
          <div>
            <p data-testid="cover-status" style={{ margin: '4px 0' }}>Ember Cover enabled</p>
            <button data-testid="reenable-cover" disabled={coverBusy} onClick={() => void onEnableCover()} style={{ fontSize: 12 }}>
              {coverBusy ? 'Re-enabling…' : 'Re-enable'}
            </button>
          </div>
        ) : (
          <button data-testid="enable-cover" disabled={coverBusy} onClick={() => void onEnableCover()}>
            {coverBusy ? 'Enabling…' : 'Enable Ember Cover'}
          </button>
        )}
        {error ? <p data-testid="cover-error" style={{ color: '#b91c1c', fontSize: 12 }}>{error}</p> : null}
        <section data-testid="ember-activity">
          <h2>Ember Activity</h2>
          {snapshot?.emberActivityUnavailable ? <p>Ember activity unavailable.</p> : null}
          {snapshot && emberActivity.length > 0 ? (
            <ul>
              {emberActivity.map((item) => (
                <li key={item.id} data-testid="ember-activity-item">
                  <span>{item.title}</span>{' '}
                  <span>{coverStatusLabel(item.coverStatus)}</span>
                  {item.amount ? <span> {item.amount}</span> : null}
                  {item.recipient ? <span> to {item.recipient.slice(0, 8)}…{item.recipient.slice(-8)}</span> : null}
                  {item.dappOrigin ? <span> from {item.dappOrigin}</span> : null}
                  {item.onchainStatus ? <span> {item.onchainStatus}</span> : null}
                </li>
              ))}
            </ul>
          ) : snapshot && !snapshot.emberActivityUnavailable && !walletDataLoading ? (
            <p>No Ember activity found.</p>
          ) : null}
        </section>
        <section data-testid="wallet-activity">
          <h2>On-chain Transactions</h2>
          {walletDataError ? <p data-testid="wallet-data-error">{walletDataError}</p> : null}
          {walletDataLoading && snapshot ? <p>Refreshing transactions…</p> : null}
          {snapshot && activity.length > 0 ? (
            <ul>
              {activity.map((tx) => {
                const emberRecord = emberActivity.find((item) => item.signature === tx.signature)
                return (
                  <li key={tx.signature} data-testid="wallet-activity-item">
                    <span>{tx.failed ? 'Failed' : tx.confirmationStatus ?? 'Pending'}</span>{' '}
                    <a href={tx.explorerUrl} rel="noreferrer" target="_blank">
                      {tx.signature.slice(0, 8)}…{tx.signature.slice(-8)}
                    </a>
                    {emberRecord ? <span> {coverStatusLabel(emberRecord.coverStatus)}</span> : null}
                    {tx.blockTime ? <span> {new Date(tx.blockTime * 1000).toLocaleDateString()}</span> : null}
                  </li>
                )
              })}
            </ul>
          ) : snapshot && !walletDataLoading ? (
            <p>No transactions found.</p>
          ) : null}
        </section>
        <button data-testid="lock" onClick={() => void vault.lock().then(refresh)}>Lock</button>
      </div>
    )
  }
  return (
    <div style={{ padding: 16, width: 320 }}>
      <h1>{view === 'create' ? 'Create your Ember wallet' : 'Unlock'}</h1>
      <input
        data-testid="password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button data-testid="submit" onClick={() => void (view === 'create' ? onCreate() : onUnlock())}>
        {authBusy ? (view === 'create' ? 'Creating…' : 'Unlocking…') : view === 'create' ? 'Create' : 'Unlock'}
      </button>
      {authBusy ? <p data-testid="auth-busy">{view === 'create' ? 'Creating wallet…' : 'Unlocking…'}</p> : null}
      {error ? <p data-testid="error">{error}</p> : null}
    </div>
  )
}
