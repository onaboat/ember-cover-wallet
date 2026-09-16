import { afterEach, expect, test } from 'vitest'

import { OperatorBridge } from './operator-bridge.ts'

const bridges: OperatorBridge[] = []

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()))
})

async function start(timeoutMs = 2_000): Promise<OperatorBridge> {
  const bridge = await OperatorBridge.start({
    operatorScript: 'console.log("operator fixture")',
    timeoutMs,
    walletName: 'Neutral Wallet',
  })
  bridges.push(bridge)
  return bridge
}

function authorization(bridge: OperatorBridge): HeadersInit {
  return { authorization: `Bearer ${bridge.token}` }
}

test('rejects unauthenticated loopback requests', async () => {
  const bridge = await start()
  const response = await fetch(new URL('/api/state', bridge.operatorUrl))
  expect(response.status).toBe(401)
})

test('serves the configured external wallet name as escaped operator data', async () => {
  const bridge = await OperatorBridge.start({
    operatorScript: 'console.log("operator fixture")',
    walletName: 'Neutral "QA" <Wallet>',
  })
  bridges.push(bridge)
  const response = await fetch(bridge.operatorUrl)
  expect(response.status).toBe(200)
  const html = await response.text()
  expect(html).toContain('content="Neutral &quot;QA&quot; &lt;Wallet&gt;"')
  expect(html).not.toContain('content="Neutral "QA" <Wallet>"')
})

test('binds one wallet and resolves one exact message approval', async () => {
  const bridge = await start()
  const walletAddress = 'So11111111111111111111111111111111111111112'
  const connect = await fetch(new URL('/api/connect', bridge.operatorUrl), {
    method: 'POST',
    headers: {
      ...authorization(bridge),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ walletAddress, walletName: 'Neutral Wallet' }),
  })
  expect(connect.status).toBe(200)
  await expect(bridge.waitForWallet()).resolves.toBe(walletAddress)

  const approval = bridge.request({
    kind: 'sign_message',
    messageBase64: 'aGVsbG8=',
    summary: {
      messageSha256: 'a'.repeat(64),
      title: 'Approve test message',
      walletAddress,
    },
  })
  const stateResponse = await fetch(new URL('/api/state', bridge.operatorUrl), {
    headers: authorization(bridge),
  })
  const state = (await stateResponse.json()) as {
    job: { id: string; kind: string } | null
  }
  expect(state.job?.kind).toBe('sign_message')

  const result = await fetch(new URL('/api/result', bridge.operatorUrl), {
    method: 'POST',
    headers: {
      ...authorization(bridge),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      id: state.job?.id,
      outcome: 'signed_message',
      signatureBase64: 'c2lnbmF0dXJl',
      signedMessageBase64: 'aGVsbG8=',
      walletAddress,
    }),
  })
  expect(result.status).toBe(200)
  await expect(approval).resolves.toMatchObject({
    outcome: 'signed_message',
    walletAddress,
  })
})

test('rejects a wallet change during a run', async () => {
  const bridge = await start()
  const connect = async (walletAddress: string) =>
    await fetch(new URL('/api/connect', bridge.operatorUrl), {
      method: 'POST',
      headers: {
        ...authorization(bridge),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ walletAddress, walletName: 'Neutral Wallet' }),
    })
  expect((await connect('wallet_one')).status).toBe(200)
  const changed = await connect('wallet_two')
  expect(changed.status).toBe(400)
  await expect(changed.json()).resolves.toMatchObject({
    error: 'Operator wallet cannot change during a conformance run',
  })
})

test('allows only one pending operator request', async () => {
  const bridge = await start()
  await fetch(new URL('/api/connect', bridge.operatorUrl), {
    method: 'POST',
    headers: {
      ...authorization(bridge),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      walletAddress: 'wallet_one_request',
      walletName: 'Neutral Wallet',
    }),
  })
  const first = bridge.request({
    kind: 'sign_message',
    messageBase64: 'Zmlyc3Q=',
    summary: {
      messageSha256: 'a'.repeat(64),
      title: 'First request',
      walletAddress: 'wallet_one_request',
    },
  })

  await expect(
    bridge.request({
      kind: 'sign_message',
      messageBase64: 'c2Vjb25k',
      summary: {
        messageSha256: 'b'.repeat(64),
        title: 'Second request',
        walletAddress: 'wallet_one_request',
      },
    }),
  ).rejects.toThrow('already pending')

  await bridge.close()
  await expect(first).rejects.toThrow('Operator bridge closed')
  bridges.splice(bridges.indexOf(bridge), 1)
})

test('times out instead of approving or retrying automatically', async () => {
  const bridge = await start(20)
  await fetch(new URL('/api/connect', bridge.operatorUrl), {
    method: 'POST',
    headers: {
      ...authorization(bridge),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      walletAddress: 'wallet_timeout',
      walletName: 'Neutral Wallet',
    }),
  })
  await expect(
    bridge.request({
      kind: 'sign_message',
      messageBase64: 'aGVsbG8=',
      summary: {
        messageSha256: 'a'.repeat(64),
        title: 'Approve test message',
        walletAddress: 'wallet_timeout',
      },
    }),
  ).rejects.toThrow('Operator approval timed out')
})

test('rejects Ember as the SDK runner signer', async () => {
  await expect(
    OperatorBridge.start({
      operatorScript: 'console.log("operator fixture")',
      walletName: 'Ember',
    }),
  ).rejects.toThrow('owns its own cover decision flow')
})

test('rejects a connected wallet whose name differs from the configured signer', async () => {
  const bridge = await start()
  const response = await fetch(new URL('/api/connect', bridge.operatorUrl), {
    method: 'POST',
    headers: {
      ...authorization(bridge),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      walletAddress: 'wallet_wrong_name',
      walletName: 'Another Wallet',
    }),
  })
  expect(response.status).toBe(400)
  await expect(response.json()).resolves.toMatchObject({
    error: 'Connected wallet does not match the configured conformance signer',
  })
})
