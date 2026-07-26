import { address as toAddress, createSolanaRpc, devnet, mainnet } from '@solana/kit'
import type { Address } from '@solana/kit'
import { createProxyService, registerService } from '@webext-core/proxy-service'
import type { ProxyService, ProxyServiceKey } from '@webext-core/proxy-service'
import { browser } from 'wxt/browser'
import { storage } from 'wxt/utils/storage'

import {
  DEFAULT_WALLET_CLUSTER,
  explorerTransactionUrl,
  isWalletCluster,
  walletClusterConfig,
} from './wallet-data-config.ts'
import { coverRecords } from './cover-records.ts'
import type {
  CoverRecord,
  CoverRecordStateUpdate,
  WalletTransactionStatus,
} from './cover-records.ts'
import { stringifyWithBigInts } from './safe-json.ts'
import {
  shortTokenMint,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  trustedTokenMetadata,
} from './token-metadata.ts'
import type { WalletCluster } from './wallet-data-config.ts'

const CLUSTER_KEY = 'local:ember-wallet-data-cluster' as const
const DEFAULT_ACTIVITY_LIMIT = 10
const MAX_ACTIVITY_LIMIT = 50
const CORE_RPC_TIMEOUT_MS = 8_000
const ENRICHMENT_TIMEOUT_MS = 3_000

type RpcSend<T> = {
  send(): Promise<T>
}

type WalletBalanceRpcResponse = Readonly<{
  value: bigint | number | string
}>

type WalletRpcActivityItem = Readonly<{
  blockTime: bigint | number | null
  confirmationStatus: string | null
  err: unknown | null
  memo: string | null
  signature: string
  slot: bigint | number
}>

type WalletRpcTokenAccount = Readonly<{
  pubkey: string
  account: Readonly<{
    owner: string
    data: Readonly<{
      parsed?: {
        info?: {
          mint?: string
          owner?: string
          tokenAmount?: {
            amount?: string
            decimals?: number
            uiAmountString?: string
          }
        }
        type?: string
      }
    }>
  }>
}>

type WalletTokenAccountsRpcResponse = Readonly<{
  value: readonly WalletRpcTokenAccount[]
}>

type WalletParsedTransactionResponse = Readonly<{
  meta?: {
    fee?: bigint | number | string
  }
  transaction?: {
    message?: {
      instructions?: readonly unknown[]
    }
  }
}> | null

type WalletRpcSignatureStatus = Readonly<{
  confirmationStatus: string | null
  err: unknown | null
  slot: bigint | number
}>

interface WalletDataRpcClient {
  getBalance(address: Address, config?: Readonly<{ commitment: 'confirmed' }>): RpcSend<WalletBalanceRpcResponse>
  getSignaturesForAddress(
    address: Address,
    config?: Readonly<{ commitment: 'confirmed'; limit: number }>,
  ): RpcSend<readonly WalletRpcActivityItem[]>
  getTransaction?(
    signature: string,
    config: Readonly<{ commitment: 'confirmed'; encoding: 'jsonParsed'; maxSupportedTransactionVersion: 0 }>,
  ): RpcSend<WalletParsedTransactionResponse>
  getTokenAccountsByOwner(
    owner: Address,
    filter: Readonly<{ programId: Address }>,
    config: Readonly<{ commitment: 'confirmed'; encoding: 'jsonParsed' }>,
  ): RpcSend<WalletTokenAccountsRpcResponse>
  getSignatureStatuses?(
    signatures: readonly string[],
    config: Readonly<{ searchTransactionHistory: true }>,
  ): RpcSend<Readonly<{ value: readonly (WalletRpcSignatureStatus | null)[] }>>
  getBlockHeight?(
    config?: Readonly<{ commitment: 'confirmed' }>,
  ): RpcSend<bigint | number | string>
  sendTransaction?(
    transaction: string,
    config: Readonly<{
      encoding: 'base64'
      maxRetries: number
      preflightCommitment: 'confirmed'
    }>,
  ): RpcSend<string>
}

export interface WalletActivityItem {
  signature: string
  slot: number
  blockTime: number | null
  confirmationStatus: string | null
  failed: boolean
  explorerUrl: string
  direction: 'sent' | 'received' | 'unknown'
  title: string
  amount: string | null
  counterparty: string | null
  feeLamports: string | null
  programs: string[]
}

export interface WalletTokenBalance {
  tokenAccount: string
  mint: string
  owner: string | null
  programId: string
  rawAmount: string
  decimals: number
  uiAmount: string
  label: string
  name: string
  symbol: string
  iconText: string
  trusted: boolean
}

export type WalletCoverStatus = 'covered' | 'not_covered' | 'unavailable' | 'unknown'

export interface WalletEmberActivityItem {
  id: string
  type: string
  timestamp: string
  dappOrigin: string | null
  requestId: string | null
  signature: string | null
  coverStatus: WalletCoverStatus
  riskBand: string | null
  // Null for cover records (a cover decision has no transfer metadata); the matched
  // on-chain row supplies the title via `emberRecord?.title ?? tx.title` in the popup.
  title: string | null
  amount: string | null
  tokenSymbol: string | null
  tokenMint: string | null
  recipient: string | null
  source: string | null
  feePayer: string | null
  programs: string[]
  onchainStatus: string | null
  cluster: WalletCluster | null
  lastCheckedAt: string | null
  failureReason: string | null
  explorerUrl: string
}

export interface WalletDataSnapshot {
  cluster: WalletCluster
  address: string
  solBalance: string
  lamports: string
  tokenBalances: WalletTokenBalance[]
  tokenBalancesUnavailable: boolean
  activity: WalletActivityItem[]
  activityUnavailable: boolean
  emberActivity: WalletEmberActivityItem[]
  emberActivityUnavailable: boolean
}

export interface WalletDataUI {
  getCluster(): Promise<WalletCluster>
  setCluster(cluster: WalletCluster): Promise<void>
  getSnapshot(address: string, limit?: number): Promise<WalletDataSnapshot>
}

interface WalletDataProviderDeps {
  coreRpcTimeoutMs?: number
  enrichmentTimeoutMs?: number
  rpcFactory?: (cluster: WalletCluster) => WalletDataRpcClient
}

function rpcUrlFor(cluster: WalletCluster) {
  const url = walletClusterConfig(cluster).rpcUrl
  return cluster === 'devnet' ? devnet(url) : mainnet(url)
}

function createWalletRpc(cluster: WalletCluster): WalletDataRpcClient {
  return createSolanaRpc(rpcUrlFor(cluster)) as unknown as WalletDataRpcClient
}

function asBigInt(value: bigint | number | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value)
}

function rpcNumber(value: bigint | number | null): number | null {
  if (value === null) {
    return null
  }
  return Number(value)
}

function activityLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit === undefined) {
    return DEFAULT_ACTIVITY_LIMIT
  }
  return Math.max(1, Math.min(MAX_ACTIVITY_LIMIT, Math.trunc(limit)))
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('wallet_data_timeout')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

export function formatLamportsAsSol(value: bigint | number | string): string {
  return formatIntegerAmount(value, 9)
}

function formatIntegerAmount(value: bigint | number | string, decimals: number): string {
  const lamports = asBigInt(value)
  const sign = lamports < 0n ? '-' : ''
  const absolute = lamports < 0n ? -lamports : lamports
  const scale = 10n ** BigInt(Math.max(0, decimals))
  const whole = scale === 0n ? absolute : absolute / scale
  const fraction = scale === 0n ? 0n : absolute % scale
  const trimmedFraction = decimals > 0 ? fraction.toString().padStart(decimals, '0').replace(/0+$/, '') : ''
  return `${sign}${whole.toString()}${trimmedFraction ? `.${trimmedFraction}` : ''}`
}

export function formatTokenAmount(rawAmount: string, decimals: number): string {
  if (!/^-?\d+$/.test(rawAmount)) {
    return rawAmount
  }
  return formatIntegerAmount(rawAmount, decimals)
}

export function normalizeActivity(
  items: readonly WalletRpcActivityItem[],
  cluster: WalletCluster,
): WalletActivityItem[] {
  return items.map((item) => ({
    signature: item.signature,
    slot: rpcNumber(item.slot) ?? 0,
    blockTime: rpcNumber(item.blockTime),
    confirmationStatus: item.confirmationStatus,
    failed: item.err !== null,
    explorerUrl: explorerTransactionUrl(item.signature, cluster),
    direction: 'unknown',
    title: item.err === null ? 'On-chain transaction' : 'Failed transaction',
    amount: null,
    counterparty: null,
    feeLamports: null,
    programs: [],
  }))
}

function lamportsFrom(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  return null
}

function parsedInstructionOf(value: unknown): Record<string, unknown> | null {
  const row = recordOf(value)
  if (row['program'] !== 'system') return null
  const parsed = recordOf(row['parsed'])
  if (parsed['type'] !== 'transfer') return null
  return recordOf(parsed['info'])
}

function programNameOf(value: unknown): string | null {
  const row = recordOf(value)
  const program = stringOrNull(row['program'])
  if (program) return program
  return stringOrNull(row['programId'])
}

function activityDetailFromTransaction(
  transaction: WalletParsedTransactionResponse,
  walletAddress: string,
): Pick<WalletActivityItem, 'amount' | 'counterparty' | 'direction' | 'title' | 'feeLamports' | 'programs'> | null {
  const instructions = transaction?.transaction?.message?.instructions
  if (!Array.isArray(instructions)) return null
  const fee = transaction?.meta?.fee
  const programs = [...new Set(instructions.map(programNameOf).filter((item): item is string => item !== null))]
  for (const instruction of instructions) {
    const info = parsedInstructionOf(instruction)
    if (!info) continue
    const source = stringOrNull(info['source'])
    const destination = stringOrNull(info['destination'])
    const lamports = lamportsFrom(info['lamports'])
    if (!source || !destination || lamports === null) continue
    if (source === walletAddress) {
      return {
        amount: `${formatLamportsAsSol(lamports)} SOL`,
        counterparty: destination,
        direction: 'sent',
        title: `Sent ${formatLamportsAsSol(lamports)} SOL`,
        feeLamports: fee === undefined ? null : asBigInt(fee).toString(),
        programs,
      }
    }
    if (destination === walletAddress) {
      return {
        amount: `${formatLamportsAsSol(lamports)} SOL`,
        counterparty: source,
        direction: 'received',
        title: `Received ${formatLamportsAsSol(lamports)} SOL`,
        feeLamports: fee === undefined ? null : asBigInt(fee).toString(),
        programs,
      }
    }
  }
  return null
}

export function normalizeTokenBalances(
  accounts: readonly WalletRpcTokenAccount[],
  cluster: WalletCluster = 'devnet',
  expectedOwner?: string,
): WalletTokenBalance[] {
  return accounts
    .map((entry) => {
      const info = entry.account.data.parsed?.info
      const mint = info?.mint
      const rawAmount = info?.tokenAmount?.amount
      const decimals = info?.tokenAmount?.decimals
      const programId = String(entry.account.owner)
      if (
        !mint ||
        rawAmount === undefined ||
        !/^\d+$/.test(rawAmount) ||
        rawAmount === '0' ||
        decimals === undefined ||
        !Number.isInteger(decimals) ||
        decimals < 0 ||
        decimals > 255 ||
        (programId !== TOKEN_PROGRAM_ADDRESS && programId !== TOKEN_2022_PROGRAM_ADDRESS) ||
        (expectedOwner !== undefined && info?.owner !== expectedOwner)
      ) {
        return null
      }
      const uiAmount = info?.tokenAmount?.uiAmountString ?? formatTokenAmount(rawAmount, decimals)
      const trusted = trustedTokenMetadata(cluster, mint, programId)
      return {
        tokenAccount: String(entry.pubkey),
        mint,
        owner: info?.owner ?? null,
        programId,
        rawAmount,
        decimals,
        uiAmount,
        label: trusted?.symbol ?? `Unknown ${shortTokenMint(mint)}`,
        name: trusted?.name ?? 'Unknown token',
        symbol: trusted?.symbol ?? shortTokenMint(mint),
        iconText: trusted?.iconText ?? '?',
        trusted: trusted !== null,
      } satisfies WalletTokenBalance
    })
    .filter((item): item is WalletTokenBalance => item !== null)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function transactionStatusFromRpc(status: WalletRpcSignatureStatus): WalletTransactionStatus {
  if (status.err !== null) {
    return 'failed'
  }
  if (status.confirmationStatus === 'finalized') {
    return 'finalized'
  }
  if (status.confirmationStatus === 'confirmed') {
    return 'confirmed'
  }
  return 'processed'
}

function transactionStatusFromActivity(item: WalletActivityItem): WalletTransactionStatus {
  if (item.failed) {
    return 'failed'
  }
  if (item.confirmationStatus === 'finalized') {
    return 'finalized'
  }
  if (item.confirmationStatus === 'confirmed') {
    return 'confirmed'
  }
  return 'processed'
}

export class WalletDataProvider implements WalletDataUI {
  #coreRpcTimeoutMs: number
  #enrichmentTimeoutMs: number
  #rpcFactory: (cluster: WalletCluster) => WalletDataRpcClient

  constructor(deps: WalletDataProviderDeps = {}) {
    this.#coreRpcTimeoutMs = deps.coreRpcTimeoutMs ?? CORE_RPC_TIMEOUT_MS
    this.#enrichmentTimeoutMs = deps.enrichmentTimeoutMs ?? ENRICHMENT_TIMEOUT_MS
    this.#rpcFactory = deps.rpcFactory ?? createWalletRpc
  }

  async getCluster(): Promise<WalletCluster> {
    const stored = await storage.getItem<unknown>(CLUSTER_KEY)
    return isWalletCluster(stored) ? stored : DEFAULT_WALLET_CLUSTER
  }

  async setCluster(cluster: WalletCluster): Promise<void> {
    if (!isWalletCluster(cluster)) {
      throw new Error('Unsupported wallet cluster')
    }
    await storage.setItem(CLUSTER_KEY, cluster)
  }

  async getSnapshot(walletAddress: string, limit?: number): Promise<WalletDataSnapshot> {
    const cluster = await this.getCluster()
    const rpc = this.#rpcFactory(cluster)
    const publicKey = toAddress(walletAddress)
    const [balance, activity, tokenBalances] = await Promise.all([
      withTimeout(rpc.getBalance(publicKey, { commitment: 'confirmed' }).send(), this.#coreRpcTimeoutMs),
      withTimeout(
        rpc.getSignaturesForAddress(publicKey, { commitment: 'confirmed', limit: activityLimit(limit) }).send(),
        this.#enrichmentTimeoutMs,
      ).catch(() => null),
      withTimeout(this.#getTokenBalances(rpc, publicKey, cluster), this.#enrichmentTimeoutMs).catch(() => null),
    ])
    const lamports = asBigInt(balance.value)
    const normalizedActivity = activity === null ? [] : normalizeActivity(activity, cluster)
    const detailedActivity =
      activity === null
        ? []
        : await withTimeout(this.#getActivityDetails(rpc, normalizedActivity, walletAddress), this.#enrichmentTimeoutMs).catch(
            () => normalizedActivity,
          )
    const emberRecords = await this.#reconcileCoverRecords(
      rpc,
      walletAddress,
      cluster,
      detailedActivity,
    ).catch(() => coverRecords.list(walletAddress, cluster).catch(() => null))
    const emberActivity: WalletEmberActivityItem[] =
      emberRecords === null
        ? []
        : emberRecords.map((record) => ({
            id: record.signature,
            type: 'signTransaction',
            timestamp: record.recordedAt,
            dappOrigin: record.dappOrigin,
            requestId: record.requestId,
            // Equals the on-chain WalletActivityItem.signature, so App.tsx matches by signature.
            signature: record.signature,
            coverStatus: record.coverStatus,
            riskBand: record.riskBand,
            title: record.title ?? null,
            amount: record.amount ?? null,
            tokenSymbol: record.tokenSymbol ?? null,
            tokenMint: record.tokenMint ?? null,
            recipient: record.recipient ?? null,
            source: record.source ?? null,
            feePayer: record.feePayer ?? null,
            programs: record.programs ?? [],
            onchainStatus: record.transactionStatus,
            cluster: record.cluster,
            lastCheckedAt: record.lastCheckedAt,
            failureReason: record.failureReason,
            explorerUrl: explorerTransactionUrl(record.signature, cluster),
          }))
    return {
      cluster,
      address: walletAddress,
      solBalance: formatLamportsAsSol(lamports),
      lamports: lamports.toString(),
      tokenBalances: tokenBalances ?? [],
      tokenBalancesUnavailable: tokenBalances === null,
      activity: detailedActivity,
      activityUnavailable: activity === null,
      emberActivity,
      emberActivityUnavailable: emberRecords === null,
    }
  }

  async reconcilePending(walletAddress: string): Promise<void> {
    const cluster = await this.getCluster()
    const rpc = this.#rpcFactory(cluster)
    await withTimeout(
      this.#reconcileCoverRecords(rpc, walletAddress, cluster, []),
      this.#coreRpcTimeoutMs,
    )
  }

  async #reconcileCoverRecords(
    rpc: WalletDataRpcClient,
    walletAddress: string,
    cluster: WalletCluster,
    activity: readonly WalletActivityItem[],
  ): Promise<CoverRecord[]> {
    const records = await coverRecords.list(walletAddress, cluster)
    if (records.length === 0) {
      return records
    }
    const updatesBySignature = new Map<string, CoverRecordStateUpdate>()
    const activityBySignature = new Map(activity.map((item) => [item.signature, item]))
    for (const record of records) {
      const onchain = activityBySignature.get(record.signature)
      if (onchain) {
        updatesBySignature.set(record.signature, {
          signature: record.signature,
          walletAddress,
          transactionStatus: transactionStatusFromActivity(onchain),
          failureReason: onchain.failed ? 'The transaction failed on-chain.' : null,
        })
      }
    }

    const statusCandidates = records.filter(
      (record) =>
        !activityBySignature.has(record.signature) &&
        record.transactionStatus !== 'finalized' &&
        record.transactionStatus !== 'failed' &&
        record.transactionStatus !== 'expired',
    )
    if (rpc.getSignatureStatuses && statusCandidates.length > 0) {
      const response = await rpc
        .getSignatureStatuses(
          statusCandidates.map((record) => record.signature),
          { searchTransactionHistory: true },
        )
        .send()
      response.value.forEach((status, index) => {
        const record = statusCandidates[index]
        if (!record || !status) {
          return
        }
        updatesBySignature.set(record.signature, {
          signature: record.signature,
          walletAddress,
          transactionStatus: transactionStatusFromRpc(status),
          failureReason: status.err === null ? null : stringifyWithBigInts(status.err),
        })
      })
    }

    const expiryCandidates = statusCandidates.filter(
      (record) =>
        !updatesBySignature.has(record.signature) &&
        (record.transactionStatus !== 'signed' || record.broadcastOwner === 'wallet') &&
        record.lastValidBlockHeight !== null,
    )
    if (rpc.getBlockHeight && expiryCandidates.length > 0) {
      const blockHeight = asBigInt(
        await rpc.getBlockHeight({ commitment: 'confirmed' }).send(),
      )
      for (const record of expiryCandidates) {
        if (blockHeight > BigInt(record.lastValidBlockHeight!)) {
          updatesBySignature.set(record.signature, {
            signature: record.signature,
            walletAddress,
            transactionStatus: 'expired',
            failureReason: 'The transaction was not confirmed before its blockhash expired.',
          })
        }
      }
    }

    const retryCandidates = statusCandidates.filter(
      (record) =>
        !updatesBySignature.has(record.signature) &&
        record.broadcastOwner === 'wallet' &&
        record.signedTransactionBase64 !== null,
    )
    if (rpc.sendTransaction) {
      for (const record of retryCandidates) {
        try {
          const returnedSignature = await rpc
            .sendTransaction(record.signedTransactionBase64!, {
              encoding: 'base64',
              maxRetries: 3,
              preflightCommitment: 'confirmed',
            })
            .send()
          if (returnedSignature !== record.signature) {
            throw new Error('RPC returned an unexpected transaction signature.')
          }
          updatesBySignature.set(record.signature, {
            signature: record.signature,
            walletAddress,
            transactionStatus: 'broadcast',
            failureReason: null,
          })
        } catch (error) {
          updatesBySignature.set(record.signature, {
            signature: record.signature,
            walletAddress,
            transactionStatus: record.transactionStatus,
            failureReason: `Broadcast retry failed: ${String(error)}`,
          })
        }
      }
    }

    await coverRecords.updateTransactionStates([...updatesBySignature.values()])
    return await coverRecords.list(walletAddress, cluster)
  }

  async #getActivityDetails(
    rpc: WalletDataRpcClient,
    activity: WalletActivityItem[],
    walletAddress: string,
  ): Promise<WalletActivityItem[]> {
    if (!rpc.getTransaction || activity.length === 0) {
      return activity
    }
    const getTransaction = rpc.getTransaction
    return await Promise.all(
      activity.map(async (item) => {
        const transaction = await getTransaction
          .call(rpc, item.signature, {
            commitment: 'confirmed',
            encoding: 'jsonParsed',
            maxSupportedTransactionVersion: 0,
          })
          .send()
          .catch(() => null)
        const detail = activityDetailFromTransaction(transaction, walletAddress)
        return detail ? { ...item, ...detail } : item
      }),
    )
  }

  async #getTokenBalances(
    rpc: WalletDataRpcClient,
    owner: Address,
    cluster: WalletCluster,
  ): Promise<WalletTokenBalance[]> {
    const [tokenAccounts, token2022Accounts] = await Promise.all([
      rpc
        .getTokenAccountsByOwner(toAddress(owner), { programId: toAddress(TOKEN_PROGRAM_ADDRESS) }, { commitment: 'confirmed', encoding: 'jsonParsed' })
        .send(),
      rpc
        .getTokenAccountsByOwner(toAddress(owner), { programId: toAddress(TOKEN_2022_PROGRAM_ADDRESS) }, { commitment: 'confirmed', encoding: 'jsonParsed' })
        .send(),
    ])
    return normalizeTokenBalances(
      [...tokenAccounts.value, ...token2022Accounts.value],
      cluster,
      String(owner),
    )
  }
}

const WALLET_DATA_SERVICE_KEY = 'ember.WalletDataService' as ProxyServiceKey<WalletDataUI>

export function registerWalletDataService(provider = new WalletDataProvider()): WalletDataProvider {
  const facade: WalletDataUI = {
    getCluster: () => provider.getCluster(),
    setCluster: (cluster) => provider.setCluster(cluster),
    getSnapshot: (address, limit) => provider.getSnapshot(address, limit),
  }
  registerService(WALLET_DATA_SERVICE_KEY, facade)
  return provider
}

export function getWalletDataService(): ProxyService<WalletDataUI> {
  return createProxyService<WalletDataUI>(WALLET_DATA_SERVICE_KEY)
}

const ACTIVITY_RECONCILIATION_ALARM = 'ember-activity-reconciliation'

export function registerActivityReconciliation(
  provider: WalletDataProvider,
  wallet: { getAddress(): Promise<string | null> },
): void {
  const reconcile = async (): Promise<void> => {
    const address = await wallet.getAddress()
    if (address) {
      await provider.reconcilePending(address)
    }
  }
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ACTIVITY_RECONCILIATION_ALARM) {
      void reconcile().catch(() => {})
    }
  })
  void browser.alarms.create(ACTIVITY_RECONCILIATION_ALARM, { periodInMinutes: 1 })
  void reconcile().catch(() => {})
}
