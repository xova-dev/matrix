import type { ArgsDef } from 'citty'
import { parseArgs as parseNodeArgs } from 'node:util'
import { defineCommand, renderUsage } from 'citty'

export const CLI_COMMANDS = { help: 'help', plan: 'plan', doctor: 'doctor', prepare: 'prepare' } as const

export interface Args {
  command?: string
  product?: string
  variants: string[]
  env?: string
  target?: string
  help?: boolean
}

const options = {
  product: { type: 'string', short: 'p', description: 'Product key (alternative to the second positional argument)' },
  variant: { type: 'string', short: 'v', multiple: true, description: 'Comma-separated variants; repeatable. Defaults to all variants' },
  env: { type: 'string', short: 'e', description: 'Configuration environment; defaults from the target' },
  target: { type: 'string', short: 't', description: 'Target for plan or --product' },
  help: { type: 'boolean', short: 'h', description: 'Show help without loading configuration' },
} as const

const definition = {
  action: { type: 'positional', required: false, description: 'Configured target, plan, doctor, prepare, or help' },
  name: { type: 'positional', required: false, description: 'Product key' },
  ...Object.fromEntries(Object.entries(options).map(([name, option]) => [name, { type: option.type, alias: option.short, description: option.description }])),
} satisfies ArgsDef

const command = defineCommand({
  meta: { name: 'matrix', description: 'Run a product across workspace projects' },
  args: definition,
})

export async function cliHelp(): Promise<string> {
  return [
    await renderUsage(command),
    'COMMANDS',
    '  plan       Print an execution plan with resolved project environment values (may contain secrets)',
    '  doctor     Validate configuration and dependency graphs; accepts --env',
    '  prepare    Run project preparation and generate runtime types for all or one product',
    '  <target>   Run any target defined in matrix.config.ts',
    '',
    'EXAMPLES',
    '  matrix                              Choose a product and action interactively',
    '  matrix dev                          Choose a product if needed (TTY only)',
    '  matrix dev app                      Run directly with target defaults',
    '  matrix build app -v web -e staging',
    '  matrix plan app -t dist -e production',
    '  matrix -p app -t dev',
    '',
    'In a terminal, missing product/action selections open the wizard. Complete commands',
    'run immediately. Outside a terminal, provide a target and an unambiguous product.',
  ].join('\n')
}

/** Node owns argument parsing; Matrix validates only its selection semantics. */
export function parseArgs(argv: string[]): Args {
  const { values, positionals, tokens } = parseNodeArgs({ args: argv, options, strict: true, allowPositionals: true, tokens: true })
  const seen = new Set<string>()
  const variants: string[] = []
  for (const token of tokens) {
    if (token.kind !== 'option')
      continue
    if (token.name !== 'variant' && seen.has(token.name))
      throw new Error(`Duplicate option: --${token.name}`)
    seen.add(token.name)
    // Preserve the existing -e=value spelling without parsing argv a second time.
    const value = token.inlineValue && token.rawName.length === 2 && token.value?.startsWith('=')
      ? token.value.slice(1)
      : token.value
    if (value !== undefined && !value.trim())
      throw new Error(`Option ${token.rawName} requires a non-empty value`)
    if (value !== undefined) {
      if (token.name === 'variant')
        variants.push(...value.split(',').map(name => name.trim()))
      else if (token.name === 'product' || token.name === 'target' || token.name === 'env')
        values[token.name] = value
    }
  }
  if (positionals.length > 2)
    throw new Error(`Unexpected argument: ${positionals[2]}`)
  if (positionals.some(value => !value))
    throw new Error('Unexpected empty argument')
  const [command, product] = positionals
  if (product !== undefined && values.product !== undefined)
    throw new Error('Product was provided more than once')
  if (variants.some(name => !name))
    throw new Error('Option --variant contains an empty variant name')
  return {
    ...(command ? { command } : {}),
    ...(product || values.product ? { product: product ?? values.product! } : {}),
    variants: [...new Set(variants)],
    ...(values.env ? { env: values.env } : {}),
    ...(values.target ? { target: values.target } : {}),
    ...(values.help ? { help: true } : {}),
  }
}

/** Validates Matrix-specific combinations before loading configuration. */
export function validateCliArgs(args: Args): void {
  if (args.help || args.command === CLI_COMMANDS.help)
    return
  if (args.command === CLI_COMMANDS.doctor && (args.product || args.target || args.variants.length))
    throw new Error('doctor only accepts --env')
  if (args.command === CLI_COMMANDS.prepare && (args.target || args.variants.length))
    throw new Error('prepare only accepts a product and --env')
  if (args.command && args.command !== CLI_COMMANDS.plan && args.target)
    throw new Error(`Target is already selected by command ${args.command}; use --target only with plan or --product`)
}
