import { describe, expect, it, vi } from 'vitest'
import { normalizeMatrixConfig } from '../../src/config/index.js'
import { createExecutionPlan } from '../../src/execution/plan.js'
import { assertSafeOutputDirectory } from '../../src/utils/output.js'

// Select the real Windows path implementation at the OS boundary so drive/UNC
// regressions are observable on every CI host, without touching the filesystem.
vi.mock('node:path', async (importOriginal) => {
  const native = await importOriginal<typeof import('node:path')>()
  return { ...native, default: native.win32 }
})

describe('windows filesystem paths in execution plans', () => {
  it.each([
    { root: 'C:/work/app', output: 'C:/', expected: 'C:/', unsafe: true },
    { root: '//server/share/app', output: '//server/share', expected: '//server/share/', unsafe: true },
    { root: 'C:/work/app', output: 'D:/', expected: 'D:/', unsafe: true },
    { root: 'C:/work/app', output: 'D:/artifacts', expected: 'D:/artifacts', unsafe: false },
    { root: 'C:/work/app', output: '//storage/releases', expected: '//storage/releases/', unsafe: true },
    { root: 'C:/work/app', output: '//storage/releases/artifacts', expected: '//storage/releases/artifacts', unsafe: false },
    { root: 'C:/', output: 'dist', expected: 'C:/dist', unsafe: false },
    { root: 'C:/Work/App', output: 'c:/work/app', expected: 'C:/work/app', unsafe: true },
    { root: 'C:/Work/App', output: 'C:/WORK', expected: 'C:/WORK', unsafe: true },
    { root: 'C:/Work/App', output: 'C:/Work/App-other', expected: 'C:/Work/App-other', unsafe: false },
    { root: '//server/share/App', output: '//SERVER/share', expected: '//SERVER/share/', unsafe: true },
    { root: 'C:/work/app', output: '//?/UNC/storage/releases', expected: '//?/UNC/storage/releases', unsafe: true },
    { root: 'C:/work/app', output: '//?/C:/work/app', expected: '//?/C:/work/app', unsafe: true },
    { root: '//?/C:/work/app', output: 'C:/work/app', expected: 'C:/work/app', unsafe: true },
  ])('preserves $root -> $output through planning and cleanup validation', ({ root, output, expected, unsafe }) => {
    const normalized = normalizeMatrixConfig({
      artifacts: { root: '//storage/releases/matrix' },
      projects: { app: { root, prepare: 'must-not-run', targets: { build: { command: 'must-not-run', outputDir: output, artifacts: {} } } } },
      products: { app: { version: '1.0.0', variants: { web: 'app' } } },
    })
    const plan = createExecutionPlan({
      ...normalized,
      cwd: 'D:/a/matrix/matrix',
      envName: 'production',
      productNames: ['app'],
      target: 'build',
      externalEnv: {},
    })
    const task = plan.tasks[0]!
    expect(task).toMatchObject({ projectRoot: root, cwd: root, outputDir: expected })
    expect(plan.preparations?.[0]?.cwd).toBe(root)
    expect(plan.artifactsRoot).toBe('//storage/releases/matrix')
    if (unsafe)
      expect(() => assertSafeOutputDirectory(task.projectRoot, task.outputDir)).toThrow('unsafe output directory')
    else
      expect(() => assertSafeOutputDirectory(task.projectRoot, task.outputDir)).not.toThrow()
  })

  it.each(['//?/UNC/storage/releases', '//?/C:/work/app', '//./C:/work/app'])('rejects namespace paths at the cleanup boundary: %s', (output) => {
    for (const candidate of [output, output.replaceAll('/', '\\')])
      expect(() => assertSafeOutputDirectory('C:/work/app', candidate)).toThrow('unsafe output directory')
  })
})
