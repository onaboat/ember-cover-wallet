import {
  AccountRole,
  address as toAddress,
  appendTransactionMessageInstruction,
  blockhash as toBlockhash,
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
import { createProxyService, registerService } from '@webext-core/proxy-service'
import type { ProxyService, ProxyServiceKey } from '@webext-core/proxy-service'

import type { CoverCapContext, CoverDecision, CoverStatus, RiskBand } from '../cover/ember-types.ts'
import { coverCapExhausted, isCoverable } from '../cover/ember-types.ts'
import type { CoverProvider } from './cover-service.ts'
import { formatLamportsAsSol } from './wallet-data-service.ts'
import { walletClusterConfig } from './wallet-data-config.ts'
import type { WalletCluster } from './wallet-data-config.ts'

const SYSTEM_PROGRAM_ADDRESS = toAddress('11111111111111111111111111111111')
const TRANSACTION_FEE_LAMPORTS = 5_000n

type RpcSend<T> = {
  send(): Promise<T>
}

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

interface TransferRpcClient {
  getBalance(address: Address, config?: Readonly<{ commitment: 'confirmed' }>): RpcSend<RpcValue<bigint | number | string>>
  getLatestBlockhash(config?: Readonly<{ commitment: 'confirmed' }>): RpcSend<RpcValue<LatestBlockhashValue>>
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
}

export interface SolTransferSigner {
  getAddress(): Promise<string | null>
  sign(message: Uint8Array): Promise<Uint8Array>
}

export interface SolTransferInput {
  amountSol: string
  cluster?: WalletCluster
  destination: string
}

export interface SolTransferSendInput extends SolTransferInput {
  acknowledgeHighRisk?: boolean
  acknowledgeUncovered?: boolean
}

export interface SolTransferCoverView {
  coverStatus: CoverStatus
  riskBand: RiskBand
  decisionExpiresAt: string
  capContext?: CoverCapContext
  coveredTxCountImpact?: number
  label: string
  body: string
  requiresHighRiskAck: boolean
  requiresUncoveredAck: boolean
}

export interface SolTransferPreview {
  amountLamports: string
  amountSol: string
  balanceAfterSol: string
  cover: SolTransferCoverView
  destination: string
  feeLamports: string
  feeSol: string
  simulation: {
    status: 'success' | 'failure'
    error: string | null
    logs: string[]
  }
  source: string
  totalDebitSol: string
}

export interface SolTransferResult {
  signature: string
  explorerUrl: string
  cover: SolTransferCoverView
}

export interface WalletTransferUI {
  previewSolTransfer(input: SolTransferInput): Promise<SolTransferPreview>
  sendSolTransfer(input: SolTransferSendInput): Promise<SolTransferResult>
}

interface WalletTransferProviderDeps {
  cluster?: WalletCluster
  now?: () => number
  rpcFactory?: (cluster: WalletCluster) => TransferRpcClient
}

function createTransferRpc(cluster: WalletCluster): TransferRpcClient {
  const config = walletClusterConfig(cluster)
  const url = cluster === 'devnet' ? devnet(config.rpcUrl) : config.rpcUrl
  return createSolanaRpc(url) as unknown as TransferRpcClient
}

function toBigInt(value: bigint | number | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value)
}

function parseAddress(value: string): Address {
  try {
    return toAddress(value)
  } catch {
    throw new Error('Enter a valid Solana address')
  }
}

export function parseSolAmountToLamports(input: string): bigint {
  const trimmed = input.trim()
  if (!/^(?:\d+|\d*\.\d+)$/.test(trimmed)) {
    throw new Error('Enter a valid SOL amount')
  }
  const [wholePart = '0', fractionPart = ''] = trimmed.split('.')
  if (fractionPart.length > 9) {
    throw new Error('SOL supports up to 9 decimal places')
  }
  const lamports = BigInt(wholePart || '0') * 1_000_000_000n + BigInt(fractionPart.padEnd(9, '0') || '0')
  if (lamports <= 0n) {
    throw new Error('Amount must be greater than 0')
  }
  return lamports
}

export function maxSolSendLamports(balanceLamports: bigint): bigint {
  return balanceLamports > TRANSACTION_FEE_LAMPORTS ? balanceLamports - TRANSACTION_FEE_LAMPORTS : 0n
}

function shortAddress(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-8)}` : value
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function coverView(decision: CoverDecision): SolTransferCoverView {
  const coverStatus = decision.coverStatus
  const capContext = decision.capContext === undefined ? {} : { capContext: decision.capContext }
  const coveredTxCountImpact =
    decision.coveredTxCountImpact === undefined ? {} : { coveredTxCountImpact: decision.coveredTxCountImpact }
  const highRisk = coverStatus === 'covered' && (decision.riskBand === 'high' || decision.riskBand === 'severe')
  if (highRisk) {
    return {
      coverStatus,
      riskBand: decision.riskBand,
      decisionExpiresAt: decision.decisionExpiresAt,
      ...capContext,
      ...coveredTxCountImpact,
      label: 'Covered, high risk',
      body: 'Cover is available, but review carefully.',
      requiresHighRiskAck: true,
      requiresUncoveredAck: false,
    }
  }
  if (coverStatus === 'covered') {
    return {
      coverStatus,
      riskBand: decision.riskBand,
      decisionExpiresAt: decision.decisionExpiresAt,
      ...capContext,
      ...coveredTxCountImpact,
      label: 'Covered',
      body: 'Ember Cover is available for this send.',
      requiresHighRiskAck: false,
      requiresUncoveredAck: false,
    }
  }
  if (coverStatus === 'unavailable') {
    return {
      coverStatus,
      riskBand: decision.riskBand,
      decisionExpiresAt: decision.decisionExpiresAt,
      ...capContext,
      ...coveredTxCountImpact,
      label: 'Cover unavailable',
      body: 'Ember cannot check this send right now.',
      requiresHighRiskAck: false,
      requiresUncoveredAck: true,
    }
  }
  return {
    coverStatus,
    riskBand: decision.riskBand,
    decisionExpiresAt: decision.decisionExpiresAt,
    ...capContext,
    ...coveredTxCountImpact,
    label: 'Not covered',
    body: coverCapExhausted(decision)
      ? 'No Ember Cover checks left this month.'
      : 'Ember Cover will not apply to this send.',
    requiresHighRiskAck: false,
    requiresUncoveredAck: true,
  }
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

function createSystemTransferInstruction({
  amount,
  destination,
  source,
}: {
  amount: bigint
  destination: Address
  source: TransactionSigner
}): Instruction {
  const data = new Uint8Array(12)
  const view = new DataView(data.buffer)
  view.setUint32(0, 2, true)
  view.setBigUint64(4, amount, true)
  return {
    accounts: [
      { address: source.address, role: AccountRole.WRITABLE },
      { address: destination, role: AccountRole.WRITABLE },
    ],
    data,
    programAddress: SYSTEM_PROGRAM_ADDRESS,
  }
}

export class WalletTransferProvider implements WalletTransferUI {
  #cluster: WalletCluster
  #cover: CoverProvider | undefined
  #now: () => number
  #rpcFactory: (cluster: WalletCluster) => TransferRpcClient
  #signer: SolTransferSigner

  constructor(signer: SolTransferSigner, cover?: CoverProvider, deps: WalletTransferProviderDeps = {}) {
    this.#cluster = deps.cluster ?? 'devnet'
    this.#cover = cover
    this.#now = deps.now ?? Date.now
    this.#rpcFactory = deps.rpcFactory ?? createTransferRpc
    this.#signer = signer
  }

  async previewSolTransfer(input: SolTransferInput): Promise<SolTransferPreview> {
    const prepared = await this.#prepare(input)
    return prepared.preview
  }

  async sendSolTransfer(input: SolTransferSendInput): Promise<SolTransferResult> {
    const prepared = await this.#prepare(input)
    const { cover, simulation } = prepared.preview
    if (simulation.status !== 'success') {
      throw new Error('Simulation failed. The transaction was not sent.')
    }
    if (cover.requiresUncoveredAck && !input.acknowledgeUncovered) {
      throw new Error('Confirm you understand this send is not covered')
    }
    if (cover.requiresHighRiskAck && !input.acknowledgeHighRisk) {
      throw new Error('Confirm you understand this covered send is high risk')
    }
    if (cover.coverStatus === 'covered' && this.#now() >= Date.parse(cover.decisionExpiresAt)) {
      throw new Error('Cover decision expired. Review the send again.')
    }

    const signedTransaction = await signTransactionMessageWithSigners(prepared.transactionMessage)
    const signedBytes = getBase64EncodedWireTransaction(signedTransaction)
    const signature = getSignatureFromTransaction(signedTransaction)
    await prepared.rpc
      .sendTransaction(signedBytes, { encoding: 'base64', maxRetries: 3, preflightCommitment: 'confirmed' })
      .send()

    if (this.#cover && isCoverable(prepared.decision) && prepared.decision.requestId) {
      void this.#cover.postSign({
        requestId: prepared.decision.requestId,
        signedBytes,
        signature,
        signingWalletPublicKey: prepared.walletAddress,
        walletTimestamp: new Date(this.#now()).toISOString(),
      })
    }

    return {
      signature,
      explorerUrl: explorerTransactionUrl(signature, prepared.cluster),
      cover,
    }
  }

  async #prepare(input: SolTransferInput) {
    const walletAddress = await this.#signer.getAddress()
    if (!walletAddress) {
      throw new Error('No wallet')
    }
    const amountLamports = parseSolAmountToLamports(input.amountSol)
    const destination = parseAddress(input.destination.trim())
    const source = toAddress(walletAddress)
    if (destination === source) {
      throw new Error('Recipient is this wallet')
    }
    const cluster = input.cluster ?? this.#cluster
    const rpc = this.#rpcFactory(cluster)
    const [balanceResponse, latestBlockhashResponse] = await Promise.all([
      rpc.getBalance(source, { commitment: 'confirmed' }).send(),
      rpc.getLatestBlockhash({ commitment: 'confirmed' }).send(),
    ])
    const balanceLamports = toBigInt(balanceResponse.value)
    const maxSendable = maxSolSendLamports(balanceLamports)
    if (amountLamports > maxSendable) {
      throw new Error(`Not enough SOL for amount and network fee. Max is ${formatLamportsAsSol(maxSendable)} SOL.`)
    }
    const transactionSigner = createVaultTransactionSigner(walletAddress, (message) => this.#signer.sign(message))
    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayerSigner(transactionSigner, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: toBlockhash(latestBlockhashResponse.value.blockhash),
            lastValidBlockHeight: toBigInt(latestBlockhashResponse.value.lastValidBlockHeight),
          },
          message,
        ),
      (message) =>
        appendTransactionMessageInstruction(
          createSystemTransferInstruction({ amount: amountLamports, destination, source: transactionSigner }),
          message,
        ),
    )
    const unsignedTransaction = compileTransaction(transactionMessage)
    const unsignedBytes = getBase64EncodedWireTransaction(unsignedTransaction)
    const [decision, simulationResponse] = await Promise.all([
      this.#cover
        ? this.#cover.preSign({ transactionBytes: unsignedBytes })
        : Promise.resolve({
            requestId: '',
            coverStatus: 'unavailable' as const,
            riskBand: 'severe' as const,
            reasonCodes: [],
            decisionExpiresAt: new Date(0).toISOString(),
          }),
      rpc
        .simulateTransaction(unsignedBytes, {
          commitment: 'confirmed',
          encoding: 'base64',
          replaceRecentBlockhash: false,
          sigVerify: false,
        })
        .send(),
    ])
    const feeLamports = simulationResponse.value.fee == null ? TRANSACTION_FEE_LAMPORTS : toBigInt(simulationResponse.value.fee)
    const totalDebit = amountLamports + feeLamports
    const balanceAfter = balanceLamports > totalDebit ? balanceLamports - totalDebit : 0n
    const simulationError = simulationResponse.value.err ? JSON.stringify(simulationResponse.value.err) : null
    return {
      decision,
      preview: {
        amountLamports: amountLamports.toString(),
        amountSol: formatLamportsAsSol(amountLamports),
        balanceAfterSol: formatLamportsAsSol(balanceAfter),
        cover: coverView(decision),
        destination: input.destination,
        feeLamports: feeLamports.toString(),
        feeSol: formatLamportsAsSol(feeLamports),
        simulation: {
          status: simulationError ? 'failure' : 'success',
          error: simulationError,
          logs: [...(simulationResponse.value.logs ?? [])],
        },
        source: walletAddress,
        totalDebitSol: formatLamportsAsSol(totalDebit),
      } satisfies SolTransferPreview,
      rpc,
      cluster,
      transactionMessage,
      walletAddress,
    }
  }
}

function explorerTransactionUrl(signature: string, cluster: WalletCluster): string {
  const config = walletClusterConfig(cluster)
  const url = `https://explorer.solana.com/tx/${encodeURIComponent(signature)}`
  return config.explorerCluster ? `${url}?cluster=${encodeURIComponent(config.explorerCluster)}` : url
}

const WALLET_TRANSFER_SERVICE_KEY = 'ember.WalletTransferService' as ProxyServiceKey<WalletTransferUI>

export function registerWalletTransferService(provider: WalletTransferUI): void {
  const facade: WalletTransferUI = {
    previewSolTransfer: (input) => provider.previewSolTransfer(input),
    sendSolTransfer: (input) => provider.sendSolTransfer(input),
  }
  registerService(WALLET_TRANSFER_SERVICE_KEY, facade)
}

export function getWalletTransferService(): ProxyService<WalletTransferUI> {
  return createProxyService<WalletTransferUI>(WALLET_TRANSFER_SERVICE_KEY)
}
