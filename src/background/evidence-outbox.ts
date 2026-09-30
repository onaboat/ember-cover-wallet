import {
  EmberApiError,
  type EmberWalletClient,
  type SubmitDecisionEvidenceRequest,
} from '@embercover/wallet-sdk'
import { browser } from 'wxt/browser'
import { storage } from 'wxt/utils/storage'

const STORE_KEY = 'local:ember-evidence-outbox:v1' as const
const ALARM_NAME = 'ember-evidence-outbox-drain'

export interface EvidenceOutboxEntry {
  attempts: number
  createdAt: string
  decisionId: string
  lastAttemptAt: string | null
  lastError: string | null
  request: SubmitDecisionEvidenceRequest
}

function normalizeEntries(value: unknown): EvidenceOutboxEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(
      (entry): entry is EvidenceOutboxEntry =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as EvidenceOutboxEntry).decisionId === 'string' &&
        typeof (entry as EvidenceOutboxEntry).createdAt === 'string' &&
        typeof (entry as EvidenceOutboxEntry).attempts === 'number' &&
        typeof (entry as EvidenceOutboxEntry).request === 'object',
    )
}

// The server answers 404 when the decision no longer exists and 409 when it has
// expired or its evidence lifecycle is terminal. Neither can ever be accepted,
// so retrying them only repeats the same rejection every drain.
function isFinalRejection(error: unknown): boolean {
  return error instanceof EmberApiError && (error.status === 404 || error.status === 409)
}

export class EvidenceOutbox {
  private readonly now: () => Date
  private writes: Promise<void> = Promise.resolve()
  private draining: Promise<void> | null = null
  private drainRequested = false

  constructor(now: () => Date = () => new Date()) {
    this.now = now
  }

  async put(decisionId: string, request: SubmitDecisionEvidenceRequest): Promise<void> {
    await this.mutate(async (entries) => {
      const existing = entries.find((entry) => entry.decisionId === decisionId)
      if (existing) {
        if (JSON.stringify(existing.request) !== JSON.stringify(request)) {
          throw new Error('Evidence decision already has different signed bytes')
        }
        return entries
      }
      const next: EvidenceOutboxEntry = {
        attempts: 0,
        createdAt: this.now().toISOString(),
        decisionId,
        lastAttemptAt: null,
        lastError: null,
        request,
      }
      return [...entries, next]
    })
  }

  private async mutate(update: (entries: EvidenceOutboxEntry[]) => Promise<EvidenceOutboxEntry[]>): Promise<void> {
    const write = this.writes.then(async () => {
      await storage.setItem(STORE_KEY, await update(await this.list()))
    })
    this.writes = write.catch(() => {})
    await write
  }

  async list(): Promise<EvidenceOutboxEntry[]> {
    return normalizeEntries(await storage.getItem<unknown>(STORE_KEY))
  }

  async drain(client: EmberWalletClient): Promise<void> {
    this.drainRequested = true
    if (this.draining) return this.draining
    this.draining = this.drainRequestedEntries(client)
    return this.draining
  }

  private async drainRequestedEntries(client: EmberWalletClient): Promise<void> {
    // A failed entry gets at most one attempt per drain cycle. New arrivals
    // trigger another snapshot immediately without spinning on old failures.
    const attempted = new Set<string>()
    try {
      do {
        this.drainRequested = false
        await this.drainEntries(client, attempted)
      } while (this.drainRequested)
    } finally {
      // Clear ownership in the same turn as the final wakeup check.
      this.draining = null
    }
  }

  private async drainEntries(client: EmberWalletClient, attempted: Set<string>): Promise<void> {
    const entries = await this.list()
    for (const entry of [...entries]) {
      if (attempted.has(entry.decisionId)) continue
      attempted.add(entry.decisionId)
      try {
        const response = await client.submitDecisionEvidence(entry.decisionId, entry.request)
        if (!response.accepted) {
          throw new Error('Ember did not accept the exact signed evidence')
        }
        await this.mutate(async (current) => current.filter((candidate) => candidate.decisionId !== entry.decisionId))
      } catch (error) {
        if (isFinalRejection(error)) {
          await this.mutate(async (current) => current.filter((candidate) => candidate.decisionId !== entry.decisionId))
          continue
        }
        const now = this.now().toISOString()
        await this.mutate(async (current) => current.map((candidate) =>
          candidate.decisionId === entry.decisionId
            ? {
                ...candidate,
                attempts: candidate.attempts + 1,
                lastAttemptAt: now,
                lastError: error instanceof Error ? error.message : 'Evidence delivery failed',
              }
            : candidate,
        ))
      }
    }
  }

  async clear(): Promise<void> {
    await storage.removeItem(STORE_KEY)
  }
}

export const evidenceOutbox = new EvidenceOutbox()
let recoveryClient: (() => Promise<EmberWalletClient | null>) | undefined

export async function wakeEvidenceOutbox(): Promise<void> {
  const client = await recoveryClient?.()
  if (client) await evidenceOutbox.drain(client)
}

export function registerEvidenceOutboxRecovery(
  client: () => Promise<EmberWalletClient | null>,
): void {
  recoveryClient = client
  void browser.alarms.create(ALARM_NAME, { periodInMinutes: 1 })
  const drain = () => wakeEvidenceOutbox().catch(() => {})
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) void drain()
  })
  void drain()
}
