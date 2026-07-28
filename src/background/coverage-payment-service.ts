import type {
  AvailableOfferResponse,
  EmberWalletClient,
  PaymentResponse,
  SignedQuoteResponse,
} from '@embercover/wallet-sdk'
import {
  AccountRole,
  address as toAddress,
  appendTransactionMessageInstruction,
  blockhash as toBlockhash,
  compileTransaction,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit'
import type {
  Address,
  Base64EncodedWireTransaction,
  Signature,
  SignatureBytes,
  Transaction,
  TransactionSigner,
  Instruction,
} from '@solana/kit'
import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
} from '@solana-program/token'
import { createProxyService, registerService } from '@webext-core/proxy-service'
import type { ProxyService, ProxyServiceKey } from '@webext-core/proxy-service'
import { storage } from 'wxt/utils/storage'

import { EMBER_CONFIG } from '../cover/ember-config.ts'
import type { EmberRuntimeConfig } from '../cover/ember-config.ts'

import type { EmberLifecycleProvider } from './cover-service.ts'
import { emberLifecycleStore } from './ember-lifecycle-store.ts'
import { stringifyWithBigInts } from './safe-json.ts'
import {
  explorerTransactionUrl,
  walletClusterConfig,
} from './wallet-data-config.ts'
import type { WalletCluster } from './wallet-data-config.ts'

const STORE_KEY = 'local:ember-coverage-payment:v3' as const
const CLASSIC_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const DEFAULT_FEE_LAMPORTS = 5_000n

type RpcSend<T> = { send(): Promise<T> }
type RpcValue<T> = Readonly<{ value: T }>
type LatestBlockhashValue = Readonly<{
  blockhash: string
  lastValidBlockHeight: bigint | number | string
}>
type SimulationValue = Readonly<{
  err: unknown | null
  fee?: bigint | number | string | null
  logs?: readonly string[] | null
}>
type TokenBalanceValue = Readonly<{
  amount: string
  decimals: number
  uiAmountString?: string
}>
type SignatureStatus = Readonly<{
  confirmationStatus?: string | null
  err?: unknown | null
}>

export interface CoveragePaymentRpc {
  getGenesisHash(): RpcSend<string>
  getBalance(
    address: Address,
    config?: Readonly<{ commitment: 'confirmed' }>,
  ): RpcSend<RpcValue<bigint | number | string>>
  getLatestBlockhash(
    config?: Readonly<{ commitment: 'confirmed' }>,
  ): RpcSend<RpcValue<LatestBlockhashValue>>
  getTokenAccountBalance(
    address: Address,
    config?: Readonly<{ commitment: 'confirmed' }>,
  ): RpcSend<RpcValue<TokenBalanceValue>>
  isBlockhashValid(
    blockhash: string,
    config?: Readonly<{ commitment: 'confirmed' }>,
  ): RpcSend<RpcValue<boolean>>
  simulateTransaction(
    transaction: Base64EncodedWireTransaction,
    config: Readonly<{
      commitment: 'confirmed'
      encoding: 'base64'
      replaceRecentBlockhash: false
      sigVerify: false
    }>,
  ): RpcSend<RpcValue<SimulationValue>>
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
  coverageDurationDays: number
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

export interface CoveragePaymentPreview {
  amountBaseUnits: string
  amountDisplay: string
  asset: string
  cluster: WalletCluster
  durationDays: number
  errors: string[]
  feeLamports: string
  offerId: string
  offerVersion: number
  quoteExpiresAt: string
  quoteId: string
  quoteReference: string
  simulation: {
    status: 'success' | 'failure'
    error: string | null
    logs: string[]
  }
  solBalanceLamports: string
  sourceTokenAccount: string
  termsSha256: string
  termsVersion: string
  tokenBalanceBaseUnits: string
  tokenMint: string
  tokenProgram: string
  treasuryOwner: string
  treasuryTokenAccount: string
  walletAddress: string
}

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

interface PreparedPayment {
  blockhash: string
  lastValidBlockHeight: bigint
  preview: CoveragePaymentPreview
  rpc: CoveragePaymentRpc
  transactionMessage: Parameters<typeof signTransactionMessageWithSigners>[0]
}

function createPaymentRpc(cluster: WalletCluster): CoveragePaymentRpc {
  return createSolanaRpc(walletClusterConfig(cluster).rpcUrl) as unknown as CoveragePaymentRpc
}

function toBigInt(value: bigint | number | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value)
}

function displayBaseUnits(value: string, decimals: number): string {
  const amount = BigInt(value)
  const divisor = 10n ** BigInt(decimals)
  const whole = amount / divisor
  const fraction = (amount % divisor).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

function createVaultTransactionSigner(
  walletAddress: string,
  sign: (message: Uint8Array) => Promise<Uint8Array>,
): TransactionSigner {
  const signerAddress = toAddress(walletAddress)
  return {
    address: signerAddress,
    signTransactions: async (transactions: readonly Transaction[]) =>
      await Promise.all(
        transactions.map(async (transaction) => ({
          [signerAddress]: (await sign(new Uint8Array(transaction.messageBytes))) as SignatureBytes,
        })),
      ),
  }
}

function offerView(offer: AvailableOfferResponse): CoverageOfferView {
  return {
    aggregateLimitMicros: offer.aggregateLimitMicros,
    coverageDurationDays: offer.coverageDurationDays,
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

/** Add the server-issued quote reference as a static read-only non-signer account. */
export function bindQuoteReference(
  instruction: Instruction,
  reference: Address,
): Instruction {
  return {
    ...instruction,
    accounts: [
      ...(instruction.accounts ?? []),
      {
        address: reference,
        role: AccountRole.READONLY,
      },
    ],
  }
}

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
    const payload = quote.payload
    const payment = payload.payment
    if (
      payload.mode !== 'live' ||
      !payload.paymentAllowed ||
      !payload.createsCoverage ||
      payload.offer.environment !== 'production'
    ) {
      throw new Error('This verified quote is non-payable test data')
    }
    if (
      payload.protectedWallet !== walletAddress ||
      payload.payerWallet !== walletAddress
    ) {
      throw new Error('The quote is bound to a different wallet')
    }
    if (
      payload.offer.cluster !== this.config.expectedCluster ||
      this.config.expectedCluster !== 'mainnet-beta'
    ) {
      throw new Error('Live Ember payments require the Mainnet-bound wallet build')
    }
    if (
      !this.config.expectedGenesisHash ||
      payment.genesisHash !== this.config.expectedGenesisHash
    ) {
      throw new Error('The quote is not bound to the expected Mainnet genesis hash')
    }
    if (payment.tokenProgram !== CLASSIC_TOKEN_PROGRAM) {
      throw new Error('The quote does not use the supported classic SPL Token program')
    }
    if (!payment.treasuryOwner) {
      throw new Error('The quote does not name the treasury owner')
    }
    if (this.now() >= Date.parse(payload.validity.expiresAt)) {
      throw new Error('The server-signed quote expired; request a fresh quote')
    }

    const cluster: WalletCluster = 'mainnet-beta'
    const rpc = this.rpcFactory(cluster)
    const genesisHash = await rpc.getGenesisHash().send()
    if (
      genesisHash !== payment.genesisHash ||
      genesisHash !== this.config.expectedGenesisHash
    ) {
      throw new Error('Connected RPC is not Solana Mainnet')
    }
    const wallet = toAddress(walletAddress)
    const tokenProgram = toAddress(payment.tokenProgram)
    const mint = toAddress(payment.mint)
    const signer = createVaultTransactionSigner(walletAddress, (message) =>
      this.signer.sign(message),
    )
    const [sourceTokenAccount] = await findAssociatedTokenPda({
      mint,
      owner: wallet,
      tokenProgram,
    })
    const [balance, tokenBalance, latestBlockhash] = await Promise.all([
      rpc.getBalance(wallet, { commitment: 'confirmed' }).send(),
      rpc.getTokenAccountBalance(sourceTokenAccount, { commitment: 'confirmed' }).send(),
      rpc.getLatestBlockhash({ commitment: 'confirmed' }).send(),
    ])
    const errors: string[] = []
    if (tokenBalance.value.decimals !== payment.decimals) {
      errors.push('Source token account decimals do not match the signed quote')
    }
    if (BigInt(tokenBalance.value.amount) < BigInt(payment.amount)) {
      errors.push(`Not enough ${payload.offer.paymentAsset} for the quoted payment`)
    }
    const transfer = getTransferCheckedInstruction(
      {
        amount: BigInt(payment.amount),
        authority: signer,
        decimals: payment.decimals,
        destination: toAddress(payment.treasuryTokenAccount),
        mint,
        source: sourceTokenAccount,
      },
      { programAddress: tokenProgram },
    )
    const quoteBoundTransfer = bindQuoteReference(
      transfer,
      toAddress(payment.reference),
    )
    const blockhash = latestBlockhash.value.blockhash
    const lastValidBlockHeight = toBigInt(latestBlockhash.value.lastValidBlockHeight)
    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayerSigner(signer, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: toBlockhash(blockhash),
            lastValidBlockHeight,
          },
          message,
        ),
      (message) => appendTransactionMessageInstruction(quoteBoundTransfer, message),
    ) as PreparedPayment['transactionMessage']
    let simulation: CoveragePaymentPreview['simulation'] = {
      status: 'failure',
      error: errors[0] ?? 'Payment preconditions failed',
      logs: [],
    }
    let feeLamports = DEFAULT_FEE_LAMPORTS
    if (errors.length === 0) {
      const unsigned = getBase64EncodedWireTransaction(compileTransaction(transactionMessage))
      const response = await rpc
        .simulateTransaction(unsigned, {
          commitment: 'confirmed',
          encoding: 'base64',
          replaceRecentBlockhash: false,
          sigVerify: false,
        })
        .send()
      feeLamports =
        response.value.fee == null ? DEFAULT_FEE_LAMPORTS : toBigInt(response.value.fee)
      const error = response.value.err
        ? stringifyWithBigInts(response.value.err)
        : null
      if (error) errors.push(`Simulation failed: ${error}`)
      simulation = {
        status: error ? 'failure' : 'success',
        error,
        logs: [...(response.value.logs ?? [])],
      }
    }
    if (toBigInt(balance.value) < feeLamports) {
      errors.push('Not enough SOL for the network fee')
      simulation = {
        status: 'failure',
        error: 'Not enough SOL for the network fee',
        logs: simulation.logs,
      }
    }
    return {
      blockhash,
      lastValidBlockHeight,
      preview: {
        amountBaseUnits: payment.amount,
        amountDisplay: displayBaseUnits(payment.amount, payment.decimals),
        asset: payload.offer.paymentAsset,
        cluster,
        durationDays: payload.offer.coverageDurationDays,
        errors,
        feeLamports: feeLamports.toString(),
        offerId: payload.offer.offerId,
        offerVersion: payload.offer.offerVersion,
        quoteExpiresAt: payload.validity.expiresAt,
        quoteId: payload.quoteId,
        quoteReference: payment.reference,
        simulation,
        solBalanceLamports: String(balance.value),
        sourceTokenAccount: String(sourceTokenAccount),
        termsSha256: payload.offer.termsHash,
        termsVersion: payload.offer.termsVersion,
        tokenBalanceBaseUnits: tokenBalance.value.amount,
        tokenMint: payment.mint,
        tokenProgram: payment.tokenProgram,
        treasuryOwner: payment.treasuryOwner,
        treasuryTokenAccount: payment.treasuryTokenAccount,
        walletAddress,
      },
      rpc,
      transactionMessage,
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
          : `Ember payment status: ${payment.status} (${payment.outcomeCode})`,
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
