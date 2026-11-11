/**
 * Optional bridge into the dsh-whale-widget ledger.
 *
 * The widget only accounts model calls that happen inside a DSH conversation
 * turn (it listens to session events), and paper-reader calls the llm service
 * directly. Appending one event in its own format keeps its per-model usage
 * truthful without touching the widget.
 *
 * This is a best-effort mirror: the ledger file belongs to that plugin, so a
 * concurrent write can drop one event on either side. Disable with
 * `whaleLedger: false` in the plugin config.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// DeepSeek CNY per million tokens, [off-peak, peak] — mirrors the widget table.
const PRICES = {
  'deepseek-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-v4-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-v4-pro': { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] },
}
const DEFAULT_PRICE = PRICES['deepseek-flash']

// Beijing-time holidays that bill at the off-peak rate (2026 arrangement).
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
])

function beijingParts(ts) {
  const date = new Date(Number(ts || Date.now()) + 8 * 3600 * 1000)
  return {
    day: date.toISOString().slice(0, 10),
    weekday: date.getUTCDay(),
    hour: date.getUTCHours(),
  }
}

function isPeak(ts) {
  const { day, weekday, hour } = beijingParts(ts)
  if (weekday === 0 || weekday === 6) return false
  if (HOLIDAYS.has(day)) return false
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

function priceFor(model) {
  const name = String(model || '').toLowerCase()
  for (const key of Object.keys(PRICES)) {
    if (name.includes(key)) return PRICES[key]
  }
  return DEFAULT_PRICE
}

/** CNY cost for one call, using the widget's tiered pricing. */
export function costOf(model, usage, at = Date.now()) {
  if (!usage) return 0
  const price = priceFor(model)
  const peak = isPeak(at) ? 1 : 0
  const cached = Number(usage.cached) || 0
  const totalInput = Number(usage.input) || 0
  const uncached = Math.max(0, totalInput - cached)
  const output = Number(usage.output) || 0
  return (cached / 1e6) * price.hit[peak]
    + (uncached / 1e6) * price.miss[peak]
    + (output / 1e6) * price.out[peak]
}

function ledgerFiles() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return [
    path.join(home, '.dshw-usage.json'),
    path.join(home, 'profiles', 'web', '.dshw-usage.json'),
  ]
}

/**
 * Append one usage event to the widget ledger. Returns true when the event was
 * written; false when that plugin has no ledger yet or the file kept changing.
 */
export async function appendWhaleEvent({ model, usage, ts = Date.now() }) {
  if (!usage?.total) return false
  const file = ledgerFiles().find(candidate => fs.existsSync(candidate))
  if (!file) return false
  const tokens = Number(usage.total) || 0
  const cost = Number(costOf(model, usage, ts).toFixed(8))
  const { day } = beijingParts(ts)

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let ledger
    try {
      ledger = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return false
    }
    if (!ledger || typeof ledger !== 'object') return false
    if (!Array.isArray(ledger.events)) ledger.events = []
    ledger.events.push({ ts, day, model: String(model || '未知'), cost, tokens })
    const temporary = `${file}.pr-${process.pid}-${attempt}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify(ledger), 'utf8')
      fs.renameSync(temporary, file)
      return true
    } catch {
      try { fs.rmSync(temporary, { force: true }) } catch { /* ignore */ }
      await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)))
    }
  }
  return false
}
