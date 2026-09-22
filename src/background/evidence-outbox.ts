import type {
  EmberWalletClient,
  SubmitDecisionEvidenceRequest,
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

export class EvidenceOutbox {
  private readonly now: () => Date
  private writes: Promise<void> = Promise.resolve()
  private draining: Promise<void> | null = null

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
    if (this.draining) return this.draining
    this.draining = this.drainEntries(client).finally(() => { this.draining = null })
    return this.draining
  }

  private async drainEntries(client: EmberWalletClient): Promise<void> {
    const entries = await this.list()
    for (const entry of [...entries]) {
      try {
        const response = await client.submitDecisionEvidence(entry.decisionId, entry.request)
        if (!response.accepted) {
          throw new Error('Ember did not accept the exact signed evidence')
        }
        await this.mutate(async (current) => current.filter((candidate) => candidate.decisionId !== entry.decisionId))
      } catch (error) {
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

export function registerEvidenceOutboxRecovery(
  client: () => Promise<EmberWalletClient | null>,
): void {
  void browser.alarms.create(ALARM_NAME, { periodInMinutes: 1 })
  const drain = async () => {
    const activeClient = await client()
    if (activeClient) await evidenceOutbox.drain(activeClient)
  }
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) void drain()
  })
  void drain()
}
