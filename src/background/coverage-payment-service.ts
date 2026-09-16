import type {
  AvailableOfferResponse,
  EmberWalletClient,
  PaymentResponse,
  SignedQuoteResponse,
} from '@embercover/wallet-sdk'
import {
  createSolanaRpc,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  signTransactionMessageWithSigners,
} from '@solana/kit'
import type {
  Base64EncodedWireTransaction,
  Signature,
} from '@solana/kit'
import { createProxyService, registerService } from '@webext-core/proxy-service'
import type { ProxyService, ProxyServiceKey } from '@webext-core/proxy-service'
import { storage } from 'wxt/utils/storage'

import { EMBER_CONFIG } from '../cover/ember-config.ts'
import type { EmberRuntimeConfig } from '../cover/ember-config.ts'
import { validateCoveragePaymentContract } from '../cover/coverage-payment-contract.ts'
import {
  bindQuoteReference,
  prepareCoveragePaymentTransaction,
} from '../solana/coverage-payment-transaction.ts'
import type {
  CoveragePaymentPreparationRpc,
  CoveragePaymentTransactionPreview,
  PreparedCoveragePaymentTransaction,
} from '../solana/coverage-payment-transaction.ts'

import type { EmberLifecycleProvider } from './cover-service.ts'
import { emberLifecycleStore } from './ember-lifecycle-store.ts'
import { stringifyWithBigInts } from './safe-json.ts'
import {
  explorerTransactionUrl,
  walletClusterConfig,
} from './wallet-data-config.ts'
import type { WalletCluster } from './wallet-data-config.ts'

const STORE_KEY = 'local:ember-coverage-payment:v3' as const

type RpcSend<T> = { send(): Promise<T> }
type RpcValue<T> = Readonly<{ value: T }>
type SignatureStatus = Readonly<{
  confirmationStatus?: string | null
  err?: unknown | null
}>

export interface CoveragePaymentRpc extends CoveragePaymentPreparationRpc {
  isBlockhashValid(
    blockhash: string,
    config?: Readonly<{ commitment: 'confirmed' }>,
  ): RpcSend<RpcValue<boolean>>
  sendTransaction(
    transaction: Base64EncodedWireTransaction,
    config: Readonly<{
      encoding: 'base64'
      maxRetries: number
      preflightCommitment: 'confirmed'
    }>,
  ): RpcSend<Signature>
  getSignatureStatuses(
    signatures: readonly Signature[],
    config?: Readonly<{ searchTransactionHistory: boolean }>,
  ): RpcSend<RpcValue<readonly (SignatureStatus | null)[]>>
}

export interface CoveragePaymentSigner {
  getAddress(): Promise<string | null>
  sign(message: Uint8Array): Promise<Uint8Array>
}

export interface CoverageOfferView {
  aggregateLimitMicros: string
  benefitPeriodCount: number
  benefitPeriodLimitMicros: string
  coverageDurationDays: number
  coverageDurationMonths: number
  coveredTransactionLimit: number
  deductibleMicros: string
  displayName: string
  offerId: string
  offerVersion: number
  paymentAsset: string
  paymentAssetDecimals: number
  perLossLimitMicros: string
  priceBaseUnits: string
  termsSha256: string
  termsVersion: string
  waitingPeriodDays: number
}

export interface CoveragePaymentInput {
  acceptedTerms: boolean
  cluster: WalletCluster
  offerId: string
}

export type CoveragePaymentPreview = CoveragePaymentTransactionPreview

export type CoveragePaymentStatus =
  | 'quote_ready'
  | 'broadcast_pending'
  | 'activation_pending'
  | 'active'
  | 'rejected'
  | 'failed_recoverable'
  | 'expired_unconfirmed'

export interface LocalCoveragePaymentState {
  version: 3
  blockhash: string | null
  cluster: WalletCluster
  coverageEndsAt: string | null
  lastError: string | null
  lastUpdatedAt: string
  lastValidBlockHeight: string | null
  offer: AvailableOfferResponse
  payment: PaymentResponse | null
  paymentSignature: string | null
  quote: SignedQuoteResponse
  signedTransactionBase64: string | null
  status: CoveragePaymentStatus
  walletAddress: string
}

export interface CoveragePaymentResult {
  coverActive: boolean
  explorerUrl: string | null
  state: LocalCoveragePaymentState
}

export interface CoveragePaymentUI {
  offers(): Promise<CoverageOfferView[]>
  previewPayment(input: CoveragePaymentInput): Promise<CoveragePaymentPreview>
  activatePayment(quoteId: string): Promise<CoveragePaymentResult>
  localPayment(walletAddress?: string): Promise<LocalCoveragePaymentState | null>
  syncPayment(walletAddress?: string): Promise<CoveragePaymentResult | null>
}

interface ProviderDependencies {
  config?: EmberRuntimeConfig
  now?: () => number
  rpcFactory?: (cluster: WalletCluster) => CoveragePaymentRpc
  statusAttempts?: number
}

interface PreparedPayment extends PreparedCoveragePaymentTransaction {
  rpc: CoveragePaymentRpc
}

function createPaymentRpc(cluster: WalletCluster): CoveragePaymentRpc {
  return createSolanaRpc(walletClusterConfig(cluster).rpcUrl) as unknown as CoveragePaymentRpc
}

function offerView(offer: AvailableOfferResponse): CoverageOfferView {
  return {
    aggregateLimitMicros: offer.aggregateLimitMicros,
    benefitPeriodCount: offer.benefitPeriodCount,
    benefitPeriodLimitMicros: offer.benefitPeriodLimitMicros,
    coverageDurationDays: offer.coverageDurationDays,
    coverageDurationMonths: offer.coverageDurationMonths,
    coveredTransactionLimit: offer.coveredTransactionLimit,
    deductibleMicros: offer.deductibleMicros,
    displayName: offer.displayName,
    offerId: offer.offerId,
    offerVersion: offer.offerVersion,
    paymentAsset: offer.paymentAsset,
    paymentAssetDecimals: offer.paymentAssetDecimals,
    perLossLimitMicros: offer.perLossLimitMicros,
    priceBaseUnits: offer.priceBaseUnits,
    termsSha256: offer.termsSha256,
    termsVersion: offer.termsVersion,
    waitingPeriodDays: offer.waitingPeriodDays,
  }
}

export { bindQuoteReference }

export class CoveragePaymentProvider implements CoveragePaymentUI {
  private readonly config: EmberRuntimeConfig
  private readonly cover: EmberLifecycleProvider
  private readonly now: () => number
  private readonly rpcFactory: (cluster: WalletCluster) => CoveragePaymentRpc
  private readonly signer: CoveragePaymentSigner
  private readonly statusAttempts: number

  constructor(
    signer: CoveragePaymentSigner,
    cover: EmberLifecycleProvider,
    dependencies: ProviderDependencies = {},
  ) {
    this.cover = cover
    this.config = dependencies.config ?? EMBER_CONFIG
    this.signer = signer
    this.now = dependencies.now ?? Date.now
    this.rpcFactory = dependencies.rpcFactory ?? createPaymentRpc
    this.statusAttempts = dependencies.statusAttempts ?? 2
  }

  async offers(): Promise<CoverageOfferView[]> {
    const client = await this.requireClient()
    return (await client.listOffers()).offers.map(offerView)
  }

  async previewPayment(input: CoveragePaymentInput): Promise<CoveragePaymentPreview> {
    if (!input.acceptedTerms) {
      throw new Error('Confirm that you accept the exact offer terms before creating a quote')
    }
    if (input.cluster !== this.config.expectedCluster) {
      throw new Error(
        `This Ember build is bound to ${this.config.expectedCluster}, not ${input.cluster}`,
      )
    }
    const client = await this.requireClient()
    const walletAddress = await this.requireWalletAddress()
    const offer = await client.getOffer(input.offerId)
    await client.acceptTerms({
      documentSha256: offer.termsSha256,
      offerId: offer.offerId,
      offerVersion: offer.offerVersion,
      termsVersion: offer.termsVersion,
    })
    const quote = await client.createQuote({ offerId: offer.offerId })
    const prepared = await this.prepare(quote, walletAddress)
    await this.save({
      version: 3,
      blockhash: prepared.blockhash,
      cluster: input.cluster,
      coverageEndsAt: null,
      lastError: null,
      lastUpdatedAt: new Date(this.now()).toISOString(),
      lastValidBlockHeight: prepared.lastValidBlockHeight.toString(),
      offer,
      payment: null,
      paymentSignature: null,
      quote,
      signedTransactionBase64: null,
      status: 'quote_ready',
      walletAddress,
    })
    return prepared.preview
  }

  async activatePayment(quoteId: string): Promise<CoveragePaymentResult> {
    const state = await this.requireState()
    if (state.quote.payload.quoteId !== quoteId) {
      throw new Error('The reviewed quote is no longer current')
    }
    if (state.paymentSignature || state.signedTransactionBase64) {
      throw new Error('This quote already has a signed payment; use recovery instead')
    }
    const client = await this.requireClient()
    await client.verifyQuote(state.quote)
    const prepared = await this.prepare(state.quote, state.walletAddress)
    if (prepared.preview.simulation.status !== 'success') {
      throw new Error('Payment simulation failed. Nothing was signed or sent.')
    }
    const signed = await signTransactionMessageWithSigners(prepared.transactionMessage)
    const signedTransactionBase64 = String(getBase64EncodedWireTransaction(signed))
    const paymentSignature = String(getSignatureFromTransaction(signed))
    let next = await this.save({
      ...state,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight.toString(),
      lastUpdatedAt: new Date(this.now()).toISOString(),
      paymentSignature,
      signedTransactionBase64,
      status: 'broadcast_pending',
    })
    try {
      await this.broadcast(prepared.rpc, paymentSignature, signedTransactionBase64)
    } catch (error) {
      await this.update(next, {
        lastError: `Signed payment saved; broadcast needs recovery: ${String(error)}`,
        status: 'failed_recoverable',
      })
      throw new Error('Payment was signed and saved but not broadcast. Use recovery; do not pay again.')
    }
    next = await this.update(next, {
      lastError: null,
      status: 'activation_pending',
    })
    return await this.registerAndRefresh(client, next)
  }

  async localPayment(walletAddress?: string): Promise<LocalCoveragePaymentState | null> {
    const value = await storage.getItem<LocalCoveragePaymentState>(STORE_KEY)
    if (!value || value.version !== 3) return null
    const currentWallet = walletAddress ?? (await this.signer.getAddress())
    return currentWallet && currentWallet === value.walletAddress ? value : null
  }

  async syncPayment(walletAddress?: string): Promise<CoveragePaymentResult | null> {
    let state = await this.localPayment(walletAddress)
    if (!state) return null
    if (!state.paymentSignature || !state.signedTransactionBase64) {
      if (this.now() >= Date.parse(state.quote.payload.validity.expiresAt)) {
        state = await this.update(state, {
          lastError: 'The unpaid quote expired. Review a new server-signed quote.',
          status: 'expired_unconfirmed',
        })
      }
      return this.result(state)
    }
    const client = await this.requireClient()
    const rpc = this.rpcFactory(state.cluster)
    const statuses = await rpc
      .getSignatureStatuses([state.paymentSignature as Signature], {
        searchTransactionHistory: true,
      })
      .send()
    const signatureStatus = statuses.value[0]
    if (signatureStatus?.err) {
      state = await this.update(state, {
        lastError: `Payment failed on chain: ${stringifyWithBigInts(signatureStatus.err)}`,
        status: 'rejected',
      })
      return this.result(state)
    }
    if (!signatureStatus) {
      if (!state.blockhash) {
        return this.result(
          await this.update(state, {
            lastError: 'The saved payment blockhash is unavailable',
            status: 'failed_recoverable',
          }),
        )
      }
      const valid = (
        await rpc.isBlockhashValid(state.blockhash, { commitment: 'confirmed' }).send()
      ).value
      if (!valid) {
        return this.result(
          await this.update(state, {
            lastError: 'The signed payment did not land before its blockhash expired',
            status: 'expired_unconfirmed',
          }),
        )
      }
      await this.broadcast(rpc, state.paymentSignature, state.signedTransactionBase64)
    }
    state = await this.update(state, {
      lastError: null,
      status: 'activation_pending',
    })
    return await this.registerAndRefresh(client, state)
  }

  private async prepare(
    quote: SignedQuoteResponse,
    walletAddress: string,
  ): Promise<PreparedPayment> {
    const expectedGenesisHash = this.config.expectedGenesisHash
    const contract = validateCoveragePaymentContract(quote, {
      environment: this.config.environment,
      expectedCluster: this.config.expectedCluster,
      expectedGenesisHash,
      nowMs: this.now(),
      walletAddress,
    })
    if (!expectedGenesisHash) {
      throw new Error('The wallet build has no expected Solana genesis hash')
    }
    const cluster = this.config.expectedCluster
    const rpc = this.rpcFactory(cluster)
    const prepared = await prepareCoveragePaymentTransaction({
      cluster,
      contract,
      expectedGenesisHash,
      rpc,
      signMessage: (message) => this.signer.sign(message),
      walletAddress,
    })
    return {
      ...prepared,
      rpc,
    }
  }

  private async broadcast(
    rpc: CoveragePaymentRpc,
    expectedSignature: string,
    transaction: string,
  ): Promise<void> {
    const returned = await rpc
      .sendTransaction(transaction as Base64EncodedWireTransaction, {
        encoding: 'base64',
        maxRetries: 3,
        preflightCommitment: 'confirmed',
      })
      .send()
    if (String(returned) !== expectedSignature) {
      throw new Error('RPC returned an unexpected payment signature')
    }
  }

  private async registerAndRefresh(
    client: EmberWalletClient,
    state: LocalCoveragePaymentState,
  ): Promise<CoveragePaymentResult> {
    const paymentSignature = state.paymentSignature
    if (!paymentSignature) throw new Error('Signed payment is unavailable')
    let payment =
      state.payment ??
      (await client.createPayment(
        {
          paymentSignature,
          quoteId: state.quote.payload.quoteId,
        },
        { idempotencyKey: `payment-${state.quote.payload.quoteId}` },
      ))
    for (let attempt = 1; attempt < this.statusAttempts && payment.status === 'pending'; attempt += 1) {
      payment = await client.getPayment(payment.paymentId)
    }
    let coverage = null
    if (payment.coverageInstanceId) {
      coverage = await client.getCoverageInstance(payment.coverageInstanceId)
    }
    await emberLifecycleStore.recordPayment(state.walletAddress, payment, coverage)
    const next = await this.update(state, {
      coverageEndsAt: coverage?.coverageEndsAt ?? null,
      lastError:
        payment.status === 'activated'
          ? null
          : `Ember payment status: ${payment.status}`,
      payment,
      status:
        payment.status === 'activated'
          ? 'active'
          : payment.status === 'rejected' || payment.status === 'inconsistent'
            ? 'rejected'
            : 'activation_pending',
    })
    return this.result(next)
  }

  private async requireClient(): Promise<EmberWalletClient> {
    const client = await this.cover.activeClient()
    if (!client) throw new Error('Connect or renew the Ember session first')
    return client
  }

  private async requireWalletAddress(): Promise<string> {
    const walletAddress = await this.signer.getAddress()
    if (!walletAddress) throw new Error('No wallet')
    return walletAddress
  }

  private async requireState(): Promise<LocalCoveragePaymentState> {
    const state = await this.localPayment()
    if (!state) throw new Error('No reviewed Ember quote is available')
    return state
  }

  private result(state: LocalCoveragePaymentState): CoveragePaymentResult {
    return {
      coverActive: state.status === 'active',
      explorerUrl: state.paymentSignature
        ? explorerTransactionUrl(state.paymentSignature, state.cluster)
        : null,
      state,
    }
  }

  private async save(
    state: LocalCoveragePaymentState,
  ): Promise<LocalCoveragePaymentState> {
    await storage.setItem(STORE_KEY, state)
    return state
  }

  private async update(
    state: LocalCoveragePaymentState,
    updates: Partial<
      Pick<
        LocalCoveragePaymentState,
        'coverageEndsAt' | 'lastError' | 'payment' | 'status'
      >
    >,
  ): Promise<LocalCoveragePaymentState> {
    return await this.save({
      ...state,
      ...updates,
      lastUpdatedAt: new Date(this.now()).toISOString(),
    })
  }
}

const COVERAGE_PAYMENT_SERVICE_KEY =
  'ember.CoveragePaymentService' as ProxyServiceKey<CoveragePaymentUI>

export function registerCoveragePaymentService(provider: CoveragePaymentUI): void {
  const facade: CoveragePaymentUI = {
    offers: () => provider.offers(),
    previewPayment: (input) => provider.previewPayment(input),
    activatePayment: (quoteId) => provider.activatePayment(quoteId),
    localPayment: (walletAddress) => provider.localPayment(walletAddress),
    syncPayment: (walletAddress) => provider.syncPayment(walletAddress),
  }
  registerService(COVERAGE_PAYMENT_SERVICE_KEY, facade)
}

export function getCoveragePaymentService(): ProxyService<CoveragePaymentUI> {
  return createProxyService<CoveragePaymentUI>(COVERAGE_PAYMENT_SERVICE_KEY)
}
