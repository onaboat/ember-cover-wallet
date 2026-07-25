# Ember Cover one-off payment

The extension implements the Ember API prepaid activation contract on Solana
Devnet.

## Payment contract

- Cluster: `devnet`
- Token: Devnet USDC
- Mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- Amount: `1_000_000` base units (1 USDC at 6 decimals)
- Treasury token account: `AmXrozEs535RMiwSxkjhcyuq5reC9ntvtBXCef8wCP6s`
- Tier: Core
- Duration: 30 days
- Token program: classic SPL Token

The wallet constructs exactly one `TransferChecked` instruction. It does not
create a delegate, recurring authority, subscription PDA, or cancellation
transaction.

## Activation sequence

1. Derive the wallet's USDC associated token account.
2. Read USDC and SOL balances.
3. Construct and simulate the exact transfer.
4. Show amount, token, source wallet, treasury, fee payer, fee, and cluster.
5. Only after the user clicks the payment button, build again, simulate again,
   sign, and save the signed bytes and signature locally.
6. Broadcast and wait for confirmed or finalized status.
7. Authorize the wallet's Ember session and send
   `{ walletPublicKey, cluster, paymentSignature }` to
   `/entitlements/payments/activate` through the Worker.
8. Save the API's active state and `currentPeriodEnd`.

If the wallet closes or the API is unavailable after signing, retry uses the
same signed transaction and payment signature. It does not create a new
transfer.

## Runtime configuration

Set the Alchemy endpoint in `.env.local`:

```dotenv
WXT_SOLANA_DEVNET_RPC_URL=https://solana-devnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
```

The Worker must use:

```toml
EMBER_API = "https://ember-production-de2c.up.railway.app"
```

The Railway public URL has no `:8080` suffix and no `/v1`; the Worker adds
`/v1` when forwarding.
