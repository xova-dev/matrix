import { mkdir, writeFile } from 'node:fs/promises'
import process from 'node:process'

async function main() {
  await mkdir('dist', { recursive: true })
  await writeFile('dist/desktop.txt', `API: ${process.env.VITE_API_BASE}\n`)
  console.log('Desktop build completed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
