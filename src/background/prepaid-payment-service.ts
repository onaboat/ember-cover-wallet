import {
  address as toAddress,
  appendTransactionMessageInstruction,
  blockhash as toBlockhash,
  compileTransaction,
  createSolanaRpc,
  createTransactionMessage,
  devnet,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
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
} from '@solana/kit'
import { findAssociatedTokenPda, getTransferCheckedInstruction } from '@solana-program/token'
import { createProxyService, registerService } from '@webext-core/proxy-service'
import type { ProxyService, ProxyServiceKey } from '@webext-core/proxy-service'
import { storage } from 'wxt/utils/storage'

import type { CoverProvider } from './cover-service.ts'
import { formatUsdcBaseUnits, prepaidPaymentConfig } from './prepaid-payment-config.ts'
import { stringifyWithBigInts } from './safe-json.ts'
import { explorerTransactionUrl, walletClusterConfig } from './wallet-data-config.ts'
import type { WalletCluster } from './wallet-data-config.ts'
import { coverPeriodExpired, coverStatusActive } from '../cover/ember-types.ts'

type RpcSend<T> = { send(): Promise<T> }
type RpcValue<T> = Readonly<{ value: T }>

type LatestBlockhashValue = Readonly<{
  blockhash: string
  lastValidBlockHeight: bigint | number | string
}>

type SimulateValue = Readonly<{
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

export interface PaymentRpcClient {
  getBalance(address: Address, config?: Readonly<{ commitment: 'confirmed' }>): RpcSend<RpcValue<bigint | number | string>>
  isBlockhashValid(
    blockhash: string,
    config?: Readonly<{ commitment: 'confirmed' }>,
  ): RpcSend<RpcValue<boolean>>
  getLatestBlockhash(config?: Readonly<{ commitment: 'confirmed' }>): RpcSend<RpcValue<LatestBlockhashValue>>
  getTokenAccountBalance(
    address: Address,
    config?: Readonly<{ commitment: 'confirmed' }>,
  ): RpcSend<RpcValue<TokenBalanceValue>>
  simulateTransaction(
    transaction: Base64EncodedWireTransaction,
    config: Readonly<{
      commitment: 'confirmed'
      encoding: 'base64'
      replaceRecentBlockhash: false
      sigVerify: false
    }>,
  ): RpcSend<RpcValue<SimulateValue>>
  sendTransaction(
    transaction: Base64EncodedWireTransaction,
    config: Readonly<{ encoding: 'base64'; maxRetries: number; preflightCommitment: 'confirmed' }>,
  ): RpcSend<Signature>
  getSignatureStatuses(
    signatures: readonly Signature[],
    config?: Readonly<{ searchTransactionHistory: boolean }>,
  ): RpcSend<RpcValue<readonly (SignatureStatus | null)[]>>
}

export interface PrepaidPaymentSigner {
  getAddress(): Promise<string | null>
  sign(message: Uint8Array): Promise<Uint8Array>
}

export interface PrepaidPaymentInput {
  cluster: WalletCluster
}

export type PrepaidPaymentStatus =
  | 'broadcast_pending'
  | 'confirmation_pending'
  | 'activation_pending'
  | 'active'
  | 'failed_recoverable'
  | 'expired_unconfirmed'

export interface PrepaidPaymentPreview {
  amountBaseUnits: string
  amountUsdc: string
  cluster: WalletCluster
  feeLamports: string
  periodDays: number
  simulation: {
    status: 'not_run' | 'success' | 'failure'
    error: string | null
    logs: string[]
  }
  solBalanceLamports: string
  tier: string
  tokenMint: string
  tokenProgram: string
  treasuryTokenAccount: string
  userUsdcAta: string
  usdcBalance: string
  usdcShortfall: string | null
  walletAddress: string
  errors: string[]
}

export interface LocalPrepaidPaymentState {
  version: 1 | 2
  amountBaseUnits: string
  blockhash?: string
  cluster: WalletCluster
  currentPeriodEnd?: string
  lastValidBlockHeight?: string
  lastError?: string
  lastUpdatedAt: string
  paymentSignature: string
  signedTransactionBase64: string
  status: PrepaidPaymentStatus
  tier: string
  tokenMint: string
  treasuryTokenAccount: string
  walletAddress: string
}

export interface PrepaidPaymentResult {
  activationError: string | null
  apiCoverActive: boolean
  explorerUrl: string
  signature: string
  state: LocalPrepaidPaymentState
}

export interface PrepaidPaymentUI {
  previewPayment(input: PrepaidPaymentInput): Promise<PrepaidPaymentPreview>
  activatePayment(input: PrepaidPaymentInput): Promise<PrepaidPaymentResult>
  localPayment(walletAddress?: string): Promise<LocalPrepaidPaymentState | null>
  syncPayment(walletAddress?: string): Promise<PrepaidPaymentResult | null>
}

interface PrepaidPaymentProviderDeps {
  confirmationAttempts?: number
  confirmationIntervalMs?: number
  now?: () => number
  rpcFactory?: (cluster: WalletCluster) => PaymentRpcClient
  sleep?: (milliseconds: number) => Promise<void>
}

const LOCAL_PAYMENT_KEY = 'local:ember-cover-prepaid-payment:v1' as const
const DEFAULT_FEE_LAMPORTS = 5_000n

type PaymentTransactionMessage = Parameters<typeof signTransactionMessageWithSigners>[0]
type PreparedPaymentStateSource = {
  blockhash: string
  config: ReturnType<typeof prepaidPaymentConfig>
  lastValidBlockHeight: bigint
  preview: PrepaidPaymentPreview
}

function createPaymentRpc(cluster: WalletCluster): PaymentRpcClient {
  const config = walletClusterConfig(cluster)
  const url = cluster === 'devnet' ? devnet(config.rpcUrl) : config.rpcUrl
  return createSolanaRpc(url) as unknown as PaymentRpcClient
}

function toBigInt(value: bigint | number | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value)
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

function accountMissing(error: unknown): boolean {
  const message = String(error).toLowerCase()
  return message.includes('could not find account') || message.includes('account not found')
}

async function tokenBalance(rpc: PaymentRpcClient, ata: Address): Promise<TokenBalanceValue | null> {
  try {
    return (await rpc.getTokenAccountBalance(ata, { commitment: 'confirmed' }).send()).value
  } catch (error) {
    if (accountMissing(error)) {
      return null
    }
    throw error
  }
}

function transactionFailure(error: unknown): Error {
  return new Error(`Payment transaction failed: ${stringifyWithBigInts(error)}`)
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function savedTransactionBlockhash(state: LocalPrepaidPaymentState): string | null {
  if (state.blockhash) {
    return state.blockhash
  }
  try {
    const transaction = getTransactionDecoder().decode(decodeBase64(state.signedTransactionBase64))
    return String(getCompiledTransactionMessageDecoder().decode(transaction.messageBytes).lifetimeToken)
  } catch {
    return null
  }
}

export class PrepaidPaymentProvider implements PrepaidPaymentUI {
  #confirmationAttempts: number
  #confirmationIntervalMs: number
  #cover: CoverProvider | undefined
  #now: () => number
  #rpcFactory: (cluster: WalletCluster) => PaymentRpcClient
  #signer: PrepaidPaymentSigner
  #sleep: (milliseconds: number) => Promise<void>

  constructor(signer: PrepaidPaymentSigner, cover?: CoverProvider, deps: PrepaidPaymentProviderDeps = {}) {
    this.#confirmationAttempts = deps.confirmationAttempts ?? 12
    this.#confirmationIntervalMs = deps.confirmationIntervalMs ?? 1_000
    this.#cover = cover
    this.#now = deps.now ?? Date.now
    this.#rpcFactory = deps.rpcFactory ?? createPaymentRpc
    this.#signer = signer
    this.#sleep = deps.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  }

  async previewPayment(input: PrepaidPaymentInput): Promise<PrepaidPaymentPreview> {
    return (await this.#prepare(input)).preview
  }

  async localPayment(walletAddress?: string): Promise<LocalPrepaidPaymentState | null> {
    const state = await storage.getItem<LocalPrepaidPaymentState>(LOCAL_PAYMENT_KEY)
    if (!state) {
      return null
    }
    const activeWalletAddress = walletAddress ?? (await this.#signer.getAddress())
    return activeWalletAddress && state.walletAddress === activeWalletAddress ? state : null
  }

  async activatePayment(input: PrepaidPaymentInput): Promise<PrepaidPaymentResult> {
    const walletAddress = await this.#signer.getAddress()
    if (!walletAddress) {
      throw new Error('No wallet')
    }
    await this.#assertCanStartPayment(walletAddress)
    const prepared = await this.#prepare(input)
    if (prepared.preview.errors.length > 0) {
      throw new Error(prepared.preview.errors[0])
    }
    if (prepared.preview.simulation.status !== 'success') {
      throw new Error('Payment simulation failed. No transaction was signed or sent.')
    }

    const signedTransaction = await signTransactionMessageWithSigners(prepared.transactionMessage)
    const signedTransactionBase64 = String(getBase64EncodedWireTransaction(signedTransaction))
    const signature = String(getSignatureFromTransaction(signedTransaction))
    let state = await this.#saveState({
      prepared,
      signature,
      signedTransactionBase64,
      status: 'broadcast_pending',
    })

    try {
      const returnedSignature = await prepared.rpc
        .sendTransaction(signedTransactionBase64 as Base64EncodedWireTransaction, {
          encoding: 'base64',
          maxRetries: 3,
          preflightCommitment: 'confirmed',
        })
        .send()
      if (String(returnedSignature) !== signature) {
        throw new Error('RPC returned an unexpected payment signature')
      }
      state = await this.#updateState(state, { status: 'confirmation_pending', lastError: undefined })
    } catch (error) {
      await this.#updateState(state, {
        status: 'failed_recoverable',
        lastError: `Broadcast failed: ${String(error)}`,
      })
      throw error
    }

    const confirmed = await this.#waitForConfirmation(prepared.rpc, signature as Signature)
    if (!confirmed) {
      state = await this.#updateState(state, {
        status: 'confirmation_pending',
        lastError: 'Payment submitted and is awaiting confirmation.',
      })
      return this.#result(state, false, state.lastError ?? null)
    }
    state = await this.#updateState(state, { status: 'activation_pending', lastError: undefined })
    return await this.#activateApi(state)
  }

  async syncPayment(walletAddress?: string): Promise<PrepaidPaymentResult | null> {
    let state = await this.localPayment(walletAddress)
    if (!state) {
      return null
    }
    if (state.status === 'active') {
      return await this.#reconcileActiveState(state)
    }

    const rpc = this.#rpcFactory(state.cluster)
    let confirmed = await this.#waitForConfirmation(rpc, state.paymentSignature as Signature)
    if (!confirmed && state.signedTransactionBase64) {
      const savedBlockhash = savedTransactionBlockhash(state)
      if (!savedBlockhash) {
        state = await this.#updateState(state, {
          status: 'failed_recoverable',
          lastError: 'The saved payment blockhash could not be verified. Do not submit another payment yet.',
        })
        return this.#result(state, false, state.lastError ?? null)
      }
      let blockhashValid: boolean
      try {
        blockhashValid = (
          await rpc
            .isBlockhashValid(savedBlockhash, { commitment: 'confirmed' })
            .send()
        ).value
      } catch {
        state = await this.#updateState(state, {
          status: 'failed_recoverable',
          lastError: 'The payment could not be checked on Devnet. Do not submit another payment yet.',
        })
        return this.#result(state, false, state.lastError ?? null)
      }
      if (!blockhashValid) {
        state = await this.#updateState(state, {
          status: 'expired_unconfirmed',
          lastError: 'The previous signed payment did not confirm and its blockhash has expired.',
        })
        return this.#result(state, false, state.lastError ?? null)
      }
      try {
        const returnedSignature = await rpc
          .sendTransaction(state.signedTransactionBase64 as Base64EncodedWireTransaction, {
            encoding: 'base64',
            maxRetries: 3,
            preflightCommitment: 'confirmed',
          })
          .send()
        if (String(returnedSignature) !== state.paymentSignature) {
          throw new Error('RPC returned an unexpected payment signature')
        }
        state = await this.#updateState(state, {
          status: 'confirmation_pending',
          lastError: undefined,
        })
        confirmed = await this.#waitForConfirmation(rpc, state.paymentSignature as Signature)
      } catch (error) {
        state = await this.#updateState(state, {
          status: 'failed_recoverable',
          lastError: `Retry failed: ${String(error)}`,
        })
        return this.#result(state, false, state.lastError ?? null)
      }
    }

    if (!confirmed) {
      state = await this.#updateState(state, {
        status: 'confirmation_pending',
        lastError: 'Payment is still awaiting confirmation.',
      })
      return this.#result(state, false, state.lastError ?? null)
    }
    state = await this.#updateState(state, { status: 'activation_pending', lastError: undefined })
    return await this.#activateApi(state)
  }

  async #assertCanStartPayment(walletAddress: string): Promise<void> {
    const state = await this.localPayment(walletAddress)
    if (!state || state.status === 'expired_unconfirmed') {
      return
    }
    if (state.status !== 'active') {
      throw new Error('A saved payment still needs recovery. Retry it before approving another payment.')
    }
    const snapshot = await this.#cover?.status()
    if (!snapshot) {
      throw new Error('Live cover status is unavailable. Check again before approving another payment.')
    }
    if (!coverStatusActive(snapshot, this.#now())) {
      return
    }
    throw new Error('Ember Cover is already active for this wallet.')
  }

  async #reconcileActiveState(state: LocalPrepaidPaymentState): Promise<PrepaidPaymentResult> {
    const snapshot = await this.#cover?.status()
    if (!snapshot) {
      return this.#result(state, false, 'Live cover status is unavailable.')
    }
    if (coverStatusActive(snapshot, this.#now())) {
      return this.#result(state, true, null)
    }
    if (coverPeriodExpired(snapshot, this.#now())) {
      return this.#result(state, false, 'Cover has expired. Review a new one-off payment to renew.')
    }
    return this.#result(state, false, 'Ember Cover is not active for this wallet.')
  }

  async #prepare(input: PrepaidPaymentInput) {
    const config = prepaidPaymentConfig()
    if (input.cluster !== config.cluster) {
      throw new Error('Ember one-off cover payments are currently available on Devnet only.')
    }
    const walletAddress = await this.#signer.getAddress()
    if (!walletAddress) {
      throw new Error('No wallet')
    }
    const wallet = toAddress(walletAddress)
    const walletSigner = createVaultTransactionSigner(walletAddress, (message) => this.#signer.sign(message))
    const rpc = this.#rpcFactory(input.cluster)
    const [userUsdcAta] = await findAssociatedTokenPda({
      mint: config.tokenMint,
      owner: wallet,
      tokenProgram: config.tokenProgram,
    })
    const [balanceResponse, tokenBalanceValue, latestBlockhashResponse] = await Promise.all([
      rpc.getBalance(wallet, { commitment: 'confirmed' }).send(),
      tokenBalance(rpc, userUsdcAta),
      rpc.getLatestBlockhash({ commitment: 'confirmed' }).send(),
    ])
    const solBalance = toBigInt(balanceResponse.value)
    const usdcBalance = tokenBalanceValue ? BigInt(tokenBalanceValue.amount) : 0n
    const errors: string[] = []
    if (tokenBalanceValue === null) {
      errors.push('This wallet does not have a Devnet USDC token account.')
    } else if (tokenBalanceValue.decimals !== config.decimals) {
      errors.push('The configured payment token does not use the expected 6 decimals.')
    } else if (usdcBalance < config.amountBaseUnits) {
      errors.push(`Not enough Devnet USDC. Add ${formatUsdcBaseUnits(config.amountBaseUnits - usdcBalance)} USDC.`)
    }

    const transferInstruction = getTransferCheckedInstruction(
      {
        amount: config.amountBaseUnits,
        authority: walletSigner,
        decimals: config.decimals,
        destination: config.treasuryTokenAccount,
        mint: config.tokenMint,
        source: userUsdcAta,
      },
      { programAddress: config.tokenProgram },
    )
    const paymentBlockhash = latestBlockhashResponse.value.blockhash
    const lastValidBlockHeight = toBigInt(latestBlockhashResponse.value.lastValidBlockHeight)
    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayerSigner(walletSigner, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: toBlockhash(paymentBlockhash),
            lastValidBlockHeight,
          },
          message,
        ),
      (message) => appendTransactionMessageInstruction(transferInstruction, message),
    ) as PaymentTransactionMessage
    let feeLamports = DEFAULT_FEE_LAMPORTS
    let simulation: PrepaidPaymentPreview['simulation'] = {
      status: 'not_run',
      error: null,
      logs: [],
    }
    if (errors.length === 0) {
      const unsignedBytes = getBase64EncodedWireTransaction(compileTransaction(transactionMessage))
      const simulationResponse = await rpc
        .simulateTransaction(unsignedBytes, {
          commitment: 'confirmed',
          encoding: 'base64',
          replaceRecentBlockhash: false,
          sigVerify: false,
        })
        .send()
      feeLamports =
        simulationResponse.value.fee == null ? DEFAULT_FEE_LAMPORTS : toBigInt(simulationResponse.value.fee)
      const simulationError = simulationResponse.value.err
        ? stringifyWithBigInts(simulationResponse.value.err)
        : null
      simulation = {
        status: simulationError ? 'failure' : 'success',
        error: simulationError,
        logs: [...(simulationResponse.value.logs ?? [])],
      }
    }
    if (solBalance < feeLamports) {
      errors.push('Not enough SOL for the network fee.')
      simulation = { status: 'not_run', error: null, logs: [] }
    }

    return {
      blockhash: paymentBlockhash,
      config,
      lastValidBlockHeight,
      preview: {
        amountBaseUnits: config.amountBaseUnits.toString(),
        amountUsdc: config.amountUsdc,
        cluster: input.cluster,
        errors,
        feeLamports: feeLamports.toString(),
        periodDays: config.periodDays,
        simulation,
        solBalanceLamports: solBalance.toString(),
        tier: config.tier,
        tokenMint: String(config.tokenMint),
        tokenProgram: String(config.tokenProgram),
        treasuryTokenAccount: String(config.treasuryTokenAccount),
        userUsdcAta: String(userUsdcAta),
        usdcBalance: formatUsdcBaseUnits(usdcBalance),
        usdcShortfall:
          usdcBalance < config.amountBaseUnits
            ? formatUsdcBaseUnits(config.amountBaseUnits - usdcBalance)
            : null,
        walletAddress,
      } satisfies PrepaidPaymentPreview,
      rpc,
      transactionMessage,
    }
  }

  async #waitForConfirmation(rpc: PaymentRpcClient, signature: Signature): Promise<boolean> {
    for (let attempt = 0; attempt < this.#confirmationAttempts; attempt += 1) {
      const response = await rpc
        .getSignatureStatuses([signature], { searchTransactionHistory: true })
        .send()
      const status = response.value[0]
      if (status?.err) {
        throw transactionFailure(status.err)
      }
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        return true
      }
      if (attempt + 1 < this.#confirmationAttempts) {
        await this.#sleep(this.#confirmationIntervalMs)
      }
    }
    return false
  }

  async #activateApi(state: LocalPrepaidPaymentState): Promise<PrepaidPaymentResult> {
    try {
      if (!this.#cover || !(await this.#cover.authorizeSession())) {
        throw new Error('Could not authorize the Ember API session')
      }
      const activation = await this.#cover.activatePaymentEntitlement?.({
        cluster: state.cluster,
        paymentSignature: state.paymentSignature,
      })
      if (!activation?.subscriptionActive) {
        throw new Error('The Ember API did not activate cover')
      }
      const periodEndMs = Date.parse(activation.currentPeriodEnd)
      if (Number.isNaN(periodEndMs) || periodEndMs <= this.#now()) {
        throw new Error('The Ember API returned an expired cover period')
      }
      const active = await this.#updateState(state, {
        currentPeriodEnd: activation.currentPeriodEnd,
        status: 'active',
        lastError: undefined,
        tier: activation.tier || state.tier,
      })
      return this.#result(active, true, null)
    } catch (error) {
      const pending = await this.#updateState(state, {
        status: 'activation_pending',
        lastError: String(error),
      })
      return this.#result(pending, false, pending.lastError ?? null)
    }
  }

  async #saveState(args: {
    prepared: PreparedPaymentStateSource
    signature: string
    signedTransactionBase64: string
    status: PrepaidPaymentStatus
  }): Promise<LocalPrepaidPaymentState> {
    const state: LocalPrepaidPaymentState = {
      version: 2,
      amountBaseUnits: args.prepared.config.amountBaseUnits.toString(),
      blockhash: args.prepared.blockhash,
      cluster: args.prepared.preview.cluster,
      lastValidBlockHeight: args.prepared.lastValidBlockHeight.toString(),
      lastUpdatedAt: new Date(this.#now()).toISOString(),
      paymentSignature: args.signature,
      signedTransactionBase64: args.signedTransactionBase64,
      status: args.status,
      tier: args.prepared.config.tier,
      tokenMint: String(args.prepared.config.tokenMint),
      treasuryTokenAccount: String(args.prepared.config.treasuryTokenAccount),
      walletAddress: args.prepared.preview.walletAddress,
    }
    await storage.setItem<LocalPrepaidPaymentState>(LOCAL_PAYMENT_KEY, state)
    return state
  }

  async #updateState(
    state: LocalPrepaidPaymentState,
    updates: {
      currentPeriodEnd?: string | undefined
      lastError?: string | undefined
      status?: PrepaidPaymentStatus | undefined
      tier?: string | undefined
    },
  ): Promise<LocalPrepaidPaymentState> {
    const next: LocalPrepaidPaymentState = {
      ...state,
      lastUpdatedAt: new Date(this.#now()).toISOString(),
    }
    if (updates.status !== undefined) {
      next.status = updates.status
    }
    if (updates.tier !== undefined) {
      next.tier = updates.tier
    }
    if (updates.currentPeriodEnd !== undefined) {
      next.currentPeriodEnd = updates.currentPeriodEnd
    }
    if (updates.lastError === undefined) {
      delete next.lastError
    } else {
      next.lastError = updates.lastError
    }
    await storage.setItem<LocalPrepaidPaymentState>(LOCAL_PAYMENT_KEY, next)
    return next
  }

  #result(
    state: LocalPrepaidPaymentState,
    apiCoverActive: boolean,
    activationError: string | null,
  ): PrepaidPaymentResult {
    return {
      activationError,
      apiCoverActive,
      explorerUrl: explorerTransactionUrl(state.paymentSignature, state.cluster),
      signature: state.paymentSignature,
      state,
    }
  }
}

const PREPAID_PAYMENT_SERVICE_KEY = 'ember.PrepaidPaymentService' as ProxyServiceKey<PrepaidPaymentUI>

export function registerPrepaidPaymentService(provider: PrepaidPaymentUI): void {
  const facade: PrepaidPaymentUI = {
    previewPayment: (input) => provider.previewPayment(input),
    activatePayment: (input) => provider.activatePayment(input),
    localPayment: (walletAddress) => provider.localPayment(walletAddress),
    syncPayment: (walletAddress) => provider.syncPayment(walletAddress),
  }
  registerService(PREPAID_PAYMENT_SERVICE_KEY, facade)
}

export function getPrepaidPaymentService(): ProxyService<PrepaidPaymentUI> {
  return createProxyService<PrepaidPaymentUI>(PREPAID_PAYMENT_SERVICE_KEY)
}
