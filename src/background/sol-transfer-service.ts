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
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getGetAccountDataSizeInstruction,
  getTokenSize,
  getTransferCheckedInstruction,
} from '@solana-program/token'
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
import { coverRecords, toWalletCoverStatus } from './cover-records.ts'
import type { CoverProvider } from './cover-service.ts'
import { stringifyWithBigInts } from './safe-json.ts'
import { formatLamportsAsSol } from './wallet-data-service.ts'
import { walletClusterConfig } from './wallet-data-config.ts'
import type { WalletCluster } from './wallet-data-config.ts'
import { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from './token-metadata.ts'

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
  returnData?: Readonly<{
    data: readonly [string, string]
    programId: string
  }> | null
}>

interface TransferRpcClient {
  getBalance(address: Address, config?: Readonly<{ commitment: 'confirmed' }>): RpcSend<RpcValue<bigint | number | string>>
  getLatestBlockhash(config?: Readonly<{ commitment: 'confirmed' }>): RpcSend<RpcValue<LatestBlockhashValue>>
  getAccountInfo?(
    address: Address,
    config: Readonly<{ commitment: 'confirmed'; encoding: 'jsonParsed' }>,
  ): RpcSend<
    RpcValue<
      | Readonly<{
          owner: string
          data?: Readonly<{
            parsed?: Readonly<{
              info?: Readonly<{
                decimals?: number
                extensions?: readonly unknown[]
                mint?: string
                owner?: string
                state?: string
                tokenAmount?: Readonly<{ amount?: string; decimals?: number }>
              }>
              type?: string
            }>
          }>
        }>
      | null
    >
  >
  getMinimumBalanceForRentExemption?(
    size: bigint | number,
    config?: Readonly<{ commitment: 'confirmed' }>,
  ): RpcSend<bigint | number | string>
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

export type WalletTransferAsset =
  | {
      kind: 'sol'
      symbol: 'SOL'
    }
  | {
      kind: 'token'
      symbol: string
      mint: string
      tokenAccount: string
      programId: string
      decimals: number
      rawBalance: string
      name?: string
      trusted?: boolean
    }

export interface WalletTransferInput {
  amount: string
  asset: WalletTransferAsset
  cluster?: WalletCluster
  destination: string
}

export interface WalletTransferSendInput extends WalletTransferInput {
  acknowledgeHighRisk?: boolean
  acknowledgeUncovered?: boolean
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
  asset: WalletTransferAsset
  amount: string
  amountBaseUnits: string
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
  tokenBalanceAfter: string | null
  destinationTokenAccount: string | null
  createsDestinationTokenAccount: boolean
  accountRentLamports: string
  accountRentSol: string
  tokenAccountSize: number | null
}

export interface SolTransferResult {
  signature: string
  explorerUrl: string
  cover: SolTransferCoverView
}

export interface WalletTransferUI {
  previewTransfer(input: WalletTransferInput): Promise<SolTransferPreview>
  sendTransfer(input: WalletTransferSendInput): Promise<SolTransferResult>
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

export function parseTokenAmountToBaseUnits(input: string, decimals: number): bigint {
  const trimmed = input.trim()
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error('Token decimals are invalid')
  }
  if (!/^(?:\d+|\d*\.\d+)$/.test(trimmed)) {
    throw new Error('Enter a valid token amount')
  }
  const [wholePart = '0', fractionPart = ''] = trimmed.split('.')
  if (fractionPart.length > decimals) {
    throw new Error(`This token supports up to ${decimals} decimal places`)
  }
  const scale = 10n ** BigInt(decimals)
  const amount = BigInt(wholePart || '0') * scale + BigInt(fractionPart.padEnd(decimals, '0') || '0')
  if (amount <= 0n) {
    throw new Error('Amount must be greater than 0')
  }
  return amount
}

function formatBaseUnits(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals)
  const whole = value / scale
  const fraction = value % scale
  const trimmed = decimals > 0 ? fraction.toString().padStart(decimals, '0').replace(/0+$/, '') : ''
  return `${whole.toString()}${trimmed ? `.${trimmed}` : ''}`
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

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function token2022ExtensionNames(extensions: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(extensions)) {
    return []
  }
  return extensions
    .map((extension) => {
      const row = recordOf(extension)
      const name = row['extension'] ?? row['extensionType'] ?? row['type']
      return typeof name === 'string' && name.trim() ? name.trim() : 'unknown'
    })
    .filter((name, index, names) => names.indexOf(name) === index)
}

function assertTransferableToken2022Mint(extensions: readonly unknown[] | undefined): void {
  const names = token2022ExtensionNames(extensions)
  if (names.length > 0) {
    throw new Error(
      `Token-2022 extension "${names.join(', ')}" is not supported for wallet sends yet.`,
    )
  }
}

function tokenAccountSizeFromSimulation(value: SimulateValue, tokenProgram: string): number {
  if (value.err) {
    throw new Error(`Could not calculate Token-2022 account rent: ${stringifyWithBigInts(value.err)}`)
  }
  const returnData = value.returnData
  if (!returnData || returnData.programId !== tokenProgram || returnData.data[1] !== 'base64') {
    throw new Error('Could not calculate Token-2022 account rent.')
  }
  const bytes = fromBase64(returnData.data[0])
  if (bytes.length < 8) {
    throw new Error('Token-2022 returned an invalid account size.')
  }
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true)
  if (size <= 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Token-2022 returned an invalid account size.')
  }
  return Number(size)
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
    return await this.previewTransfer({
      amount: input.amountSol,
      asset: { kind: 'sol', symbol: 'SOL' },
      ...(input.cluster === undefined ? {} : { cluster: input.cluster }),
      destination: input.destination,
    })
  }

  async sendSolTransfer(input: SolTransferSendInput): Promise<SolTransferResult> {
    return await this.sendTransfer({
      amount: input.amountSol,
      asset: { kind: 'sol', symbol: 'SOL' },
      ...(input.cluster === undefined ? {} : { cluster: input.cluster }),
      destination: input.destination,
      ...(input.acknowledgeHighRisk === undefined ? {} : { acknowledgeHighRisk: input.acknowledgeHighRisk }),
      ...(input.acknowledgeUncovered === undefined ? {} : { acknowledgeUncovered: input.acknowledgeUncovered }),
    })
  }

  async previewTransfer(input: WalletTransferInput): Promise<SolTransferPreview> {
    const prepared = await this.#prepare(input)
    return prepared.preview
  }

  async sendTransfer(input: WalletTransferSendInput): Promise<SolTransferResult> {
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
    await coverRecords.record({
      signature,
      walletAddress: prepared.walletAddress,
      coverStatus: toWalletCoverStatus(prepared.decision.coverStatus),
      riskBand: prepared.decision.riskBand,
      requestId: prepared.decision.requestId ?? null,
      dappOrigin: null,
      title:
        prepared.preview.asset.kind === 'sol'
          ? `Sent ${prepared.preview.amount} SOL`
          : `Sent ${prepared.preview.amount} ${prepared.preview.asset.symbol}`,
      actionKind: prepared.preview.asset.kind === 'sol' ? 'sol_transfer' : 'token_transfer',
      amount: `${prepared.preview.amount} ${prepared.preview.asset.symbol}`,
      tokenSymbol: prepared.preview.asset.symbol,
      tokenMint: prepared.preview.asset.kind === 'token' ? prepared.preview.asset.mint : null,
      recipient: prepared.preview.destination,
      source: prepared.preview.source,
      feePayer: prepared.preview.source,
      programs:
        prepared.preview.asset.kind === 'sol'
          ? ['System Program']
          : [
              prepared.preview.asset.programId === TOKEN_2022_PROGRAM_ADDRESS ? 'Token 2022' : 'Token Program',
              ...(prepared.preview.createsDestinationTokenAccount ? ['Associated Token'] : []),
            ],
      cluster: prepared.cluster,
      transactionStatus: 'signed',
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
      broadcastOwner: 'wallet',
      signedTransactionBase64: String(signedBytes),
    })
    try {
      const returnedSignature = await prepared.rpc
        .sendTransaction(signedBytes, {
          encoding: 'base64',
          maxRetries: 3,
          preflightCommitment: 'confirmed',
        })
        .send()
      if (String(returnedSignature) !== String(signature)) {
        throw new Error('RPC returned an unexpected transaction signature.')
      }
      await coverRecords.updateTransactionStates([
        {
          signature,
          walletAddress: prepared.walletAddress,
          transactionStatus: 'broadcast',
        },
      ])
    } catch (error) {
      await coverRecords
        .updateTransactionStates([
          {
            signature,
            walletAddress: prepared.walletAddress,
            transactionStatus: 'signed',
            failureReason: `Broadcast needs retry: ${String(error)}`,
          },
        ])
        .catch(() => {})
      throw new Error(
        `Transaction signed and saved, but broadcast was not confirmed. Do not sign again; Ember will retry it while the blockhash is valid. ${String(error)}`,
      )
    }

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

  async #prepare(input: WalletTransferInput) {
    const walletAddress = await this.#signer.getAddress()
    if (!walletAddress) {
      throw new Error('No wallet')
    }
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
    const transactionSigner = createVaultTransactionSigner(walletAddress, (message) => this.#signer.sign(message))
    let amountBaseUnits: bigint
    let amountSol = '0'
    let tokenBalanceAfter: string | null = null
    let destinationTokenAccount: string | null = null
    let createsDestinationTokenAccount = false
    let accountRentLamports = 0n
    let tokenAccountSize: number | null = null
    const instructions: Instruction[] = []
    const baseTransactionMessage = pipe(
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
    )

    if (input.asset.kind === 'sol') {
      amountBaseUnits = parseSolAmountToLamports(input.amount)
      const maxSendable = maxSolSendLamports(balanceLamports)
      if (amountBaseUnits > maxSendable) {
        throw new Error(`Not enough SOL for amount and network fee. Max is ${formatLamportsAsSol(maxSendable)} SOL.`)
      }
      amountSol = formatLamportsAsSol(amountBaseUnits)
      instructions.push(
        createSystemTransferInstruction({ amount: amountBaseUnits, destination, source: transactionSigner }),
      )
    } else {
      if (!rpc.getAccountInfo || !rpc.getMinimumBalanceForRentExemption) {
        throw new Error('Token account lookup is unavailable')
      }
      if (input.asset.programId !== TOKEN_PROGRAM_ADDRESS && input.asset.programId !== TOKEN_2022_PROGRAM_ADDRESS) {
        throw new Error('Unsupported token program')
      }
      const tokenProgram = toAddress(input.asset.programId)
      const mint = parseAddress(input.asset.mint)
      const sourceTokenAccount = parseAddress(input.asset.tokenAccount)
      const [sourceTokenResponse, mintResponse] = await Promise.all([
        rpc
          .getAccountInfo(sourceTokenAccount, { commitment: 'confirmed', encoding: 'jsonParsed' })
          .send(),
        rpc.getAccountInfo(mint, { commitment: 'confirmed', encoding: 'jsonParsed' }).send(),
      ])
      const sourceToken = sourceTokenResponse.value
      const sourceInfo = sourceToken?.data?.parsed?.info
      if (
        !sourceToken ||
        sourceToken.owner !== input.asset.programId ||
        sourceToken.data?.parsed?.type !== 'account' ||
        sourceInfo?.mint !== input.asset.mint ||
        sourceInfo.owner !== walletAddress ||
        sourceInfo.tokenAmount?.decimals !== input.asset.decimals
      ) {
        throw new Error('Selected token account no longer matches this wallet')
      }
      if (sourceInfo.state?.toLowerCase() === 'frozen') {
        throw new Error('The selected token account is frozen and cannot send tokens.')
      }
      const mintAccount = mintResponse.value
      const mintInfo = mintAccount?.data?.parsed?.info
      if (
        !mintAccount ||
        mintAccount.owner !== input.asset.programId ||
        mintAccount.data?.parsed?.type !== 'mint' ||
        mintInfo?.decimals !== input.asset.decimals
      ) {
        throw new Error('The selected token mint no longer matches this asset.')
      }
      if (input.asset.programId === TOKEN_2022_PROGRAM_ADDRESS) {
        assertTransferableToken2022Mint(mintInfo.extensions)
      }
      amountBaseUnits = parseTokenAmountToBaseUnits(input.amount, input.asset.decimals)
      const rawBalance = BigInt(sourceInfo.tokenAmount.amount ?? '0')
      if (amountBaseUnits > rawBalance) {
        throw new Error(`Not enough ${input.asset.symbol}. Max is ${formatBaseUnits(rawBalance, input.asset.decimals)}.`)
      }
      tokenBalanceAfter = formatBaseUnits(rawBalance - amountBaseUnits, input.asset.decimals)
      const [destinationAta] = await findAssociatedTokenPda({
        owner: destination,
        tokenProgram,
        mint,
      })
      destinationTokenAccount = destinationAta
      const destinationTokenResponse = await rpc
        .getAccountInfo(destinationAta, { commitment: 'confirmed', encoding: 'jsonParsed' })
        .send()
      createsDestinationTokenAccount = destinationTokenResponse.value === null
      if (destinationTokenResponse.value) {
        const destinationAccount = destinationTokenResponse.value
        const destinationInfo = destinationAccount.data?.parsed?.info
        if (
          destinationAccount.owner !== input.asset.programId ||
          destinationAccount.data?.parsed?.type !== 'account' ||
          destinationInfo?.mint !== input.asset.mint ||
          destinationInfo.owner !== input.destination.trim() ||
          destinationInfo.tokenAmount?.decimals !== input.asset.decimals
        ) {
          throw new Error('The recipient token account does not match this mint and token program.')
        }
        if (destinationInfo.state?.toLowerCase() === 'frozen') {
          throw new Error('The recipient token account is frozen and cannot receive tokens.')
        }
      }
      if (createsDestinationTokenAccount) {
        tokenAccountSize =
          input.asset.programId === TOKEN_2022_PROGRAM_ADDRESS
            ? tokenAccountSizeFromSimulation(
                (
                  await rpc
                    .simulateTransaction(
                      getBase64EncodedWireTransaction(
                        compileTransaction(
                          appendTransactionMessageInstruction(
                            getGetAccountDataSizeInstruction(
                              { mint },
                              { programAddress: tokenProgram },
                            ),
                            baseTransactionMessage,
                          ),
                        ),
                      ),
                      {
                        commitment: 'confirmed',
                        encoding: 'base64',
                        replaceRecentBlockhash: false,
                        sigVerify: false,
                      },
                    )
                    .send()
                ).value,
                input.asset.programId,
              )
            : getTokenSize()
        accountRentLamports = toBigInt(
          await rpc
            .getMinimumBalanceForRentExemption(tokenAccountSize, { commitment: 'confirmed' })
            .send(),
        )
        instructions.push(
          getCreateAssociatedTokenIdempotentInstruction({
            payer: transactionSigner,
            ata: destinationAta,
            owner: destination,
            mint,
            tokenProgram,
          }),
        )
      }
      instructions.push(
        getTransferCheckedInstruction(
          {
            source: sourceTokenAccount,
            mint,
            destination: destinationAta,
            authority: transactionSigner,
            amount: amountBaseUnits,
            decimals: input.asset.decimals,
          },
          { programAddress: tokenProgram },
        ),
      )
    }

    const transactionMessage = instructions.reduce(
      (message, instruction) => appendTransactionMessageInstruction(instruction, message),
      baseTransactionMessage as any,
    )
    const unsignedTransaction = compileTransaction(transactionMessage)
    const unsignedBytes = getBase64EncodedWireTransaction(unsignedTransaction)
    const [decision, simulationResponse] = await Promise.all([
      this.#cover
        ? this.#cover.preSign({ transactionBytes: unsignedBytes, cluster })
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
    const totalDebit =
      input.asset.kind === 'sol' ? amountBaseUnits + feeLamports : feeLamports + accountRentLamports
    if (totalDebit > balanceLamports) {
      throw new Error(
        input.asset.kind === 'sol'
          ? `Not enough SOL for amount and network fee.`
          : `Not enough SOL for the network fee${createsDestinationTokenAccount ? ' and recipient token account rent' : ''}.`,
      )
    }
    const balanceAfter = balanceLamports > totalDebit ? balanceLamports - totalDebit : 0n
    const simulationError = simulationResponse.value.err ? stringifyWithBigInts(simulationResponse.value.err) : null
    return {
      decision,
      preview: {
        asset: input.asset,
        amount: formatBaseUnits(
          amountBaseUnits,
          input.asset.kind === 'sol' ? 9 : input.asset.decimals,
        ),
        amountBaseUnits: amountBaseUnits.toString(),
        amountLamports: input.asset.kind === 'sol' ? amountBaseUnits.toString() : '0',
        amountSol,
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
        tokenBalanceAfter,
        destinationTokenAccount,
        createsDestinationTokenAccount,
        accountRentLamports: accountRentLamports.toString(),
        accountRentSol: formatLamportsAsSol(accountRentLamports),
        tokenAccountSize,
      } satisfies SolTransferPreview,
      rpc,
      cluster,
      blockhash: latestBlockhashResponse.value.blockhash,
      lastValidBlockHeight: toBigInt(latestBlockhashResponse.value.lastValidBlockHeight).toString(),
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
    previewTransfer: (input) => provider.previewTransfer(input),
    sendTransfer: (input) => provider.sendTransfer(input),
    previewSolTransfer: (input) => provider.previewSolTransfer(input),
    sendSolTransfer: (input) => provider.sendSolTransfer(input),
  }
  registerService(WALLET_TRANSFER_SERVICE_KEY, facade)
}

export function getWalletTransferService(): ProxyService<WalletTransferUI> {
  return createProxyService<WalletTransferUI>(WALLET_TRANSFER_SERVICE_KEY)
}
