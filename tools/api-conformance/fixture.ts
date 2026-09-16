import type {
  CoverageDecisionResponse,
  CoverageInstanceResponse,
  SignedQuoteResponse,
  WalletClaimEvidenceRequest,
  WalletClaimResponse,
} from '@embercover/wallet-sdk'
import { getTransferSolInstruction } from '@solana-program/system'
import {
  address as toAddress,
  appendTransactionMessageInstruction,
  blockhash as toBlockhash,
  compileTransaction,
  createSolanaRpc,
  createTransactionMessage,
  devnet,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import type {
  Address,
  Base64EncodedWireTransaction,
  Signature,
  Transaction,
  TransactionSigner,
} from '@solana/kit'
import { createHash } from 'node:crypto'

import { validateCoveragePaymentContract } from '../../src/cover/coverage-payment-contract.ts'
import { DEVNET_GENESIS_HASH } from '../../src/solana/clusters.ts'
import {
  prepareCoveragePaymentTransaction,
} from '../../src/solana/coverage-payment-transaction.ts'
import type {
  CoveragePaymentPreparationRpc,
} from '../../src/solana/coverage-payment-transaction.ts'
import { OperatorBridge } from './operator-bridge.ts'
import { decodeBase64, encodeBase64 } from './protocol.ts'

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

interface ConformanceRpc extends CoveragePaymentPreparationRpc {
  sendTransaction(
    transaction: Base64EncodedWireTransaction,
    config: Readonly<{
      encoding: 'base64'
      maxRetries: number
      preflightCommitment: 'confirmed'
    }>,
  ): RpcSend<Signature>
}

interface PreparedControlledTransaction {
  coverageInstanceId: string
  feeLamports: string
  kind: 'prepared_conformance_transfer'
  recipient: string
  transactionBase64: string
  transactionSha256: string
  transferLamports: string
  walletAddress: string
}

interface FixtureEnvironment {
  EMBER_CONFORMANCE_OPERATOR_TIMEOUT_MS?: string
  EMBER_CONFORMANCE_RECIPIENT?: string
  EMBER_CONFORMANCE_RPC_URL?: string
  EMBER_CONFORMANCE_TRANSFER_LAMPORTS?: string
}

const DEFAULT_OPERATOR_TIMEOUT_MS = 5 * 60 * 1000
const MAX_CONTROLLED_TRANSFER_LAMPORTS = 100_000n

function required(env: FixtureEnvironment, name: keyof FixtureEnvironment): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required for the conformance wallet fixture`)
  return value
}

function positiveInteger(value: string, name: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer`)
  return BigInt(value)
}

function operatorTimeout(env: FixtureEnvironment): number {
  const raw = env.EMBER_CONFORMANCE_OPERATOR_TIMEOUT_MS?.trim()
  if (!raw) return DEFAULT_OPERATOR_TIMEOUT_MS
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('EMBER_CONFORMANCE_OPERATOR_TIMEOUT_MS must be a positive integer')
  }
  return value
}

function conformanceRpcUrl(env: FixtureEnvironment): string {
  const raw = required(env, 'EMBER_CONFORMANCE_RPC_URL')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('EMBER_CONFORMANCE_RPC_URL must be an absolute URL')
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('The conformance RPC must use HTTPS or exact loopback HTTP')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The conformance RPC URL must not contain credentials or parameters')
  }
  return url.toString()
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

function inertTransactionSigner(walletAddress: string): TransactionSigner {
  return {
    address: toAddress(walletAddress),
    signTransactions: async (_transactions: readonly Transaction[]) => {
      throw new Error('The operator wallet must sign through Wallet Standard')
    },
  }
}

function preparedControlledTransaction(value: unknown): PreparedControlledTransaction {
  if (!value || typeof value !== 'object') {
    throw new Error('The controlled transaction preparation is unavailable')
  }
  const prepared = value as Partial<PreparedControlledTransaction>
  if (
    prepared.kind !== 'prepared_conformance_transfer' ||
    typeof prepared.coverageInstanceId !== 'string' ||
    typeof prepared.feeLamports !== 'string' ||
    typeof prepared.recipient !== 'string' ||
    typeof prepared.transactionBase64 !== 'string' ||
    typeof prepared.transactionSha256 !== 'string' ||
    typeof prepared.transferLamports !== 'string' ||
    typeof prepared.walletAddress !== 'string'
  ) {
    throw new Error('The controlled transaction preparation is malformed')
  }
  return prepared as PreparedControlledTransaction
}

async function verifyDevnet(rpc: ConformanceRpc): Promise<void> {
  const genesisHash = await rpc.getGenesisHash().send()
  if (genesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error('The conformance wallet fixture is restricted to Solana Devnet')
  }
}

async function signedTransactionFromOperator(args: {
  amount: string
  asset: string
  bridge: OperatorBridge
  feeLamports: string
  recipient: string
  title: string
  transactionBase64: string
  transactionSha256: string
  walletAddress: string
}): Promise<Uint8Array> {
  const result = await args.bridge.request({
    kind: 'sign_transaction',
    summary: {
      amount: args.amount,
      asset: args.asset,
      cluster: 'devnet',
      feeLamports: args.feeLamports,
      feePayer: args.walletAddress,
      recipient: args.recipient,
      simulation: 'passed',
      title: args.title,
      transactionSha256: args.transactionSha256,
    },
    transactionBase64: args.transactionBase64,
  })
  if (result.outcome === 'rejected') {
    throw new Error(result.reason)
  }
  if (result.outcome !== 'signed_transaction') {
    throw new Error('The operator returned the wrong approval result')
  }
  const signedBytes = decodeBase64(result.signedTransactionBase64)
  const unsigned = getTransactionDecoder().decode(
    decodeBase64(args.transactionBase64),
  )
  const signed = getTransactionDecoder().decode(signedBytes)
  if (!sameBytes(new Uint8Array(unsigned.messageBytes), new Uint8Array(signed.messageBytes))) {
    throw new Error('Signed transaction bytes differ from the reviewed transaction')
  }
  return signedBytes
}

async function broadcast(
  rpc: ConformanceRpc,
  signedBytes: Uint8Array,
): Promise<string> {
  const transaction = getTransactionDecoder().decode(signedBytes)
  const expectedSignature = String(getSignatureFromTransaction(transaction))
  const returned = await rpc
    .sendTransaction(encodeBase64(signedBytes) as Base64EncodedWireTransaction, {
      encoding: 'base64',
      maxRetries: 3,
      preflightCommitment: 'confirmed',
    })
    .send()
  if (String(returned) !== expectedSignature) {
    throw new Error('Solana RPC returned a signature that does not match the signed bytes')
  }
  return expectedSignature
}

export async function createConformanceWalletFixture({
  environment,
}: {
  baseUrl: string
  environment: string
}) {
  if (environment !== 'sandbox') {
    throw new Error('The external wallet fixture is restricted to the sandbox environment')
  }
  const env = process.env as FixtureEnvironment
  const rpcUrl = conformanceRpcUrl(env)
  const recipient = String(toAddress(required(env, 'EMBER_CONFORMANCE_RECIPIENT')))
  const transferLamports = positiveInteger(
    required(env, 'EMBER_CONFORMANCE_TRANSFER_LAMPORTS'),
    'EMBER_CONFORMANCE_TRANSFER_LAMPORTS',
  )
  if (transferLamports > MAX_CONTROLLED_TRANSFER_LAMPORTS) {
    throw new Error(
      `EMBER_CONFORMANCE_TRANSFER_LAMPORTS must not exceed ${MAX_CONTROLLED_TRANSFER_LAMPORTS}`,
    )
  }
  const rpc = createSolanaRpc(devnet(rpcUrl)) as unknown as ConformanceRpc
  await verifyDevnet(rpc)
  const bridge = await OperatorBridge.start({ timeoutMs: operatorTimeout(env) })
  process.stderr.write(`\nOpen the local conformance operator in Chrome:\n${bridge.operatorUrl}\n\n`)
  const walletAddress = String(toAddress(await bridge.waitForWallet()))
  const signer = inertTransactionSigner(walletAddress)

  return {
    walletSigner: {
      publicKey: walletAddress,
      async signMessage(message: Uint8Array): Promise<Uint8Array> {
        const result = await bridge.request({
          kind: 'sign_message',
          messageBase64: encodeBase64(message),
          summary: {
            messageSha256: sha256(message),
            title: 'Approve the Ember ownership challenge',
            walletAddress,
          },
        })
        if (result.outcome === 'rejected') throw new Error(result.reason)
        if (result.outcome !== 'signed_message') {
          throw new Error('The operator returned the wrong approval result')
        }
        const signedMessage = decodeBase64(result.signedMessageBase64)
        if (!sameBytes(signedMessage, message)) {
          throw new Error('The wallet signed different message bytes')
        }
        const signature = decodeBase64(result.signatureBase64)
        if (signature.byteLength !== 64) {
          throw new Error('The wallet returned an invalid Ed25519 signature')
        }
        return signature
      },
    },

    async submitQuotedPayment({
      quote,
    }: {
      quote: SignedQuoteResponse
    }): Promise<{ paymentSignature: string; simulationPassed: true }> {
      const contract = validateCoveragePaymentContract(quote, {
        environment: 'sandbox',
        expectedCluster: 'devnet',
        expectedGenesisHash: DEVNET_GENESIS_HASH,
        nowMs: Date.now(),
        walletAddress,
      })
      const prepared = await prepareCoveragePaymentTransaction({
        cluster: 'devnet',
        contract,
        expectedGenesisHash: DEVNET_GENESIS_HASH,
        rpc,
        signMessage: async () => {
          throw new Error('Payment signing must use Wallet Standard')
        },
        walletAddress,
      })
      if (prepared.preview.simulation.status !== 'success') {
        throw new Error(
          prepared.preview.simulation.error ?? 'The payment simulation failed',
        )
      }
      const unsignedBytes = new Uint8Array(
        Buffer.from(
          String(getBase64EncodedWireTransaction(compileTransaction(prepared.transactionMessage))),
          'base64',
        ),
      )
      const unsignedBase64 = encodeBase64(unsignedBytes)
      const signedBytes = await signedTransactionFromOperator({
        amount: prepared.preview.amountDisplay,
        asset: prepared.preview.asset,
        bridge,
        feeLamports: prepared.preview.feeLamports,
        recipient: prepared.preview.treasuryTokenAccount,
        title: 'Approve the quote-bound Ember coverage payment',
        transactionBase64: unsignedBase64,
        transactionSha256: sha256(unsignedBytes),
        walletAddress,
      })
      return {
        paymentSignature: await broadcast(rpc, signedBytes),
        simulationPassed: true,
      }
    },

    async prepareCoveredTransaction({
      coverage,
      quote,
    }: {
      coverage: CoverageInstanceResponse
      quote: SignedQuoteResponse
    }) {
      validateCoveragePaymentContract(quote, {
        environment: 'sandbox',
        expectedCluster: 'devnet',
        expectedGenesisHash: DEVNET_GENESIS_HASH,
        nowMs: Date.now(),
        walletAddress,
      })
      if (coverage.protectedWallet !== walletAddress || coverage.status !== 'active') {
        throw new Error('The active coverage does not belong to the operator wallet')
      }
      if (Date.now() >= Date.parse(coverage.coverageEndsAt)) {
        throw new Error('The conformance coverage has expired')
      }
      const latestBlockhash = await rpc
        .getLatestBlockhash({ commitment: 'confirmed' })
        .send()
      const balance = await rpc
        .getBalance(toAddress(walletAddress), { commitment: 'confirmed' })
        .send()
      const instruction = getTransferSolInstruction({
        amount: transferLamports,
        destination: toAddress(recipient),
        source: signer,
      })
      const transactionMessage = pipe(
        createTransactionMessage({ version: 0 }),
        (message) => setTransactionMessageFeePayerSigner(signer, message),
        (message) =>
          setTransactionMessageLifetimeUsingBlockhash(
            {
              blockhash: toBlockhash(latestBlockhash.value.blockhash),
              lastValidBlockHeight: BigInt(latestBlockhash.value.lastValidBlockHeight),
            },
            message,
          ),
        (message) => appendTransactionMessageInstruction(instruction, message),
      )
      const unsignedBase64 = String(
        getBase64EncodedWireTransaction(compileTransaction(transactionMessage)),
      )
      const simulation = await rpc
        .simulateTransaction(unsignedBase64 as Base64EncodedWireTransaction, {
          commitment: 'confirmed',
          encoding: 'base64',
          replaceRecentBlockhash: false,
          sigVerify: false,
        })
        .send()
      if (simulation.value.err) {
        throw new Error('The controlled Devnet transaction simulation failed')
      }
      const feeLamports = BigInt(simulation.value.fee ?? 5_000)
      if (BigInt(balance.value) < transferLamports + feeLamports) {
        throw new Error('The operator wallet has insufficient Devnet SOL')
      }
      const unsignedBytes = decodeBase64(unsignedBase64)
      const prepared: PreparedControlledTransaction = {
        coverageInstanceId: coverage.coverageInstanceId,
        feeLamports: feeLamports.toString(),
        kind: 'prepared_conformance_transfer',
        recipient,
        transactionBase64: unsignedBase64,
        transactionSha256: sha256(unsignedBytes),
        transferLamports: transferLamports.toString(),
        walletAddress,
      }
      return {
        simulationPassed: true,
        request: {
          kind: 'transaction' as const,
          coverageInstanceId: coverage.coverageInstanceId,
          transactionBytes: unsignedBase64,
        },
        prepared,
      }
    },

    async signAndBroadcast({
      decision,
      prepared,
    }: {
      decision: CoverageDecisionResponse
      prepared: { prepared?: unknown }
    }) {
      const controlled = preparedControlledTransaction(prepared.prepared)
      if (
        decision.kind !== 'transaction' ||
        decision.coverStatus !== 'covered' ||
        decision.coverageInstanceId !== controlled.coverageInstanceId ||
        decision.protectedWallet !== walletAddress
      ) {
        throw new Error('The coverage decision does not match the controlled transaction')
      }
      if (Date.now() >= Date.parse(decision.decisionExpiresAt)) {
        throw new Error('The coverage decision expired before wallet approval')
      }
      const signedBytes = await signedTransactionFromOperator({
        amount: controlled.transferLamports,
        asset: 'lamports',
        bridge,
        feeLamports: controlled.feeLamports,
        recipient: controlled.recipient,
        title: 'Approve the controlled covered Devnet transaction',
        transactionBase64: controlled.transactionBase64,
        transactionSha256: controlled.transactionSha256,
        walletAddress,
      })
      if (Date.now() >= Date.parse(decision.decisionExpiresAt)) {
        throw new Error('The coverage decision expired during wallet approval')
      }
      const broadcastSignature = await broadcast(rpc, signedBytes)
      return {
        broadcastSignature,
        evidence: {
          kind: 'transaction' as const,
          signedBytes: encodeBase64(signedBytes),
        },
        simulationPassed: true,
      }
    },

    async evidenceForRequest(_args: {
      claim: WalletClaimResponse
      evidenceRequest: WalletClaimEvidenceRequest
    }) {
      return {
        bytes: new TextEncoder().encode(
          'Synthetic Ember SDK conformance evidence. No customer data.',
        ),
        contentType: 'text/plain',
      }
    },
  }
}
