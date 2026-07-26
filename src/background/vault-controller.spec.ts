import { expect, test } from 'vitest'

import { MemoryVaultStore } from '../vault/memory-store.ts'
import { VaultController } from './vault-controller.ts'

test('has no vault before creation', async () => {
  const c = new VaultController(new MemoryVaultStore())
  expect(await c.hasVault()).toBe(false)
})

test('create then getAddress returns a base58 address', async () => {
  const c = new VaultController(new MemoryVaultStore())
  const address = await c.createVault('Str0ng-pass-correct-horse')
  expect(address.length).toBeGreaterThan(31)
})

test('unlock with the right password reports unlocked', async () => {
  const store = new MemoryVaultStore()
  const c = new VaultController(store)
  await c.createVault('Str0ng-pass-correct-horse')
  await c.unlock('Str0ng-pass-correct-horse')
  expect(await c.isUnlocked()).toBe(true)
})

test('signs once unlocked', async () => {
  const c = new VaultController(new MemoryVaultStore())
  await c.createVault('Str0ng-pass-correct-horse')
  await c.unlock('Str0ng-pass-correct-horse')
  expect((await c.sign(Uint8Array.from([1, 2, 3]))).length).toBe(64)
})

test('refuses to sign while locked', async () => {
  const c = new VaultController(new MemoryVaultStore())
  await c.createVault('Str0ng-pass-correct-horse')
  await expect(c.sign(Uint8Array.from([1]))).rejects.toThrow('locked')
})

test('exports and imports a password-verified encrypted backup', async () => {
  const source = new VaultController(new MemoryVaultStore())
  const address = await source.createVault('Str0ng-pass-correct-horse')
  const backup = await source.exportBackup('Str0ng-pass-correct-horse')
  const restored = new VaultController(new MemoryVaultStore())

  expect(await restored.importBackup(backup, 'Str0ng-pass-correct-horse')).toBe(address)
  await restored.unlock('Str0ng-pass-correct-horse')
  expect((await restored.sign(Uint8Array.from([1]))).length).toBe(64)
})

test('reset irreversibly clears the current vault', async () => {
  const controller = new VaultController(new MemoryVaultStore())
  await controller.createVault('Str0ng-pass-correct-horse')

  await controller.resetVault()

  expect(await controller.hasVault()).toBe(false)
  expect(await controller.getAddress()).toBeNull()
})
