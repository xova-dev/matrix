import type { CreateExecutionPlanInput, MatrixConfig } from '../types.js'
import { stat } from 'node:fs/promises'
import { MATRIX_DEFAULTS } from '../config/defaults.js'
import { assertSafeOutputDirectory } from '../utils/output.js'
import { resolveFilesystemPath } from '../utils/path.js'
import { createExecutionPlan, dependencyCondition, ExecutionPlanError } from './plan.js'

interface Diagnostic {
  severity: 'error' | 'warning'
  subject: string
  path: string
  message: string
  suggestion: string
  blockedTasks?: string[]
}

type DoctorInput = Omit<CreateExecutionPlanInput, 'productNames' | 'variantNames' | 'target'> & { config: MatrixConfig }

function targetFieldPath(input: DoctorInput, product: string, variant: string, target: string, field: string): string {
  const project = input.products[product]!.variants[variant]!.project
  const rawVariant = input.config.products[product]?.variants[variant]
  const override = typeof rawVariant === 'object' ? rawVariant.targets?.[target] : undefined
  const variantField = override && typeof override === 'object' && Object.hasOwn(override, field)
  const base = variantField || !input.config.projects[project]?.targets[target]
    ? `products.${product}.variants.${variant}.targets.${target}`
    : `projects.${project}.targets.${target}`
  return `${base}.${field}`
}

/** Inspect configured tasks without running commands, probing services, or writing files. */
export async function diagnoseWorkspace(input: DoctorInput): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = []
  const planErrors = new Map<string, Diagnostic>()
  for (const [name, project] of Object.entries(input.projects)) {
    const root = resolveFilesystemPath(input.cwd, project.root ?? MATRIX_DEFAULTS.projectRoot)
    try {
      if ((await stat(root)).isDirectory())
        continue
      diagnostics.push({
        severity: 'error',
        subject: name,
        path: `projects.${name}.root`,
        message: 'Project root is not a directory.',
        suggestion: 'Set root to an existing project directory.',
      })
    }
    catch {
      diagnostics.push({
        severity: 'error',
        subject: name,
        path: `projects.${name}.root`,
        message: 'Project directory is missing or inaccessible.',
        suggestion: 'Create the project directory, correct root, or grant read access.',
      })
    }
  }

  for (const [productName, product] of Object.entries(input.products)) {
    for (const [variantName, variant] of Object.entries(product.variants)) {
      for (const [targetName, target] of Object.entries(variant.targets)) {
        const subject = [productName, variantName, targetName].join(':')
        const fieldPath = (field: string): string => targetFieldPath(input, productName, variantName, targetName, field)
        const project = input.projects[variant.project]
        if (project && !target.continuous && target.artifacts?.clean) {
          const root = resolveFilesystemPath(input.cwd, project.root ?? MATRIX_DEFAULTS.projectRoot)
          try {
            assertSafeOutputDirectory(root, resolveFilesystemPath(root, target.outputDir))
          }
          catch {
            diagnostics.push({
              severity: 'error',
              subject,
              path: fieldPath('outputDir'),
              message: 'Output cleanup would delete the project root or an ancestor.',
              suggestion: 'Choose a safe outputDir, or set artifacts.clean to false if cleanup is not intended.',
            })
          }
        }

        for (const [index, dependency] of target.dependsOn.entries()) {
          const dependencyTargetName = dependency.target ?? targetName
          const dependencyTarget = product.variants[dependency.variant]?.targets[dependencyTargetName]
          if (!dependencyTarget)
            continue // The planner reports missing references below.
          const condition = dependencyCondition(dependency, dependencyTarget)
          const dependencyId = [productName, dependency.variant, dependencyTargetName].join(':')
          if (condition === 'completed' && dependencyTarget.continuous) {
            diagnostics.push({
              severity: 'warning',
              subject,
              path: `${fieldPath('dependsOn')}[${index}]`,
              message: `A completed dependency points to continuous task ${dependencyId}; it may never finish.`,
              suggestion: 'Use condition: ready for a service, or make the dependency non-continuous.',
            })
          }
          else if (condition === 'ready' && !dependencyTarget.readyWhen) {
            diagnostics.push({
              severity: 'warning',
              subject,
              path: `${fieldPath('dependsOn')}[${index}]`,
              message: `Ready dependency ${dependencyId} has no readiness probe; process start does not guarantee service readiness.`,
              suggestion: 'Configure readyWhen on the dependency, or use completed for a finite task.',
            })
          }
        }

        try {
          // Keep graph, environment, and package/version resolution identical to execution.
          createExecutionPlan({ ...input, productNames: [productName], variantNames: [variantName], target: targetName })
        }
        catch (error) {
          if (!(error instanceof ExecutionPlanError))
            throw error
          const origin = error.context
          const originSubject = [origin.product, origin.variant, origin.target].join(':')
          const diagnosticPath = origin.path ?? targetFieldPath(input, origin.product, origin.variant, origin.target, 'dependsOn')
            + (origin.dependencyIndex === undefined ? '' : `[${origin.dependencyIndex}]`)
          const key = JSON.stringify(origin.cycle
            ? ['cycle', ...origin.cycle]
            : ['task', originSubject, diagnosticPath, error.message])
          let diagnostic = planErrors.get(key)
          if (!diagnostic) {
            diagnostic = {
              severity: 'error',
              subject: originSubject,
              path: diagnosticPath,
              message: origin.cycle
                ? `Dependency cycle detected: ${[...origin.cycle, origin.cycle[0]].join(' -> ')}`
                : error.message,
              suggestion: origin.kind === 'dependency'
                ? 'Correct dependsOn to reference existing variants and targets, and remove dependency cycles.'
                : origin.kind === 'environment'
                  ? 'Correct the environment override or schema default to match its declared type.'
                  : 'Correct the indicated version source; package fallback requires a readable package.json with a valid version, or an explicit product/variant.version.',
            }
            planErrors.set(key, diagnostic)
            diagnostics.push(diagnostic)
          }
          if (origin.cycle ? !origin.cycle.includes(subject) : subject !== originSubject) {
            diagnostic.blockedTasks ??= []
            if (!diagnostic.blockedTasks.includes(subject))
              diagnostic.blockedTasks.push(subject)
          }
        }
      }
    }
  }
  return diagnostics
}
