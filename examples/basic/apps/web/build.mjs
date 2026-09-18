import { mkdir, writeFile } from 'node:fs/promises'
import process from 'node:process'

async function main() {
  await mkdir('dist', { recursive: true })
  await writeFile('dist/index.html', `<!doctype html><title>Matrix Web</title><main>API: ${process.env.VITE_API_BASE}</main>\n`)
  console.log('Web build completed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
