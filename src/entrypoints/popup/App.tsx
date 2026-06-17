import { useEffect, useState } from 'react'

import { getCoverService } from '../../background/cover-service.ts'
import { getVaultService } from '../../background/vault-service.ts'

type View = 'loading' | 'create' | 'unlock' | 'account'

export function App() {
  const vault = getVaultService()
  const cover = getCoverService()
  const [view, setView] = useState<View>('loading')
  const [address, setAddress] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [coverEnrolled, setCoverEnrolled] = useState<boolean | null>(null)
  const [coverBusy, setCoverBusy] = useState(false)

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

  async function onEnableCover() {
    setCoverBusy(true)
    try {
      setCoverEnrolled(await cover.enroll())
    } catch {
      setCoverEnrolled(false)
    }
    setCoverBusy(false)
  }

  async function onCreate() {
    setError('')
    try {
      setAddress(await vault.createVault(password))
      await vault.unlock(password)
      setPassword('')
      setView('account')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed')
    }
  }

  async function onUnlock() {
    setError('')
    try {
      await vault.unlock(password)
      setPassword('')
      await refresh()
    } catch {
      setError('Wrong password')
    }
  }

  if (view === 'loading') return <p>Loading…</p>
  if (view === 'account') {
    return (
      <div style={{ padding: 16, width: 320 }}>
        <p data-testid="address">{address}</p>
        {coverEnrolled ? (
          <p data-testid="cover-status">Ember Cover enabled</p>
        ) : (
          <button data-testid="enable-cover" disabled={coverBusy} onClick={() => void onEnableCover()}>
            {coverBusy ? 'Enabling…' : 'Enable Ember Cover'}
          </button>
        )}
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
        {view === 'create' ? 'Create' : 'Unlock'}
      </button>
      {error ? <p data-testid="error">{error}</p> : null}
    </div>
  )
}
