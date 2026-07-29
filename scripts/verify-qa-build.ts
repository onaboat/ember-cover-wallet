import { createHash } from 'node:crypto'
import {
  readFile,
  readdir,
  stat,
} from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUTPUT = path.join(ROOT, '.output', 'chrome-mv3')
const SDK_TARBALL = path.join(
  ROOT,
  'vendor',
  'embercover-wallet-sdk-1.3.1.tgz',
)
const EXPECTED_SDK_SHA256 =
  'fc2f3dff25186a4306ee286ea3363715f68962429353a8c2d321ba47e38038e8'
const RETIRED_BUNDLE_MARKERS = [
  'EMBER_PARTNER_API_KEY',
  'test-partner-key',
  'WXT_COVER_',
  'WXT_EMBER_PAY_',
  'WXT_SOLANA_DEVNET_RPC_URL',
  'WXT_SOLANA_MAINNET_RPC_URL',
  'x-ember-auth',
  '/v1/cover/pre-sign',
  'workers.dev',
]

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for a Devnet QA release build`)
  return value
}

function exactOrigin(value: string, name: string): URL {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    throw new Error(`${name} must be an exact HTTPS origin`)
  }
  return url
}

function extensionIdFromPublicKey(publicKeyBase64: string): string {
  const der = Buffer.from(publicKeyBase64, 'base64')
  if (der.length === 0 || der.toString('base64').replace(/=+$/, '') !== publicKeyBase64.replace(/=+$/, '')) {
    throw new Error('WXT_EXTENSION_PUBLIC_KEY must be canonical base64 DER public-key bytes')
  }
  const first128Bits = createHash('sha256').update(der).digest().subarray(0, 16)
  return [...first128Bits]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + nibble))
    .join('')
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory)
  const files: string[] = []
  for (const entry of entries.sort()) {
    const file = path.join(directory, entry)
    if ((await stat(file)).isDirectory()) files.push(...(await filesUnder(file)))
    else files.push(file)
  }
  return files
}

async function scanBundle(): Promise<void> {
  for (const file of await filesUnder(OUTPUT)) {
    const bytes = await readFile(file)
    if (bytes.includes(0)) continue
    const text = bytes.toString('utf8')
    for (const marker of RETIRED_BUNDLE_MARKERS) {
      if (text.includes(marker)) {
        throw new Error(`Built bundle contains retired secret/route marker "${marker}" in ${file}`)
      }
    }
  }
}

const sdkDigest = await sha256(SDK_TARBALL)
if (sdkDigest !== EXPECTED_SDK_SHA256) {
  throw new Error(`Vendored SDK digest mismatch: ${sdkDigest}`)
}

const manifest = JSON.parse(
  await readFile(path.join(OUTPUT, 'manifest.json'), 'utf8'),
) as {
  host_permissions?: string[]
  key?: string
  version?: string
}
if (manifest.version !== '0.16.0') {
  throw new Error(`Expected manifest version 0.16.0, received ${manifest.version ?? 'missing'}`)
}

if (requiredEnvironment('WXT_EMBER_ENVIRONMENT') !== 'sandbox') {
  throw new Error('A Devnet QA release build must use WXT_EMBER_ENVIRONMENT=sandbox')
}
const api = exactOrigin(
  requiredEnvironment('WXT_EMBER_API_BASE_URL'),
  'WXT_EMBER_API_BASE_URL',
)
const rpc = exactOrigin(
  requiredEnvironment('WXT_SOLANA_RPC_URL'),
  'WXT_SOLANA_RPC_URL',
)
const integrationId = requiredEnvironment('WXT_EMBER_INTEGRATION_ID')
if (integrationId !== 'integration_reference-wallet') {
  throw new Error('Devnet QA must use integration_reference-wallet')
}
const publicKey = requiredEnvironment('WXT_EXTENSION_PUBLIC_KEY')
const configuredId = requiredEnvironment('WXT_EMBER_EXTENSION_ID')
const derivedId = extensionIdFromPublicKey(publicKey)
if (configuredId !== derivedId) {
  throw new Error(
    `WXT_EMBER_EXTENSION_ID ${configuredId} does not match public manifest key (${derivedId})`,
  )
}
if (manifest.key !== publicKey) {
  throw new Error('Built manifest does not contain the approved public extension key')
}
const expectedHosts = [`${api.origin}/*`, `${rpc.origin}/*`].sort()
const actualHosts = [...(manifest.host_permissions ?? [])].sort()
if (JSON.stringify(actualHosts) !== JSON.stringify(expectedHosts)) {
  throw new Error(
    `Manifest host permissions are not exact: ${JSON.stringify(actualHosts)}`,
  )
}

await scanBundle()
console.log(
  JSON.stringify({
    bundle: 'verified',
    sdkSha256: sdkDigest,
    version: manifest.version,
  }),
)
