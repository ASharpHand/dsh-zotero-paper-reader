/**
 * Paper reading module — Host half entry.
 *
 * The real implementation lives in lib/app.js and is imported with a
 * cache-busting query so a re-applied plugin picks up edited files without
 * restarting the whole Harness.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export const inject = ['webServer']

export async function apply(ctx, config = {}) {
  const target = path.join(here, 'lib', 'app.js')
  let stamp = 0
  try {
    stamp = fs.statSync(target).mtimeMs
  } catch { /* fall through to a plain import */ }
  const url = `${pathToFileURL(target).href}?v=${Math.round(stamp)}`
  const module = await import(url)
  return module.apply(ctx, config)
}
