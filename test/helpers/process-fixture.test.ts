import { execa } from 'execa'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { expectProcessStopped, processExists } from './process-fixture.js'

vi.mock('execa', () => ({ execa: vi.fn() }))
afterEach(() => {
  vi.mocked(execa).mockReset()
  vi.restoreAllMocks()
})

describe('process fixture observations', () => {
  it('does not mistake a permission failure for a reaped process', () => {
    const denied = Object.assign(new Error('access denied'), { code: 'EPERM' })
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw denied
    })
    expect(() => processExists(1234)).toThrow(denied)
  })

  it.skipIf(process.platform === 'win32')('distinguishes an exited orphan from a reaped child', async () => {
    vi.spyOn(process, 'kill').mockReturnValue(true)
    vi.mocked(execa).mockResolvedValue({ stdout: '1234 Z\n5678 S' } as never)
    await expectProcessStopped(1234)
    expect(processExists(1234)).toBe(true)
    await expect(expectProcessStopped(5678)).rejects.toThrow('is still active (state: S)')
  })

  it.skipIf(process.platform === 'win32')('accepts an absent PID but retains inspection failures', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ stdout: '5678 S' } as never)
    await expectProcessStopped(1234)
    const unavailable = Object.assign(new Error('ps unavailable'), { code: 'ENOENT' })
    vi.mocked(execa).mockRejectedValueOnce(unavailable)
    await expect(expectProcessStopped(1234)).rejects.toBe(unavailable)
  })

  it.skipIf(process.platform !== 'win32')('requires PID disappearance for a Windows job member', async () => {
    vi.spyOn(process, 'kill').mockReturnValueOnce(true).mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    })
    await expect(expectProcessStopped(1234)).rejects.toThrow()
    await expectProcessStopped(1234)
  })
})
