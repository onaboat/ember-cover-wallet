import {
  address as toAddress,
  appendTransactionMessageInstruction,
  compileTransaction,
  createSolanaRpc,
  createTransactionMessage,
  devnet,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  blockhash as toBlockhash,
} from '@solana/kit'
import type {
  Address,
  Base64EncodedWireTransaction,
  Instruction,
  Signature,
  SignatureBytes,
  Transaction,
  TransactionSigner,
} from '@solana/kit'
import {
  findPlanPda,
  findSubscriptionAuthorityPda,
  findSubscriptionDelegationPda,
  fetchMaybePlan,
  fetchMaybeSubscriptionAuthority,
  getCancelSubscriptionOverlayInstructionAsync,
  getInitSubscriptionAuthorityOverlayInstructionAsync,
  getSubscribeOverlayInstructionAsync,
} from '@solana/subscriptions'
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from '@solana-program/token'
import { createProxyService, registerService } from '@webext-core/proxy-service'
import type { ProxyService, ProxyServiceKey } from '@webext-core/proxy-service'
import { storage } from 'wxt/utils/storage'

import type { CoverProvider } from './cover-service.ts'
import { stringifyWithBigInts } from './safe-json.ts'
import {
  EMBER_COVER_PLANS,
  resolveSubscriptionPlan,
  subscriptionRuntimeConfig,
} from './subscription-config.ts'
import type {
  EmberBillingPeriod,
  EmberCoverPlan,
  EmberCoverPlanId,
  ResolvedSubscriptionPlan,
  SubscriptionRuntimeConfig,
} from './subscription-config.ts'
import { explorerTransactionUrl, walletClusterConfig } from './wallet-data-config.ts'
import type { WalletCluster } from './wallet-data-config.ts'

type RpcSend<T> = { send(): Promise<T> }
type RpcValue<T> = Readonly<{ value: T }>

type LatestBlockhashValue = Readonly<{
  blockhash: string
  lastValidBlockHeight: bigint | number | string
}>

type SimulateValue = Readonly<{
  err: unknown | null
  logs?: readonly string[] | null
}>

type TokenBalanceValue = Readonly<{
  amount: string
  decimals: number
  uiAmountString?: string
}>

interface SubscriptionRpcClient {
  getBalance(address: Address, config?: Readonly<{ commitment: 'confirmed' }>): RpcSend<RpcValue<bigint | number | string>>
  getLatestBlockhash(config?: Readonly<{ commitment: 'confirmed' }>): RpcSend<RpcValue<LatestBlockhashValue>>
  getTokenAccountBalance(address: Address, config?: Readonly<{ commitment: 'confirmed' }>): RpcSend<RpcValue<TokenBalanceValue>>
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
  getSignatureStatuses?(
    signatures: readonly Signature[],
    config?: Readonly<{ searchTransactionHistory: boolean }>,
  ): RpcSend<RpcValue<readonly ({ confirmationStatus?: string | null; err?: unknown | null } | null)[]>>
}

export interface SubscriptionSigner {
  getAddress(): Promise<string | null>
  sign(message: Uint8Array): Promise<Uint8Array>
}

export interface SubscriptionInput {
  planId: EmberCoverPlanId
  billingPeriod: EmberBillingPeriod
  cluster: WalletCluster
}

export interface SubscriptionPreview {
  plan: EmberCoverPlan
  billingPeriod: EmberBillingPeriod
  amountUsdc: string
  renewalPeriod: string
  walletAddress: string
  tokenMint: string
  userUsdcAta: string
  merchant: string
  approvedPuller: string
  subscriptionProgram: string
  planPda: string
  subscriptionAuthorityPda: string
  subscriptionPda: string
  setupRequired: boolean
  usdcBalance: string
  usdcShortfall: string | null
  solBalanceLamports: string
  errors: string[]
  simulation: {
    status: 'not_run' | 'success' | 'failure'
    error: string | null
    logs: string[]
  }
}

export interface LocalSubscriptionState {
  cluster: WalletCluster
  walletAddress: string
  planId: EmberCoverPlanId
  billingPeriod: EmberBillingPeriod
  onchainPlanId: string
  status: 'pending' | 'setup_confirmed' | 'api_registration_pending' | 'active' | 'failed' | 'canceled' | 'revoked'
  programId: string
  planPda: string
  subscriptionAuthorityPda: string
  subscriptionPda: string
  paymentMint: string
  merchantWallet: string
  pullerWallet: string
  setupSignature?: string
  subscriptionSignature?: string
  registeredWithApi: boolean
  currentPeriodEnd?: string
  lastSyncedAt: string
}

export interface SubscriptionActivationResult {
  state: LocalSubscriptionState
  preview: SubscriptionPreview
  signature: string
  explorerUrl: string
  apiRegistered: boolean
  apiCoverActive: boolean
}

export interface SubscriptionSetupResult {
  state: LocalSubscriptionState
  preview: SubscriptionPreview
  signature: string
  explorerUrl: string
}

export interface SubscriptionUI {
  plans(): Promise<readonly EmberCoverPlan[]>
  previewSubscription(input: SubscriptionInput): Promise<SubscriptionPreview>
  setupSubscription(input: SubscriptionInput): Promise<SubscriptionSetupResult>
  activateSubscription(input: SubscriptionInput): Promise<SubscriptionActivationResult>
  localSubscription(walletAddress?: string): Promise<LocalSubscriptionState | null>
  syncEntitlement(walletAddress?: string): Promise<LocalSubscriptionState | null>
  cancelSubscription(input: SubscriptionInput): Promise<SubscriptionActivationResult>
}

interface SubscriptionProviderDeps {
  now?: () => number
  rpcFactory?: (cluster: WalletCluster) => SubscriptionRpcClient
}

const LOCAL_SUBSCRIPTION_KEY = 'local:ember-cover-solana-subscription' as const
const MIN_SOL_FOR_FEES = 20_000n

type SubscriptionTransactionMessage = Parameters<typeof signTransactionMessageWithSigners>[0]
type PreparedSubscription = Awaited<ReturnType<SolanaSubscriptionProvider['prepareSubscription']>>

function createSubscriptionRpc(cluster: WalletCluster): SubscriptionRpcClient {
  const config = walletClusterConfig(cluster)
  const url = cluster === 'devnet' ? devnet(config.rpcUrl) : config.rpcUrl
  return createSolanaRpc(url) as unknown as SubscriptionRpcClient
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

function formatUsdc(baseUnits: bigint): string {
  const whole = baseUnits / 1_000_000n
  const fraction = (baseUnits % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

function renewalPeriod(period: EmberBillingPeriod): string {
  return period === 'monthly' ? 'Monthly' : 'Annual'
}

function missingConfigError(config: SubscriptionRuntimeConfig): Error | null {
  return config.missing.length > 0 ? new Error(`Solana subscription config missing: ${config.missing.join(', ')}`) : null
}

async function tokenBalance(rpc: SubscriptionRpcClient, ata: Address): Promise<bigint | null> {
  try {
    const response = await rpc.getTokenAccountBalance(ata, { commitment: 'confirmed' }).send()
    return BigInt(response.value.amount)
  } catch {
    return null
  }
}

async function confirmSignature(rpc: SubscriptionRpcClient, signature: Signature): Promise<void> {
  if (!rpc.getSignatureStatuses) {
    return
  }
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const status = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()
    const value = status.value[0]
    if (value?.err) {
      throw new Error(`Subscription transaction failed: ${stringifyWithBigInts(value.err)}`)
    }
    if (value?.confirmationStatus === 'confirmed' || value?.confirmationStatus === 'finalized') {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

export class SolanaSubscriptionProvider implements SubscriptionUI {
  #cover: CoverProvider | undefined
  #now: () => number
  #rpcFactory: (cluster: WalletCluster) => SubscriptionRpcClient
  #signer: SubscriptionSigner

  constructor(signer: SubscriptionSigner, cover?: CoverProvider, deps: SubscriptionProviderDeps = {}) {
    this.#cover = cover
    this.#now = deps.now ?? Date.now
    this.#rpcFactory = deps.rpcFactory ?? createSubscriptionRpc
    this.#signer = signer
  }

  async plans(): Promise<readonly EmberCoverPlan[]> {
    return EMBER_COVER_PLANS
  }

  async localSubscription(walletAddress?: string): Promise<LocalSubscriptionState | null> {
    const state = await storage.getItem<LocalSubscriptionState>(LOCAL_SUBSCRIPTION_KEY)
    if (!state) {
      return null
    }
    const currentWalletAddress = walletAddress ?? (await this.#signer.getAddress())
    if (currentWalletAddress && state.walletAddress !== currentWalletAddress) {
      return null
    }
    return state
  }

  async previewSubscription(input: SubscriptionInput): Promise<SubscriptionPreview> {
    return (await this.prepareSubscription(input)).preview
  }

  async setupSubscription(input: SubscriptionInput): Promise<SubscriptionSetupResult> {
    const prepared = await this.prepareSubscription(input)
    if (!prepared.setupTransactionMessage) {
      throw new Error('Subscription setup is already complete.')
    }
    const blockingError = prepared.preview.errors.find((item) => item === 'Not enough SOL for network fees.')
    if (blockingError) {
      throw new Error(blockingError)
    }
    const signedSetup = await signTransactionMessageWithSigners(prepared.setupTransactionMessage)
    const setupBytes = getBase64EncodedWireTransaction(signedSetup)
    const setupSignature = getSignatureFromTransaction(signedSetup)
    await prepared.rpc.sendTransaction(setupBytes, {
      encoding: 'base64',
      maxRetries: 3,
      preflightCommitment: 'confirmed',
    }).send()
    await confirmSignature(prepared.rpc, setupSignature)
    const state = await this.#storeState({
      input,
      prepared,
      setupSignature: String(setupSignature),
      status: 'setup_confirmed',
      registeredWithApi: false,
    })
    return {
      state,
      preview: prepared.preview,
      signature: String(setupSignature),
      explorerUrl: explorerTransactionUrl(setupSignature, input.cluster),
    }
  }

  async activateSubscription(input: SubscriptionInput): Promise<SubscriptionActivationResult> {
    const prepared = await this.prepareSubscription(input)
    if (prepared.preview.errors.length > 0) {
      throw new Error(prepared.preview.errors[0])
    }
    if (prepared.preview.simulation.status !== 'success') {
      throw new Error('Subscription approval is not ready. Complete setup and review again.')
    }
    const existingState = await this.localSubscription(prepared.preview.walletAddress)
    const setupSignature = existingState?.setupSignature

    const signed = await signTransactionMessageWithSigners(prepared.subscriptionTransactionMessage)
    const signedBytes = getBase64EncodedWireTransaction(signed)
    const signature = getSignatureFromTransaction(signed)
    await prepared.rpc.sendTransaction(signedBytes, {
      encoding: 'base64',
      maxRetries: 3,
      preflightCommitment: 'confirmed',
    }).send()
    await confirmSignature(prepared.rpc, signature)

    const state = await this.#storeState({
      input,
      prepared,
      ...(setupSignature === undefined ? {} : { setupSignature }),
      subscriptionSignature: String(signature),
      status: 'api_registration_pending',
      registeredWithApi: false,
    })

    const finalState = await this.#syncEntitlementForState(state)
    const apiCoverActive = finalState.status === 'active'

    return {
      state: finalState,
      preview: prepared.preview,
      signature: String(signature),
      explorerUrl: explorerTransactionUrl(signature, input.cluster),
      apiRegistered: finalState.registeredWithApi,
      apiCoverActive,
    }
  }

  async syncEntitlement(walletAddress?: string): Promise<LocalSubscriptionState | null> {
    const state = await this.localSubscription(walletAddress)
    if (!state) {
      return null
    }
    if (!state.subscriptionSignature) {
      throw new Error('Subscription approval is not confirmed yet.')
    }
    return await this.#syncEntitlementForState(state)
  }

  async cancelSubscription(input: SubscriptionInput): Promise<SubscriptionActivationResult> {
    const prepared = await this.prepareSubscription(input)
    const cancelInstruction = await getCancelSubscriptionOverlayInstructionAsync({
      planPda: prepared.planPda,
      subscriber: prepared.walletSigner,
      subscriptionPda: prepared.subscriptionPda,
      programAddress: prepared.runtime.programAddress,
    })
    const transactionMessage = await this.#buildTransaction(input.cluster, prepared.rpc, prepared.walletSigner, [
      cancelInstruction,
    ])
    const signed = await signTransactionMessageWithSigners(transactionMessage)
    const signedBytes = getBase64EncodedWireTransaction(signed)
    const signature = getSignatureFromTransaction(signed)
    await prepared.rpc.sendTransaction(signedBytes, {
      encoding: 'base64',
      maxRetries: 3,
      preflightCommitment: 'confirmed',
    }).send()
    await confirmSignature(prepared.rpc, signature)
    const state = await this.#storeState({
      input,
      prepared,
      subscriptionSignature: String(signature),
      status: 'canceled',
      registeredWithApi: false,
    })
    return {
      state,
      preview: prepared.preview,
      signature: String(signature),
      explorerUrl: explorerTransactionUrl(signature, input.cluster),
      apiRegistered: false,
      apiCoverActive: false,
    }
  }

  async prepareSubscription(input: SubscriptionInput) {
    const runtime = subscriptionRuntimeConfig(input.cluster)
    const configError = missingConfigError(runtime)
    const resolvedPlan = resolveSubscriptionPlan(input.planId, input.billingPeriod)
    if (configError || !runtime.merchant || !runtime.puller || !runtime.tokenMint) {
      throw configError ?? new Error('Solana subscription config missing')
    }

    const walletAddress = await this.#signer.getAddress()
    if (!walletAddress) {
      throw new Error('No wallet')
    }
    const user = toAddress(walletAddress)
    const walletSigner = createVaultTransactionSigner(walletAddress, (message) => this.#signer.sign(message))
    const rpc = this.#rpcFactory(input.cluster)
    const [userUsdcAta] = await findAssociatedTokenPda({
      mint: runtime.tokenMint,
      owner: user,
      tokenProgram: runtime.tokenProgram,
    })
    const [subscriptionAuthorityPda] = await findSubscriptionAuthorityPda(
      { user, tokenMint: runtime.tokenMint },
      { programAddress: runtime.programAddress },
    )
    const [planPda] = await findPlanPda(
      { owner: runtime.merchant, planId: resolvedPlan.planId },
      { programAddress: runtime.programAddress },
    )
    const [subscriptionPda] = await findSubscriptionDelegationPda(
      { planPda, subscriber: user },
      { programAddress: runtime.programAddress },
    )
    const [balanceResponse, plan, subscriptionAuthority, usdcBalance] = await Promise.all([
      rpc.getBalance(user, { commitment: 'confirmed' }).send(),
      fetchMaybePlan(rpc as unknown as Parameters<typeof fetchMaybePlan>[0], planPda),
      fetchMaybeSubscriptionAuthority(
        rpc as unknown as Parameters<typeof fetchMaybeSubscriptionAuthority>[0],
        subscriptionAuthorityPda,
      ),
      tokenBalance(rpc, userUsdcAta),
    ])
    const errors: string[] = []
    const solBalance = toBigInt(balanceResponse.value)
    if (solBalance < MIN_SOL_FOR_FEES) {
      errors.push('Not enough SOL for network fees.')
    }
    if (usdcBalance === null) {
      errors.push('USDC token account is missing. Ember will create it, then you need USDC before subscribing.')
    } else if (usdcBalance < resolvedPlan.amountBaseUnits) {
      errors.push(`Not enough USDC. Add ${formatUsdc(resolvedPlan.amountBaseUnits - usdcBalance)} USDC.`)
    }
    if (!plan.exists) {
      errors.push('Selected Ember Cover plan was not found onchain.')
    } else {
      if (plan.data.data.mint !== runtime.tokenMint) {
        errors.push('Selected plan mint does not match configured USDC mint.')
      }
      if (plan.data.data.terms.amount !== resolvedPlan.amountBaseUnits) {
        errors.push('Selected plan amount does not match the wallet allowlist.')
      }
      if (plan.data.data.terms.periodHours !== resolvedPlan.renewalPeriodHours) {
        errors.push('Selected plan renewal period does not match the wallet allowlist.')
      }
      if (!plan.data.data.pullers.includes(runtime.puller)) {
        errors.push('Configured puller is not allowlisted by the selected onchain plan.')
      }
    }

    const setupInstructions: Instruction[] = []
    const setupRequired = !subscriptionAuthority.exists || usdcBalance === null
    if (usdcBalance === null) {
      setupInstructions.push(
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: walletSigner,
          owner: user,
          mint: runtime.tokenMint,
          ata: userUsdcAta,
          tokenProgram: runtime.tokenProgram,
        }),
      )
    }
    if (!subscriptionAuthority.exists) {
      setupInstructions.push(
        await getInitSubscriptionAuthorityOverlayInstructionAsync({
          owner: walletSigner,
          tokenMint: runtime.tokenMint,
          tokenProgram: runtime.tokenProgram,
          userAta: userUsdcAta,
          programAddress: runtime.programAddress,
        }),
      )
    }

    const subscriptionInstructions: Instruction[] = []
    if (plan.exists && subscriptionAuthority.exists) {
      subscriptionInstructions.push(
        await getSubscribeOverlayInstructionAsync({
          merchant: runtime.merchant,
          planId: resolvedPlan.planId,
          subscriber: walletSigner,
          tokenMint: runtime.tokenMint,
          expectedAmount: plan.data.data.terms.amount,
          expectedPeriodHours: plan.data.data.terms.periodHours,
          expectedCreatedAt: plan.data.data.terms.createdAt,
          expectedSubscriptionAuthorityInitId: subscriptionAuthority.data.initId,
          programAddress: runtime.programAddress,
        }),
      )
    }

    const setupTransactionMessage = setupInstructions.length
      ? await this.#buildTransaction(input.cluster, rpc, walletSigner, setupInstructions)
      : null
    const subscriptionTransactionMessage = await this.#buildTransaction(input.cluster, rpc, walletSigner, subscriptionInstructions)
    const simulation =
      errors.length > 0 || subscriptionInstructions.length === 0
        ? { status: 'not_run' as const, error: null, logs: [] }
        : await this.#simulate(rpc, subscriptionTransactionMessage)

    return {
      input,
      plan: resolvedPlan,
      planPda,
      preview: {
        plan: resolvedPlan.display,
        billingPeriod: input.billingPeriod,
        amountUsdc: formatUsdc(resolvedPlan.amountBaseUnits),
        renewalPeriod: renewalPeriod(input.billingPeriod),
        walletAddress,
        tokenMint: runtime.tokenMint,
        userUsdcAta,
        merchant: runtime.merchant,
        approvedPuller: runtime.puller,
        subscriptionProgram: runtime.programAddress,
        planPda,
        subscriptionAuthorityPda: String(subscriptionAuthorityPda),
        subscriptionPda: String(subscriptionPda),
        setupRequired,
        usdcBalance: usdcBalance === null ? '0' : formatUsdc(usdcBalance),
        usdcShortfall:
          usdcBalance !== null && usdcBalance < resolvedPlan.amountBaseUnits
            ? formatUsdc(resolvedPlan.amountBaseUnits - usdcBalance)
            : null,
        solBalanceLamports: solBalance.toString(),
        errors,
        simulation,
      } satisfies SubscriptionPreview,
      rpc,
      runtime,
      setupTransactionMessage,
      subscriptionAuthorityPda,
      subscriptionPda,
      subscriptionTransactionMessage,
      walletSigner,
    }
  }

  async #buildTransaction(
    cluster: WalletCluster,
    rpc: SubscriptionRpcClient,
    walletSigner: TransactionSigner,
    instructions: Instruction[],
  ): Promise<SubscriptionTransactionMessage> {
    const latestBlockhashResponse = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
    let transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayerSigner(walletSigner, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: toBlockhash(latestBlockhashResponse.value.blockhash),
            lastValidBlockHeight: toBigInt(latestBlockhashResponse.value.lastValidBlockHeight),
          },
          message,
        ),
    ) as SubscriptionTransactionMessage
    for (const instruction of instructions) {
      transactionMessage = appendTransactionMessageInstruction(instruction, transactionMessage) as SubscriptionTransactionMessage
    }
    return transactionMessage
  }

  async #simulate(rpc: SubscriptionRpcClient, transactionMessage: SubscriptionTransactionMessage) {
    const unsignedTransaction = compileTransaction(transactionMessage)
    const unsignedBytes = getBase64EncodedWireTransaction(unsignedTransaction)
    const simulationResponse = await rpc
      .simulateTransaction(unsignedBytes, {
        commitment: 'confirmed',
        encoding: 'base64',
        replaceRecentBlockhash: false,
        sigVerify: false,
      })
      .send()
    const error = simulationResponse.value.err ? stringifyWithBigInts(simulationResponse.value.err) : null
    return {
      status: error ? ('failure' as const) : ('success' as const),
      error,
      logs: [...(simulationResponse.value.logs ?? [])],
    }
  }

  async #syncEntitlementForState(state: LocalSubscriptionState): Promise<LocalSubscriptionState> {
    if (!this.#cover || !state.subscriptionSignature) {
      return state
    }
    // Wallet-native order. (1) authorize the session key — every proxied cover
    // call needs it. (2) activate — the engine writes the wallet-keyed entitlement
    // from the confirmed on-chain subscribe. (3) register — link the wallet to that
    // now-existing entitlement. (4) status — confirm active + registered.
    // Registering before activating cannot work: the entitlement does not exist yet.
    const authorized = await this.#cover.authorizeSession()
    const entitlementActivated = authorized
      ? await (this.#cover.activateSubscriptionEntitlement?.({
          cluster: state.cluster,
          planTier: state.planId,
          billingPeriod: state.billingPeriod,
          programId: state.programId,
          paymentMint: state.paymentMint,
          merchantWallet: state.merchantWallet,
          pullerWallet: state.pullerWallet,
          planId: state.onchainPlanId,
          planPda: state.planPda,
          subscriptionAuthorityPda: state.subscriptionAuthorityPda,
          subscriptionPda: state.subscriptionPda,
          ...(state.setupSignature === undefined ? {} : { setupSignature: state.setupSignature }),
          subscriptionSignature: state.subscriptionSignature,
        }) ?? false)
      : false
    const apiRegistered = entitlementActivated ? await this.#cover.registerWithApi() : false
    const status = apiRegistered ? await this.#cover.status() : null
    const apiCoverActive = !!status?.subscriptionActive && !!status.walletRegistered
    const next: LocalSubscriptionState = {
      ...state,
      status: apiCoverActive ? 'active' : 'api_registration_pending',
      registeredWithApi: apiRegistered,
      lastSyncedAt: new Date(this.#now()).toISOString(),
    }
    await storage.setItem<LocalSubscriptionState>(LOCAL_SUBSCRIPTION_KEY, next)
    return next
  }

  async #storeState(args: {
    input: SubscriptionInput
    prepared: PreparedSubscription
    setupSignature?: string
    subscriptionSignature?: string
    status: LocalSubscriptionState['status']
    registeredWithApi: boolean
  }): Promise<LocalSubscriptionState> {
    const state: LocalSubscriptionState = {
      cluster: args.input.cluster,
      walletAddress: args.prepared.preview.walletAddress,
      planId: args.input.planId,
      billingPeriod: args.input.billingPeriod,
      onchainPlanId: args.prepared.plan.planId.toString(),
      status: args.status,
      programId: String(args.prepared.runtime.programAddress),
      planPda: args.prepared.planPda,
      subscriptionAuthorityPda: args.prepared.subscriptionAuthorityPda,
      subscriptionPda: args.prepared.subscriptionPda,
      paymentMint: String(args.prepared.runtime.tokenMint),
      merchantWallet: String(args.prepared.runtime.merchant),
      pullerWallet: String(args.prepared.runtime.puller),
      ...(args.setupSignature === undefined ? {} : { setupSignature: args.setupSignature }),
      ...(args.subscriptionSignature === undefined ? {} : { subscriptionSignature: args.subscriptionSignature }),
      registeredWithApi: args.registeredWithApi,
      lastSyncedAt: new Date(this.#now()).toISOString(),
    }
    await storage.setItem<LocalSubscriptionState>(LOCAL_SUBSCRIPTION_KEY, state)
    return state
  }
}

const SUBSCRIPTION_SERVICE_KEY = 'ember.SubscriptionService' as ProxyServiceKey<SubscriptionUI>

export function registerSubscriptionService(provider: SubscriptionUI): void {
  const facade: SubscriptionUI = {
    plans: () => provider.plans(),
    previewSubscription: (input) => provider.previewSubscription(input),
    setupSubscription: (input) => provider.setupSubscription(input),
    activateSubscription: (input) => provider.activateSubscription(input),
    localSubscription: (walletAddress) => provider.localSubscription(walletAddress),
    syncEntitlement: (walletAddress) => provider.syncEntitlement(walletAddress),
    cancelSubscription: (input) => provider.cancelSubscription(input),
  }
  registerService(SUBSCRIPTION_SERVICE_KEY, facade)
}

export function getSubscriptionService(): ProxyService<SubscriptionUI> {
  return createProxyService<SubscriptionUI>(SUBSCRIPTION_SERVICE_KEY)
}
