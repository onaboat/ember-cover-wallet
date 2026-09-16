import type { SignedQuoteResponse } from '@embercover/wallet-sdk'
import {
  AccountRole,
  address as toAddress,
  appendTransactionMessageInstruction,
  blockhash as toBlockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import type {
  Address,
  Base64EncodedWireTransaction,
  Instruction,
  SignatureBytes,
  Transaction,
  TransactionSigner,
} from '@solana/kit'
import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
} from '@solana-program/token'

import type { ValidatedCoveragePaymentContract } from '../cover/coverage-payment-contract.ts'
import { stringifyWithBigInts } from '../background/safe-json.ts'
import type { WalletCluster } from '../background/wallet-data-config.ts'

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
type AccountInfoValue = Readonly<{ owner: string }>

export interface CoveragePaymentPreparationRpc {
  getGenesisHash(): RpcSend<string>
  getBalance(
    address: Address,
    config?: Readonly<{ commitment: 'confirmed' }>,
  ): RpcSend<RpcValue<bigint | number | string>>
  getLatestBlockhash(
    config?: Readonly<{ commitment: 'confirmed' }>,
  ): RpcSend<RpcValue<LatestBlockhashValue>>
  getAccountInfo(
    address: Address,
    config?: Readonly<{ commitment: 'confirmed'; encoding: 'base64' }>,
  ): RpcSend<RpcValue<AccountInfoValue | null>>
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
  ): RpcSend<RpcValue<SimulationValue>>
}

export interface CoveragePaymentTransactionPreview {
  amountBaseUnits: string
  amountDisplay: string
  asset: string
  benefitPeriodCount: number
  benefitPeriodLimitMicros: string
  cluster: WalletCluster
  durationDays: number
  durationMonths: number
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
  tokenBalanceDisplay: string
  tokenMint: string
  tokenProgram: string
  treasuryOwner: string
  treasuryTokenAccount: string
  walletAddress: string
}

export interface PreparedCoveragePaymentTransaction {
  blockhash: string
  lastValidBlockHeight: bigint
  preview: CoveragePaymentTransactionPreview
  transactionMessage: Parameters<
    typeof import('@solana/kit').signTransactionMessageWithSigners
  >[0]
}

export interface PrepareCoveragePaymentTransactionInput {
  cluster: WalletCluster
  contract: ValidatedCoveragePaymentContract
  expectedGenesisHash: string
  rpc: CoveragePaymentPreparationRpc
  signMessage: (message: Uint8Array) => Promise<Uint8Array>
  walletAddress: string
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

function createTransactionSigner(
  walletAddress: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
): TransactionSigner {
  const signerAddress = toAddress(walletAddress)
  return {
    address: signerAddress,
    signTransactions: async (transactions: readonly Transaction[]) =>
      await Promise.all(
        transactions.map(async (transaction) => ({
          [signerAddress]: (await signMessage(
            new Uint8Array(transaction.messageBytes),
          )) as SignatureBytes,
        })),
      ),
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

/**
 * Build and simulate the exact quote-bound SPL payment. Signing remains a
 * caller-owned side effect and is never invoked by this preparation function.
 */
export async function prepareCoveragePaymentTransaction(
  input: PrepareCoveragePaymentTransactionInput,
): Promise<PreparedCoveragePaymentTransaction> {
  const { quote, schedule } = input.contract
  const payload = quote.payload
  const payment = payload.payment
  const genesisHash = await input.rpc.getGenesisHash().send()
  if (
    genesisHash !== payment.genesisHash ||
    genesisHash !== input.expectedGenesisHash
  ) {
    throw new Error(`Connected RPC is not Solana ${input.cluster}`)
  }

  const wallet = toAddress(input.walletAddress)
  const tokenProgram = toAddress(payment.tokenProgram)
  const mint = toAddress(payment.mint)
  const signer = createTransactionSigner(input.walletAddress, input.signMessage)
  const [sourceTokenAccount] = await findAssociatedTokenPda({
    mint,
    owner: wallet,
    tokenProgram,
  })
  const [balance, sourceAccount, latestBlockhash] = await Promise.all([
    input.rpc.getBalance(wallet, { commitment: 'confirmed' }).send(),
    input.rpc
      .getAccountInfo(sourceTokenAccount, {
        commitment: 'confirmed',
        encoding: 'base64',
      })
      .send(),
    input.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send(),
  ])
  const errors: string[] = []
  let tokenBalance: TokenBalanceValue = {
    amount: '0',
    decimals: payment.decimals,
    uiAmountString: '0',
  }
  if (!sourceAccount.value) {
    errors.push(
      `Not enough ${payload.offer.paymentAsset}. You need ${displayBaseUnits(payment.amount, payment.decimals)} ${payload.offer.paymentAsset}, but this wallet has 0 ${payload.offer.paymentAsset}.`,
    )
  } else if (sourceAccount.value.owner !== payment.tokenProgram) {
    errors.push('The payment token account is not owned by the expected token program')
  } else {
    tokenBalance = (
      await input.rpc
        .getTokenAccountBalance(sourceTokenAccount, { commitment: 'confirmed' })
        .send()
    ).value
    if (tokenBalance.decimals !== payment.decimals) {
      errors.push('Source token account decimals do not match the signed quote')
    }
    if (BigInt(tokenBalance.amount) < BigInt(payment.amount)) {
      errors.push(
        `Not enough ${payload.offer.paymentAsset}. You need ${displayBaseUnits(payment.amount, payment.decimals)} ${payload.offer.paymentAsset}, but this wallet has ${displayBaseUnits(tokenBalance.amount, tokenBalance.decimals)} ${payload.offer.paymentAsset}.`,
      )
    }
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
  ) as PreparedCoveragePaymentTransaction['transactionMessage']

  let simulation: CoveragePaymentTransactionPreview['simulation'] = {
    status: 'failure',
    error: errors[0] ?? 'Payment preconditions failed',
    logs: [],
  }
  let feeLamports = DEFAULT_FEE_LAMPORTS
  if (errors.length === 0) {
    const unsigned = getBase64EncodedWireTransaction(compileTransaction(transactionMessage))
    const response = await input.rpc
      .simulateTransaction(unsigned, {
        commitment: 'confirmed',
        encoding: 'base64',
        replaceRecentBlockhash: false,
        sigVerify: false,
      })
      .send()
    feeLamports =
      response.value.fee == null ? DEFAULT_FEE_LAMPORTS : toBigInt(response.value.fee)
    const error = response.value.err ? stringifyWithBigInts(response.value.err) : null
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
      benefitPeriodCount: schedule.benefitPeriodCount,
      benefitPeriodLimitMicros: schedule.benefitPeriodLimit,
      cluster: input.cluster,
      durationDays: payload.offer.coverageDurationDays,
      durationMonths: schedule.coverageDurationMonths,
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
      tokenBalanceBaseUnits: tokenBalance.amount,
      tokenBalanceDisplay: displayBaseUnits(tokenBalance.amount, tokenBalance.decimals),
      tokenMint: payment.mint,
      tokenProgram: payment.tokenProgram,
      treasuryOwner: payment.treasuryOwner!,
      treasuryTokenAccount: payment.treasuryTokenAccount,
      walletAddress: input.walletAddress,
    },
    transactionMessage,
  }
}
