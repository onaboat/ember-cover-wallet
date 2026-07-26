import { expect, test } from 'vitest'

import { MemoryVaultStore } from './memory-store.ts'
import { Vault } from './vault.ts'

test('a created+unlocked vault signs', async () => {
  const v = new Vault(new MemoryVaultStore())
  await v.create('Str0ng-pass-correct-horse')
  await v.unlock('Str0ng-pass-correct-horse')
  const sig = await v.sign(new TextEncoder().encode('hello'))
  expect(sig.length).toBe(64)
})

test('unlock with the wrong password rejects', async () => {
  const v = new Vault(new MemoryVaultStore())
  await v.create('Str0ng-pass-correct-horse')
  await expect(v.unlock('nope-wrong-password')).rejects.toThrow()
})

test('signing while locked rejects', async () => {
  const v = new Vault(new MemoryVaultStore())
  await v.create('Str0ng-pass-correct-horse')
  await expect(v.sign(new Uint8Array([1]))).rejects.toThrow('locked')
})

test('auto-locks after the idle window', async () => {
  let t = 1000
  const v = new Vault(new MemoryVaultStore(), { now: () => t, idleLockMs: 5000 })
  await v.create('Str0ng-pass-correct-horse')
  await v.unlock('Str0ng-pass-correct-horse')
  t += 6000
  await expect(v.sign(new TextEncoder().encode('x'))).rejects.toThrow('locked')
})

test('locks out after repeated wrong passwords', async () => {
  const t = 1000
  const v = new Vault(new MemoryVaultStore(), { now: () => t, maxFailedAttempts: 3, lockoutMs: 60000 })
  await v.create('Str0ng-pass-correct-horse')
  for (let i = 0; i < 3; i += 1) {
    await v.unlock('wrong-password-here').catch(() => {})
  }
  await expect(v.unlock('Str0ng-pass-correct-horse')).rejects.toThrow('locked out')
})

test('lockout lifts after the cooldown', async () => {
  let t = 1000
  const v = new Vault(new MemoryVaultStore(), { now: () => t, maxFailedAttempts: 2, lockoutMs: 60000 })
  await v.create('Str0ng-pass-correct-horse')
  await v.unlock('wrong-password-here').catch(() => {})
  await v.unlock('wrong-password-here').catch(() => {})
  t += 61000
  await v.unlock('Str0ng-pass-correct-horse')
  expect((await v.sign(new TextEncoder().encode('x'))).length).toBe(64)
})

test('backup exports and re-imports into a fresh store', async () => {
  const source = new Vault(new MemoryVaultStore())
  await source.create('Str0ng-pass-correct-horse')
  const blob = await source.exportBackup()

  const freshStore = new MemoryVaultStore()
  await Vault.importBackup(freshStore, blob, 'Str0ng-pass-correct-horse')
  const restored = new Vault(freshStore)
  await restored.unlock('Str0ng-pass-correct-horse')
  expect((await restored.sign(new TextEncoder().encode('hi'))).length).toBe(64)
})

test('backup import rejects invalid files before expensive password work', async () => {
  await expect(
    Vault.importBackup(new MemoryVaultStore(), '{"argon2Params":{"m":999999999}}', 'password'),
  ).rejects.toThrow('invalid')
})

test('backup import reports a wrong password without persisting the backup', async () => {
  const source = new Vault(new MemoryVaultStore())
  await source.create('Str0ng-pass-correct-horse')
  const backup = await source.exportBackup()
  const destination = new MemoryVaultStore()

  await expect(Vault.importBackup(destination, backup, 'wrong-password')).rejects.toThrow(
    'password is wrong',
  )
  expect(await destination.get()).toBeNull()
})

test('reports unlocked state', async () => {
  const v = new Vault(new MemoryVaultStore())
  await v.create('Str0ng-pass-correct-horse')
  await v.unlock('Str0ng-pass-correct-horse')
  expect(v.isUnlocked()).toBe(true)
})
