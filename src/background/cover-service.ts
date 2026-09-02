import type {
  ClaimEligibilityResponse,
  CreateClaimRequest,
  EmberFetch,
  EmberWalletClient,
  PublicDecisionReason,
  SigningReview,
  WalletClaimResponse,
} from '@embercover/wallet-sdk'
import { createProxyService, registerService } from '@webext-core/proxy-service'
import type { ProxyService, ProxyServiceKey } from '@webext-core/proxy-service'

import type {
  CoverDebugInfo,
  CoverDecision,
  CoverStatusSnapshot,
} from '../cover/ember-types.ts'
import {
  EMBER_CONFIG,
} from '../cover/ember-config.ts'
import type { EmberRuntimeConfig } from '../cover/ember-config.ts'

import {
  EmberClientCoordinator,
} from './ember-client-coordinator.ts'
import type {
  EmberSessionStatus,
  EmberVaultSigner,
} from './ember-client-coordinator.ts'
import {
  emberLifecycleStore,
} from './ember-lifecycle-store.ts'
import type {
  WalletLifecycleSnapshot,
} from './ember-lifecycle-store.ts'
import {
  evidenceOutbox,
} from './evidence-outbox.ts'
import type { WalletCluster } from './wallet-data-config.ts'

export interface PreSignArgs {
  transactionBytes: string
  dappUrl?: string
  cluster?: WalletCluster
}

export interface PostSignArgs {
  /** P14 keeps the old property name at this boundary; its value is the SDK decisionId. */
  requestId: string
  signedBytes: string
  signature?: string
  signingWalletPublicKey: string
  walletTimestamp: string
}

export interface MessagePreSignArgs {
  messageBytes: string
  dappUrl?: string
  walletMethod: 'signMessage'
  messageKind: string
  declaredIntent?: string
}

export interface MessagePostSignArgs {
  /** P14 keeps the old property name at this boundary; its value is the SDK decisionId. */
  requestId: string
  signedMessage: string
  signature: string
  signingWalletPublicKey: string
  walletTimestamp: string
  highRiskAckAt?: string
}

export interface CoverProvider {
  preSign(args: PreSignArgs): Promise<CoverDecision>
  postSign(args: PostSignArgs): Promise<void>
  status(): Promise<CoverStatusSnapshot | null>
  preSignMessage(args: MessagePreSignArgs): Promise<CoverDecision>
  postSignMessage(args: MessagePostSignArgs): Promise<void>
  enroll(): Promise<boolean>
  isEnrolled(): Promise<boolean>
}

export interface EmberLifecycleProvider extends CoverProvider {
  revoke(): Promise<void>
  sessionStatus(): Promise<EmberSessionStatus>
  lifecycle(): Promise<WalletLifecycleSnapshot | null>
  activeClient(): Promise<EmberWalletClient | null>
  claimEligibility(decisionId: string): Promise<ClaimEligibilityResponse>
  createClaim(request: CreateClaimRequest): Promise<WalletClaimResponse>
}

export type CoverWalletSigner = EmberVaultSigner

interface ProviderDependencies {
  config?: EmberRuntimeConfig
  fetch?: EmberFetch
  coordinator?: EmberClientCoordinator
}

function unavailable(debug?: CoverDebugInfo): CoverDecision {
  return {
    requestId: '',
    coverStatus: 'unavailable',
    riskBand: 'severe',
    decisionReason: 'temporarily_unavailable',
    decisionExpiresAt: new Date(0).toISOString(),
    ...(debug === undefined ? {} : { debug }),
  }
}

function notCovered(
  decisionReason: PublicDecisionReason,
  debug?: CoverDebugInfo,
): CoverDecision {
  return {
    requestId: '',
    coverStatus: 'not_covered',
    riskBand: 'low',
    decisionReason,
    decisionExpiresAt: new Date(0).toISOString(),
    ...(debug === undefined ? {} : { debug }),
  }
}

function microsToUsd(value: string): number {
  const micros = Number(value)
  return Number.isFinite(micros) && micros >= 0 ? micros / 1_000_000 : 0
}

function decisionView(review: SigningReview): CoverDecision {
  if (review.status !== 'reviewed') {
    const debug: CoverDebugInfo = {
      stage: 'api_pre_sign_non_ok',
      apiAttempted: true,
      ...(review.requestId ? { requestId: review.requestId } : {}),
      coverStatus: review.coverStatus,
      error: review.reason,
    }
    return review.status === 'not_covered'
      ? notCovered(review.reason, debug)
      : unavailable(debug)
  }
  const decision = review.decision
  return {
    requestId: decision.decisionId,
    coverStatus: decision.coverStatus,
    riskBand: decision.riskBand,
    decisionReason: decision.decisionReason,
    decisionExpiresAt: decision.decisionExpiresAt,
    coveredTxCountImpact: decision.evaluationCountImpact,
    capContext: {
      monthlyLossCapUsd: microsToUsd(decision.remainingAggregateLimitMicros),
      remainingCoveredTxThisMonth: decision.remainingUnderwritingEvaluations,
    },
    debug: {
      stage: 'api_pre_sign_ok',
      apiAttempted: true,
      requestId: decision.decisionId,
      coverStatus: decision.coverStatus,
      riskBand: decision.riskBand,
      decisionExpiresAt: decision.decisionExpiresAt,
      decisionReason: decision.decisionReason,
      enrolled: true,
      walletAddress: decision.protectedWallet,
    },
  }
}

/**
 * Direct, secretless Ember SDK provider.
 *
 * This no longer calls the compatibility Worker or injects a partner secret.
 * Server responses remain authoritative; local lifecycle data is only a cache
 * and evidence is durably queued before signed bytes leave the wallet.
 */
export class EmberCoverProvider implements EmberLifecycleProvider {
  private readonly config: EmberRuntimeConfig
  private readonly coordinator: EmberClientCoordinator
  private readonly signer: CoverWalletSigner

  constructor(signer: CoverWalletSigner, dependencies: ProviderDependencies = {}) {
    this.signer = signer
    this.config = dependencies.config ?? EMBER_CONFIG
    this.coordinator =
      dependencies.coordinator ??
      new EmberClientCoordinator(signer, {
        config: this.config,
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      })
  }

  async activeClient(): Promise<EmberWalletClient | null> {
    return await this.coordinator.activeClient()
  }

  async enroll(): Promise<boolean> {
    await this.coordinator.enroll()
    return true
  }

  async revoke(): Promise<void> {
    await this.coordinator.revoke()
  }

  async sessionStatus(): Promise<EmberSessionStatus> {
    return await this.coordinator.status()
  }

  async isEnrolled(): Promise<boolean> {
    return (await this.coordinator.status()).phase === 'active'
  }

  async lifecycle(): Promise<WalletLifecycleSnapshot | null> {
    const walletAddress = await this.signer.getAddress()
    if (!walletAddress) return null
    const client = await this.activeClient()
    if (!client) {
      const cached = await emberLifecycleStore.load(walletAddress)
      return {
        ...cached,
        authority:
          cached.payment || cached.coverage || cached.decisions.length > 0 || cached.claims.length > 0
            ? 'cache'
            : 'unavailable',
        error: 'A live Ember session is required to verify lifecycle records',
      }
    }
    return await emberLifecycleStore.refresh(walletAddress, client)
  }

  async preSign(args: PreSignArgs): Promise<CoverDecision> {
    if (args.cluster !== undefined && args.cluster !== this.config.expectedCluster) {
      return unavailable({
        stage: 'cluster_mismatch',
        apiAttempted: false,
        error: `Wallet transaction is ${args.cluster}; Ember is configured for ${this.config.expectedCluster}.`,
        ...(args.dappUrl === undefined ? {} : { dappUrl: args.dappUrl }),
      })
    }
    return await this.review({
      kind: 'transaction',
      transactionBytes: args.transactionBytes,
      ...(args.dappUrl === undefined ? {} : { dappUrl: args.dappUrl }),
    })
  }

  async preSignMessage(args: MessagePreSignArgs): Promise<CoverDecision> {
    return await this.review({
      kind: 'message',
      messageBytes: args.messageBytes,
      walletMethod: args.walletMethod,
      ...(args.dappUrl === undefined ? {} : { dappUrl: args.dappUrl }),
    })
  }

  async postSign(args: PostSignArgs): Promise<void> {
    await evidenceOutbox.put(args.requestId, {
      kind: 'transaction',
      signedBytes: args.signedBytes,
    })
    const client = await this.activeClient()
    if (client) void evidenceOutbox.drain(client)
  }

  async postSignMessage(args: MessagePostSignArgs): Promise<void> {
    await evidenceOutbox.put(args.requestId, {
      kind: 'message',
      signedMessage: args.signedMessage,
      signature: args.signature,
    })
    const client = await this.activeClient()
    if (client) void evidenceOutbox.drain(client)
  }

  async status(): Promise<CoverStatusSnapshot | null> {
    const snapshot = await this.lifecycle()
    if (!snapshot || snapshot.authority !== 'server' || !snapshot.coverage) return null
    const coverage = snapshot.coverage
    const latestDecision = snapshot.decisions.at(-1)?.cachedDecision
    const remaining =
      latestDecision?.coverageInstanceId === coverage.coverageInstanceId
        ? latestDecision.remainingUnderwritingEvaluations
        : coverage.coveredTransactionLimit
    const used = Math.max(0, coverage.coveredTransactionLimit - remaining)
    return {
      subscriptionActive:
        coverage.status === 'active' && Date.now() < Date.parse(coverage.coverageEndsAt),
      subscriptionStatus: coverage.status,
      walletRegistered: true,
      tier: coverage.offerId,
      month: new Date().toISOString().slice(0, 7),
      currentPeriodEnd:
        coverage.currentBenefitPeriodEndsAt ?? coverage.coverageEndsAt,
      coveredTxPerMonth: coverage.coveredTransactionLimit,
      usedCoveredTxThisMonth: used,
      remainingCoveredTxThisMonth: remaining,
      monthlyLossCapUsd: microsToUsd(coverage.benefitPeriodLimitMicros),
      usedLossCapUsd: Math.max(
        0,
        microsToUsd(coverage.benefitPeriodLimitMicros) -
          microsToUsd(
            latestDecision?.remainingAggregateLimitMicros ??
              coverage.remainingBenefitPeriodLimitMicros ??
              coverage.benefitPeriodLimitMicros,
          ),
      ),
      remainingLossCapUsd: microsToUsd(
        latestDecision?.remainingAggregateLimitMicros ??
          coverage.remainingBenefitPeriodLimitMicros ??
          coverage.benefitPeriodLimitMicros,
      ),
    }
  }

  async claimEligibility(decisionId: string): Promise<ClaimEligibilityResponse> {
    const client = await this.requireActiveClient()
    return await client.claimEligibility(decisionId)
  }

  async createClaim(request: CreateClaimRequest): Promise<WalletClaimResponse> {
    const client = await this.requireActiveClient()
    return await client.createClaim(request)
  }

  private async review(
    request:
      | {
          kind: 'transaction'
          transactionBytes: string
          dappUrl?: string
        }
      | {
          kind: 'message'
          messageBytes: string
          walletMethod: 'signMessage'
          dappUrl?: string
        },
  ): Promise<CoverDecision> {
    if (this.config.problems.length > 0) {
      return unavailable({
        stage: 'provider_error',
        apiAttempted: false,
        error: this.config.problems.join('; '),
      })
    }
    const walletAddress = await this.signer.getAddress()
    if (!walletAddress) {
      return unavailable({
        stage: 'no_wallet',
        apiAttempted: false,
      })
    }
    const client = await this.activeClient()
    if (!client) {
      return notCovered('not_eligible', {
        stage: 'not_enrolled',
        apiAttempted: false,
        walletAddress,
        enrolled: false,
      })
    }
    const lifecycle = await emberLifecycleStore.refresh(walletAddress, client)
    const coverage = lifecycle.authority === 'server' ? lifecycle.coverage : null
    if (
      !coverage ||
      coverage.status !== 'active' ||
      Date.now() >= Date.parse(coverage.coverageEndsAt)
    ) {
      return notCovered('not_eligible', {
        stage: 'not_enrolled',
        apiAttempted: true,
        walletAddress,
        enrolled: true,
        error:
          lifecycle.authority === 'server'
            ? 'No active server-confirmed coverage'
            : lifecycle.error ?? 'Coverage could not be verified',
      })
    }
    const review = await client.reviewForSigning({
      ...request,
      coverageInstanceId: coverage.coverageInstanceId,
    })
    if (review.status === 'reviewed') {
      await emberLifecycleStore.recordDecision({
        walletAddress,
        decision: review.decision,
        ...(request.dappUrl ? { dappOrigin: request.dappUrl } : {}),
      })
    }
    return decisionView(review)
  }

  private async requireActiveClient(): Promise<EmberWalletClient> {
    const client = await this.activeClient()
    if (!client) throw new Error('Connect or renew the Ember session first')
    return client
  }
}

/** The narrow Ember lifecycle surface exposed to extension UI contexts. */
export interface CoverUI {
  enroll(): Promise<boolean>
  revoke(): Promise<void>
  isEnrolled(): Promise<boolean>
  sessionStatus(): Promise<EmberSessionStatus>
  lifecycle(): Promise<WalletLifecycleSnapshot | null>
  status(): Promise<CoverStatusSnapshot | null>
  claimEligibility(decisionId: string): Promise<ClaimEligibilityResponse>
  createClaim(request: CreateClaimRequest): Promise<WalletClaimResponse>
}

const COVER_SERVICE_KEY = 'ember.CoverService' as ProxyServiceKey<CoverUI>

export function registerCoverService(provider: EmberLifecycleProvider): void {
  const facade: CoverUI = {
    enroll: () => provider.enroll(),
    revoke: () => provider.revoke(),
    isEnrolled: () => provider.isEnrolled(),
    sessionStatus: () => provider.sessionStatus(),
    lifecycle: () => provider.lifecycle(),
    status: () => provider.status(),
    claimEligibility: (decisionId) => provider.claimEligibility(decisionId),
    createClaim: (request) => provider.createClaim(request),
  }
  registerService(COVER_SERVICE_KEY, facade)
}

export function getCoverService(): ProxyService<CoverUI> {
  return createProxyService<CoverUI>(COVER_SERVICE_KEY)
}
