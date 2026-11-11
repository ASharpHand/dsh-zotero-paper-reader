/**
 * Paper note pipeline: PDF text -> skill-shaped Chinese Markdown -> HTML ->
 * printed PDF, plus the Zotero attachment hand-off.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { completeWithUsage } from './llm.js'

const run = promisify(execFile)

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]

export function findBrowser(configured) {
  if (configured && fs.existsSync(configured)) return configured
  for (const candidate of EDGE_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}

const MANAGED_VENV = path.join(os.homedir(), '.dsh', 'paper-reader', 'venv')

function managedPython() {
  const candidates = process.platform === 'win32'
    ? [path.join(MANAGED_VENV, 'Scripts', 'python.exe')]
    : [path.join(MANAGED_VENV, 'bin', 'python3'), path.join(MANAGED_VENV, 'bin', 'python')]
  return candidates.find(candidate => fs.existsSync(candidate)) || ''
}

export function findPython(configured) {
  if (configured && fs.existsSync(configured)) return configured
  const managed = managedPython()
  if (managed) return managed
  const venv = path.join(os.homedir(), '.codex', 'skill-envs', 'remote-sensing-paper-brief', '.venv', 'Scripts', 'python.exe')
  if (fs.existsSync(venv)) return venv
  const venvPosix = path.join(os.homedir(), '.codex', 'skill-envs', 'remote-sensing-paper-brief', '.venv', 'bin', 'python')
  if (fs.existsSync(venvPosix)) return venvPosix
  return 'python'
}

let fitzPython
let venvPromise

async function importsFitz(command, args = []) {
  try {
    await run(command, [...args, '-c', 'import fitz'], { timeout: 25_000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

function interpreterCandidates(configured) {
  const list = []
  if (configured) list.push({ cmd: configured, args: [] })
  const managed = managedPython()
  if (managed) list.push({ cmd: managed, args: [] })
  list.push({ cmd: findPython(''), args: [] })
  if (process.platform === 'win32') list.push({ cmd: 'py', args: ['-3'] })
  list.push({ cmd: 'python', args: [] })
  list.push({ cmd: 'python3', args: [] })
  return list
}

async function findBasePython() {
  const bases = process.platform === 'win32'
    ? [{ cmd: 'py', args: ['-3'] }, { cmd: 'python', args: [] }, { cmd: 'python3', args: [] }]
    : [{ cmd: 'python3', args: [] }, { cmd: 'python', args: [] }]
  for (const base of bases) {
    try {
      await run(base.cmd, [...base.args, '-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 3)'], { timeout: 20_000, windowsHide: true })
      return base
    } catch { /* try the next launcher */ }
  }
  return null
}

/**
 * Create the plugin's own virtualenv and install PyMuPDF into it. Every
 * dependency the note pipeline needs from now on belongs in this venv.
 */
export async function provisionPythonVenv({ pipIndex = '', onProgress, base } = {}) {
  if (venvPromise) return venvPromise
  venvPromise = (async () => {
    const existing = managedPython()
    if (existing && await importsFitz(existing)) return existing
    const launcher = base || await findBasePython()
    if (!launcher) throw pythonMissing()
    onProgress?.('首次使用，正在创建 Python 环境…')
    await fsp.mkdir(path.dirname(MANAGED_VENV), { recursive: true })
    await run(launcher.cmd, [...launcher.args, '-m', 'venv', MANAGED_VENV], { timeout: 240_000, windowsHide: true })
    const interpreter = managedPython()
    if (!interpreter) throw new Error(`创建 Python 环境失败：${MANAGED_VENV} 里没有找到解释器。`)
    onProgress?.('正在安装 PyMuPDF（首次约 1–3 分钟，取决于网速）…')
    const install = extra => run(interpreter, [
      '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', ...extra, 'pymupdf',
    ], { timeout: 600_000, windowsHide: true })
    try {
      await install(pipIndex ? ['-i', pipIndex] : [])
    } catch (first) {
      if (pipIndex) throw installFailed(interpreter, first)
      onProgress?.('默认源失败，改用国内镜像重试…')
      try {
        await install(['-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'])
      } catch (second) {
        throw installFailed(interpreter, second)
      }
    }
    if (!await importsFitz(interpreter)) throw installFailed(interpreter)
    onProgress?.('Python 环境就绪')
    return interpreter
  })().finally(() => { venvPromise = undefined })
  return venvPromise
}

/**
 * Interpreter that can import PyMuPDF. Probes the configured one, the managed
 * venv, the reading skill's venv, then system launchers; provisions the managed
 * venv when none of them has it.
 */
export async function resolvePython(configured, { autoVenv = true, pipIndex = '', onProgress } = {}) {
  if (fitzPython) return fitzPython
  for (const { cmd, args } of interpreterCandidates(configured)) {
    if (!cmd) continue
    if (cmd.includes(path.sep) && !fs.existsSync(cmd)) continue
    if (await importsFitz(cmd, args)) {
      fitzPython = cmd
      return cmd
    }
  }
  if (autoVenv) {
    const interpreter = await provisionPythonVenv({ pipIndex, onProgress })
    fitzPython = interpreter
    return interpreter
  }
  throw missingFitz(configured || 'python')
}

function pythonMissing() {
  const error = new Error(
    '没有找到可用的 Python（需要 3.8 及以上）。\n'
    + '请先安装 Python：https://www.python.org/downloads/ ，安装时勾选 “Add python.exe to PATH”，然后重新生成笔记。\n'
    + '已经装过的话，在插件配置里用 python 指定解释器路径。',
  )
  error.code = 'PAPER_READER_NO_PYTHON'
  return error
}

function installFailed(interpreter, cause) {
  const detail = String(cause?.stderr || cause?.message || '').trim().split('\n').slice(-2).join(' ')
  const error = new Error(
    `安装 PyMuPDF 失败${detail ? `：${detail}` : ''}。\n`
    + `可以手动执行：${interpreter} -m pip install pymupdf\n`
    + '国内网络可在插件配置里设置 pipIndex 为 https://pypi.tuna.tsinghua.edu.cn/simple',
  )
  error.code = 'PAPER_READER_PIP_FAILED'
  return error
}

function missingFitz(python) {
  const error = new Error(
    `笔记需要 PyMuPDF（Python 的 PDF 库），当前解释器 ${python} 里没有，自动安装又已关闭。\n`
    + `安装方法：${python} -m pip install pymupdf`,
  )
  error.code = 'PAPER_READER_NO_PYMUPDF'
  return error
}

export async function extractPdf(pdfPath, { python, scriptPath, workDir, autoVenv = true, pipIndex = '', onProgress }) {
  await fsp.mkdir(workDir, { recursive: true })
  const out = path.join(workDir, `extract-${Date.now()}.json`)
  const interpreter = await resolvePython(python, { autoVenv, pipIndex, onProgress })
  await run(interpreter, [scriptPath, '--pdf', pdfPath, '--out', out], {
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  })
  const raw = await fsp.readFile(out, 'utf8')
  await fsp.rm(out, { force: true })
  return JSON.parse(raw)
}

/** Best-effort figure capture; a paper with no detectable figures returns []. */
export async function extractFigures(pdfPath, { python, scriptPath, outDir, workDir, autoVenv = true, pipIndex = '', onProgress }) {
  await fsp.mkdir(workDir, { recursive: true })
  await fsp.mkdir(outDir, { recursive: true })
  const out = path.join(workDir, `figures-${Date.now()}.json`)
  try {
    const interpreter = await resolvePython(python, { autoVenv, pipIndex, onProgress })
    await run(interpreter, [scriptPath, '--pdf', pdfPath, '--out', out, '--dir', outDir], {
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    })
    const raw = await fsp.readFile(out, 'utf8')
    const body = JSON.parse(raw)
    return Array.isArray(body.figures) ? body.figures : []
  } catch {
    return []
  } finally {
    await fsp.rm(out, { force: true }).catch(() => {})
  }
}

function paperText(extract, limit = 90_000) {
  const pages = extract.pages || []
  const joined = pages.map(page => `\n<<<第 ${page.page} 页>>>\n${page.text}`).join('\n')
  const truncated = joined.length > limit
  return {
    text: truncated ? `${joined.slice(0, limit)}\n\n（正文过长，已截断）` : joined,
    truncated,
    totalChars: joined.length,
    usedChars: truncated ? limit : joined.length,
  }
}

function qaSection(qa) {
  if (!Array.isArray(qa) || !qa.length) return '（本次没有问答记录，第 11 节写“本次无问答记录”。）'
  return qa.map((entry, index) => {
    const lines = [`${index + 1}. 问：${entry.question}`]
    if (entry.selection) lines.push(`   选中原文：${String(entry.selection).slice(0, 500)}`)
    lines.push(`   答：${String(entry.answer || '').slice(0, 1200)}`)
    return lines.join('\n')
  }).join('\n\n')
}

/** Structure used when no reading skill is installed. */
const DEFAULT_TEMPLATE = [
  '# {论文标题}',
  '',
  '## 0. 元信息',
  '标题、作者、年份、期刊/会议、DOI、论文类型、研究区域。',
  '',
  '## 1. 一句话总结',
  '',
  '## 2. 研究问题与动机',
  '2.1 领域背景　2.2 现有方法的不足　2.3 本文要解决的问题',
  '',
  '## 3. 研究区、时间范围、数据集与数据来源',
  '',
  '## 4. 方法',
  '4.1 总体框架　4.2 关键模块　4.3 损失函数与训练细节　4.4 创新点',
  '',
  '## 5. 实验设置',
  '数据划分、对比方法、评价指标、实现细节。',
  '',
  '## 6. 结果',
  '主要定量结果（表格或要点）、消融实验、可视化结论。',
  '',
  '## 7. 讨论与局限',
  '',
  '## 8. 结论与启示',
  '',
  '## 9. 可复现性',
  '代码/数据是否公开、关键超参数是否完整。',
  '',
  '## 10. 与我的研究的关系',
  '',
].join('\n')

const DEFAULT_SKILL = [
  '没有安装额外的阅读技能，按默认规则生成：',
  '每个小节用要点或短段落，先结论后细节；只使用论文正文中的信息，不编造数据、指标、数据集名或结论。',
  '拿不准的地方写“论文未说明”，不要推测。',
].join('\n')

export function buildNotePrompt({ skillText, templateText, extract, item, qa, figures }) {
  const effectiveSkill = String(skillText || '').trim() || DEFAULT_SKILL
  const effectiveTemplate = String(templateText || '').trim() || DEFAULT_TEMPLATE
  const figureLines = []
  if (Array.isArray(figures) && figures.length) {
    figureLines.push('===== 已自动截取的方法图（文件都在 figures/ 目录下） =====')
    for (const figure of figures) {
      figureLines.push(`Fig. ${figure.number}（第 ${figure.page} 页）：${figure.caption}\n  文件：figures/${figure.file}`)
    }
    figureLines.push('===== 方法图清单结束 =====')
  } else {
    figureLines.push('本次未截取到任何方法图；第 4 节的图表格写一行“未自动提取方法图”，不要编造图号。')
  }
  const body = paperText(extract)
  const head = [
    '你是远程遥感论文精读助手。严格按下面的技能说明和模板，为一篇论文生成中文精读笔记。',
    '只输出最终 Markdown 笔记正文：不要输出解释、不要用代码块包裹整篇、不要输出与笔记无关的说明。',
    '章节顺序与标题沿用模板；模板中不适用的可选内容按技能说明删除（例如非深度学习论文删除 4.4）。',
    '所有“依据：”标签只允许使用 Abstract、Section x.y、Fig. x、Table x；不允许页码。',
    '数学公式一律用 $...$（行内）或 $$...$$（独立行），不要用 \\( \\)。',
    '在模板第 10 节之后追加一节：',
    '## 11. 问答与追问',
    '把下面给出的问答记录整理成小节：每条先写“问：”，再写“答：”，答用 2-4 句话压缩，保留关键数字与结论；最后加一行“依据：”指向相关章节或写“来自问答”。',
    '如果给出了问答记录，第 11 节必须逐条覆盖，不得遗漏或合并。',
    '关于方法图：只能引用下面清单里给出的图和文件名；在“4. 方法”里用 Markdown 图片语法嵌入 `![Fig. N 说明](figures/<文件名>)`，并在图片下方或上方的正文里解释该图；清单里没有的图号不要引用。',
    '第 4 节的图表格列：图号、保存路径、类型（总体流程/模块结构）、说明、来源。非方法类图（结果图、示例图、分布图、精度对比图）不要放进第 4 节。',
    '',
    '===== 技能说明开始 =====',
    effectiveSkill,
    '===== 技能说明结束 =====',
    '',
    '===== 笔记模板开始 =====',
    effectiveTemplate,
    '===== 笔记模板结束 =====',
    '',
    `论文条目信息：标题=${item.title}；年份=${item.year || '未知'}；期刊=${item.venue || '未知'}；DOI=${item.doi || '未提供'}；类型=${item.type}`,
    `PDF 文件名=${item.pdfName || '未知'}`,
    '',
    figureLines.join('\n'),
    '',
    '===== 问答记录开始 =====',
    qaSection(qa),
    '===== 问答记录结束 =====',
    '',
    '===== 论文正文开始（按页给出，不要引用页码） =====',
    body.text,
    '===== 论文正文结束 =====',
    '',
    '现在输出完整的中文 Markdown 笔记。',
  ]
  return {
    prompt: head.join('\n'),
    input: { truncated: body.truncated, totalChars: body.totalChars, usedChars: body.usedChars },
  }
}

const NOTE_SYSTEM = [
  '你是严谨的遥感论文精读助手。只使用给定论文正文中的信息，绝不编造数据、指标、数据集名或结论。',
  '术语按遥感与深度学习惯例翻译；保留英文官方名称、模型名、数据集名与指标缩写。',
  '输出 Markdown，标题层级与模板一致；表格使用 Markdown 表格。',
].join('\n')

export async function draftNote(ctx, cfg, input) {
  const built = buildNotePrompt(input)
  const result = await completeWithUsage(ctx, cfg, {
    system: NOTE_SYSTEM,
    prompt: built.prompt,
    maxTokens: input.maxTokens || 32_000,
    model: input.model,
  })
  return { ...result, input: built.input }
}

export function stripFence(markdown) {
  let text = String(markdown || '').trim()
  const fenced = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/)
  if (fenced) text = fenced[1].trim()
  // The rendered HTML supplies the document title itself.
  text = text.replace(/^#\s+[^\n]*\n+/, '')
  return text
}

function splitMath(markdown) {
  const store = []
  let text = markdown.replace(/\$\$([\s\S]+?)\$\$/g, (match, tex) => {
    store.push({ tex, display: true })
    return `@@MATH${store.length - 1}@@`
  })
  text = text.replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (match, prefix, tex) => {
    store.push({ tex, display: false })
    return `${prefix}@@MATH${store.length - 1}@@`
  })
  return { text, store }
}

const NOTE_CSS = `
  @page { size: A4; margin: 16mm 15mm 18mm; }
  body { font-family: "Microsoft YaHei", "Segoe UI", "Noto Sans SC", sans-serif; font-size: 10.5pt; line-height: 1.62; color: #1c1c1c; margin: 0; }
  h1 { font-size: 19pt; line-height: 1.3; margin: 0 0 10pt; border-bottom: 2px solid #2f6f8f; padding-bottom: 6pt; }
  h2 { font-size: 14pt; margin: 16pt 0 7pt; padding-left: 7pt; border-left: 4px solid #2f6f8f; break-after: avoid; }
  h3 { font-size: 12pt; margin: 12pt 0 5pt; color: #24506b; break-after: avoid; }
  h4 { font-size: 11pt; margin: 10pt 0 4pt; break-after: avoid; }
  p { margin: 4pt 0; }
  ul, ol { margin: 4pt 0 4pt 0; padding-left: 18pt; }
  li { margin: 2pt 0; }
  table { border-collapse: collapse; width: 100%; margin: 7pt 0 10pt; font-size: 9.3pt; page-break-inside: avoid; }
  th, td { border: 1px solid #b9c6ce; padding: 3pt 5pt; vertical-align: top; text-align: left; }
  th { background: #eef4f7; font-weight: 600; }
  code { font-family: Consolas, "Courier New", monospace; background: #f2f4f6; padding: 0 2pt; font-size: 9.5pt; }
  pre { background: #f5f7f8; padding: 6pt; border-radius: 3pt; overflow: auto; }
  blockquote { margin: 6pt 0; padding: 3pt 10pt; border-left: 3px solid #c4d3da; color: #45565f; }
  hr { border: none; border-top: 1px solid #d7dee2; margin: 12pt 0; }
  img { max-width: 100%; height: auto; display: block; margin: 8pt auto 4pt; page-break-inside: avoid; }
  p > img { margin: 8pt auto 4pt; }
  .meta { font-size: 9pt; color: #5c6b73; margin-bottom: 12pt; }
  .katex { font-size: 1em; }
`

export async function renderNoteHtml({ markdown, title, vendorBaseUrl, vendorDir, figureBaseUrl }) {
  const [markedModule, katexModule] = await Promise.all([
    import(pathToFileURL(path.join(vendorDir, 'marked', 'marked.esm.js')).href),
    import(pathToFileURL(path.join(vendorDir, 'katex', 'katex.mjs')).href),
  ])
  const marked = markedModule.marked || markedModule.default
  const katex = katexModule.default || katexModule
  const { text, store } = splitMath(markdown)
  marked.setOptions?.({ gfm: true, breaks: false })
  let html = marked.parse(text)
  html = html.replace(/@@MATH(\d+)@@/g, (match, index) => {
    const entry = store[Number(index)]
    if (!entry) return match
    try {
      return katex.renderToString(entry.tex, { displayMode: entry.display, throwOnError: false, output: 'html' })
    } catch {
      return `<code>${entry.tex.replace(/[<>&]/g, '')}</code>`
    }
  })
  if (figureBaseUrl) {
    html = html.replace(/src="figures\//g, `src="${figureBaseUrl}`)
  }
  const escapedTitle = String(title || '论文笔记').replace(/[<>&"]/g, '')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${escapedTitle}</title>
<link rel="stylesheet" href="${vendorBaseUrl}/katex/katex.min.css">
<style>${NOTE_CSS}</style>
</head><body>
<h1>${escapedTitle}</h1>
${html}
</body></html>`
}

export async function htmlToPdf({ target, pdfPath, browser, timeoutMs = 120_000 }) {
  if (!browser) throw new Error('找不到 Edge/Chrome，无法把笔记打印成 PDF')
  const location = /^https?:/i.test(target) ? target : pathToFileURL(target).href
  await fsp.mkdir(path.dirname(pdfPath), { recursive: true })
  await fsp.rm(pdfPath, { force: true })
  const profile = path.join(os.tmpdir(), `dsh-paper-reader-print-${process.pid}-${Date.now()}`)
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--user-data-dir=${profile}`,
    '--virtual-time-budget=8000',
    '--run-all-compositor-stages-before-draw',
    '--no-pdf-header-footer',
    `--print-to-pdf=${pdfPath}`,
    location,
  ]
  try {
    await run(browser, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  } finally {
    await fsp.rm(profile, { recursive: true, force: true }).catch(() => {})
  }
  const stat = await fsp.stat(pdfPath).catch(() => undefined)
  if (!stat || stat.size < 1000) throw new Error('PDF 生成失败（没有输出文件）')
  return { bytes: stat.size, pdfPath }
}

export function slugFor(title, fallback = 'paper') {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 8)
    .join('-')
  return slug || fallback
}
