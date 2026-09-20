export interface Args {
  command?: string
  product?: string
  variants: string[]
  env?: string
  target?: string
  archive?: boolean
  help?: boolean
}

export const CLI_HELP = 'matrix [target] [product] [--variant name] [--env name] [--target name] [--archive|--no-archive] [-h|--help]'

function optionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('-'))
    throw new Error(`Option ${option} requires a value`)
  return value
}

function parseVariants(value: string, option: string): string[] {
  const variants = value.split(',').map(variant => variant.trim())
  if (variants.some(variant => !variant))
    throw new Error(`Option ${option} contains an empty variant name`)
  return variants
}

export function parseArgs(argv: string[]): Args {
  const result: Args = { variants: [] }
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (!value)
      throw new Error('Unexpected empty argument')

    if (value === '--help' || value === '-h') {
      result.help = true
      continue
    }

    if (value === '--archive' || value === '--no-archive') {
      const archive = value === '--archive'
      if (result.archive !== undefined && result.archive !== archive)
        throw new Error('Options --archive and --no-archive cannot be used together')
      if (result.archive === archive)
        throw new Error(`Duplicate option: ${value}`)
      result.archive = archive
      continue
    }

    if (value === '--variant' || value === '-v') {
      const next = optionValue(argv, index, value)
      result.variants.push(...parseVariants(next, value))
      index++
      continue
    }

    if (value === '--env' || value === '--mode' || value === '--target') {
      const next = optionValue(argv, index, value)
      if (value === '--target') {
        if (result.target !== undefined)
          throw new Error('Duplicate option: --target')
        result.target = next
      }
      else {
        if (result.env !== undefined)
          throw new Error('Duplicate option: --env')
        result.env = next
      }
      index++
      continue
    }

    if (value.startsWith('-'))
      throw new Error(`Unknown option: ${value}`)

    if (!result.command) {
      result.command = value
    }
    else if (!result.product) {
      result.product = value
    }
    else {
      throw new Error(`Unexpected argument: ${value}`)
    }
  }
  return result
}
