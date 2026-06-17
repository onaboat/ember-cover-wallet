import { expect, test, vi } from 'vitest'

vi.mock('./request-service.ts', () => ({ requestService: vi.fn() }))

import { requestService } from './request-service.ts'
import { connect } from './actions.ts'

test('connect routes to requestService.create with type, input, origin', async () => {
  const create = vi.fn(async () => ({ accounts: [] }))
  vi.mocked(requestService).mockReturnValue({ create } as never)
  await connect(undefined, 'https://x')
  expect(create).toHaveBeenCalledWith('connect', undefined, 'https://x')
})
