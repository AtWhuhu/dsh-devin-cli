import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, '..')

const cjsPath = resolve(rootDir, 'lib/client.cjs')
const targetJsPath = resolve(rootDir, 'lib/client.js')

try {
  const code = readFileSync(cjsPath, 'utf8')
  const wrapped = `window.__ModuleLoader__.load({
\tid: "dsh-devin-cli",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${code}
\t\treturn module.exports;
\t}
});
`
  writeFileSync(targetJsPath, wrapped, 'utf8')
  console.log('✔ Successfully created wrapped DSH client module at lib/client.js')
} catch (err) {
  console.error('Failed to bundle client:', err)
  process.exit(1)
}
