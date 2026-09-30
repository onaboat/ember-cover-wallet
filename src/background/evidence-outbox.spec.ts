import { EmberApiError, type SubmitDecisionEvidenceRequest } from '@embercover/wallet-sdk'
import { beforeEach, expect, test } from 'vitest'
import { fakeBrowser } from 'wxt/testing'

import { EvidenceOutbox } from './evidence-outbox.ts'

const REQUEST = {
  kind: 'transaction',
  signedBytes: 'AQID',
} satisfies SubmitDecisionEvidenceRequest

beforeEach(() => fakeBrowser.reset())

test('persists exact evidence before delivery and removes it only after server acceptance', async () => {
  const queue = new EvidenceOutbox(() => new Date('2026-07-28T00:00:00.000Z'))
  await queue.put('decision_test', REQUEST)
  expect(await queue.list()).toHaveLength(1)
  await queue.drain({
    submitDecisionEvidence: async () => ({
      accepted: true,
      decisionId: 'decision_test',
      evidenceState: 'post_sign',
    }),
  } as never)
  expect(await queue.list()).toEqual([])
})

test('survives failed delivery and retries the identical business request', async () => {
  const queue = new EvidenceOutbox()
  await queue.put('decision_test', REQUEST)
  await queue.drain({
    submitDecisionEvidence: async () => {
      throw new Error('offline')
    },
  } as never)
  expect(await queue.list()).toMatchObject([
    {
      attempts: 1,
      decisionId: 'decision_test',
      lastError: 'offline',
      request: REQUEST,
    },
  ])
})

test('rejects changed bytes for an existing decision identifier', async () => {
  const queue = new EvidenceOutbox()
  await queue.put('decision_test', REQUEST)
  await expect(
    queue.put('decision_test', { kind: 'transaction', signedBytes: 'changed' }),
  ).rejects.toThrow('different signed bytes')
})

test('new evidence is uploaded when its drain request arrives during another upload', async () => {
  const queue = new EvidenceOutbox()
  await queue.put('decision_old', REQUEST)
  let release!: () => void
  let began!: () => void
  const started = new Promise<void>((resolve) => { began = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const uploaded: string[] = []
  const client = { submitDecisionEvidence: async (id: string) => {
    uploaded.push(id); began(); await gate
    return { accepted: true, decisionId: id, evidenceState: 'post_sign' }
  } } as never
  const first = queue.drain(client)
  await started
  await queue.put('decision_new', { kind: 'transaction', signedBytes: 'BAUG' })
  const second = queue.drain(client)
  release()
  await Promise.all([first, second])
  expect(uploaded).toEqual(['decision_old', 'decision_new'])
  expect(await queue.list()).toEqual([])
})

test('a wakeup delivers new evidence without repeatedly retrying an old failure', async () => {
  const queue = new EvidenceOutbox()
  await queue.put('old', REQUEST)
  const calls: string[] = []
  const client = { submitDecisionEvidence: async (id: string) => {
    calls.push(id)
    if (id === 'old') {
      await queue.put('new', { kind: 'transaction', signedBytes: 'BAUG' })
      void queue.drain(client)
      throw new Error('offline for old evidence')
    }
    return { accepted: true, decisionId: id, evidenceState: 'post_sign' }
  } } as never
  await queue.drain(client)
  expect(calls).toEqual(['old', 'new'])
  expect(await queue.list()).toMatchObject([{ decisionId: 'old', attempts: 1 }])
})

function rejectingClient(status: number) {
  const calls: string[] = []
  const client = { submitDecisionEvidence: async (id: string) => {
    calls.push(id)
    throw new EmberApiError(status, undefined, undefined)
  } } as never
  return { calls, client }
}

test('stops retrying evidence the server rejects as a conflict', async () => {
  const queue = new EvidenceOutbox()
  await queue.put('decision_expired', REQUEST)
  const { client } = rejectingClient(409)
  await queue.drain(client)
  expect(await queue.list()).toEqual([])
})

test('stops retrying evidence for a decision the server no longer has', async () => {
  const queue = new EvidenceOutbox()
  await queue.put('decision_missing', REQUEST)
  const { client } = rejectingClient(404)
  await queue.drain(client)
  expect(await queue.list()).toEqual([])
})

test('keeps evidence queued after a server error so it can retry', async () => {
  const queue = new EvidenceOutbox()
  await queue.put('decision_test', REQUEST)
  const { client } = rejectingClient(503)
  await queue.drain(client)
  expect(await queue.list()).toMatchObject([{ decisionId: 'decision_test', attempts: 1 }])
})
