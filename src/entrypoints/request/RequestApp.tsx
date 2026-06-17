import { useEffect, useState } from 'react'

import type { PendingRequestView } from '../../background/request-service.ts'
import { getRequestApproval } from '../../background/request-service.ts'
import { getVaultService } from '../../background/vault-service.ts'
import type { CoverDebugInfo } from '../../cover/ember-types.ts'
import { bannerView } from '../../cover/cover-banner-view.ts'
import { decodeMessages } from './decode-messages.ts'
import { decodeTransactionSummary } from './decode-transaction.ts'

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
      // Keep polling until the signTransaction cover decision resolves (fail-open ~1.5s) or we give up.
      if (view?.type === 'signTransaction' && !view.cover && polls < 12) {
        setTimeout(() => void poll(), 400)
      } else {
        setCoverGaveUp(view?.type === 'signTransaction' && !view.cover)
      }
    }
    void poll()
    return () => {
      active = false
    }
  }, [])

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
    if (!pending) {
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
      <details data-testid="cover-debug" open style={{ margin: '8px 0' }}>
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
      <h1>
        {pending.type === 'connect'
          ? 'Connect'
          : pending.type === 'signMessage'
            ? 'Sign Message'
            : 'Sign Transaction'}
      </h1>
      {pending.origin ? (
        <p data-testid="origin" style={{ fontWeight: 700, fontSize: 16 }}>
          {pending.origin}
        </p>
      ) : null}
      <p data-testid="account">{address}</p>
      {pending.type === 'signMessage' ? (
        <pre data-testid="message" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {decodeMessages(pending.data as { message: Uint8Array | Record<string, number> }[])}
        </pre>
      ) : null}
      {pending.type === 'signTransaction'
        ? (() => {
            const data = pending.data as { transaction: Uint8Array | Record<string, number> }[]
            const summary = data[0] ? decodeTransactionSummary(data[0].transaction) : null
            return (
              <div data-testid="tx">
                {summary ? (
                  <>
                    <p style={{ margin: '4px 0', fontSize: 13 }}>
                      From {summary.feePayer.slice(0, 8)}…{summary.feePayer.slice(-6)}
                    </p>
                    <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 13 }}>
                      {summary.instructions.map((ix, i) => (
                        <li key={i}>{ix.programName}</li>
                      ))}
                    </ul>
                    {summary.instructions.length === 0 ? (
                      <p style={{ fontSize: 13 }}>No instructions</p>
                    ) : null}
                  </>
                ) : (
                  <p>Transaction</p>
                )}
              </div>
            )
          })()
        : null}
      {pending.type === 'signTransaction'
        ? (() => {
            const fallbackCover = coverGaveUp
              ? ({
                  coverStatus: 'unavailable',
                  riskBand: 'severe',
                  debug: {
                    stage: 'approval_poll_timeout',
                    apiAttempted: false,
                  },
                } as const)
              : null
            const cover = pending.cover ?? fallbackCover
            const banner = bannerView(cover, !cover)
            return banner.label ? (
              <>
                <p data-testid="cover" data-tone={banner.tone}>
                  {banner.label}
                </p>
                {cover?.debug ? <CoverDebugPanel debug={cover.debug} /> : null}
              </>
            ) : null
          })()
        : null}
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
        <button data-testid="approve" disabled={busy} onClick={() => void onApprove()}>
          {busy ? 'Working…' : 'Approve'}
        </button>
        <button data-testid="reject" disabled={busy} onClick={() => void onReject()}>
          Reject
        </button>
      </div>
      {error ? <p data-testid="error">{error}</p> : null}
    </div>
  )
}
