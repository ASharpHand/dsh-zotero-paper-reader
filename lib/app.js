/**
 * Paper reading module — Host half.
 *
 * Serves the Zotero library (read-only SQLite), PDF bytes, translation, paper
 * Q&A, note generation and the Zotero attachment hand-off to the browser half
 * over plain same-origin HTTP under /paper-reader.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ZoteroStore, resolveDataDir } from './zotero.js'
import { answerQuestion, availableEngines, listModelCatalog, modelInfo, normalizeUsage, translateBlocks } from './llm.js'
import { appendWhaleEvent } from './usage.js'
import {
  draftNote,
  extractFigures,
  extractPdf,
  findBrowser,
  findPython,
  htmlToPdf,
  renderNoteHtml,
  slugFor,
  stripFence,
} from './notes.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const BRIDGE_ORIGIN = 'http://127.0.0.1:23119'

export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const cfg = {
    zoteroDataDir: '',
    outputDir: path.join(root, 'data', 'notes'),
    dataDir: path.join(root, 'data'),
    skillDir: path.join(os.homedir(), '.codex', 'skills', 'remote-sensing-paper-brief'),
    python: '',
    browser: '',
    translateEngine: 'free',
    notesMaxTokens: 32_000,
    whaleLedger: true,
    autoVenv: true,
    pipIndex: '',
    ...config,
  }

  const store = new ZoteroStore(resolveDataDir(cfg.zoteroDataDir))
  const state = {
    noteHtml: new Map(),
    noteJobs: new Map(),
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/paper-reader',
    handler: (req, res) => {
      handle(req, res).catch(error => {
        ctx.logger?.warn?.(`paper-reader: ${error?.stack || error}`)
        if (!res.headersSent) sendJson(res, 500, { error: String(error?.message || error) })
        else res.end()
      })
    },
  }))

  async function handle(req, res) {
    const url = new URL(req.url, 'http://paper-reader.local')
    const route = url.pathname.slice('/paper-reader'.length) || '/'
    if (route === '/state') return sendJson(res, 200, await statePayload())
    if (route === '/models') return sendJson(res, 200, await listModelCatalog(ctx))
    if (route === '/collections') return sendJson(res, 200, { collections: await store.collections() })
    if (route === '/items') {
      const collection = numberOrUndefined(url.searchParams.get('collection'))
      const limit = Math.min(500, Number(url.searchParams.get('limit') || 100))
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0))
      return sendJson(res, 200, await store.listItems({ collection, q: url.searchParams.get('q') || '', limit, offset }))
    }
    if (route === '/item') {
      const id = numberOrUndefined(url.searchParams.get('id'))
      if (!id) return sendJson(res, 400, { error: 'missing id' })
      const item = await store.item(id)
      if (!item) return sendJson(res, 404, { error: 'item not found' })
      return sendJson(res, 200, { item, qa: await readQa(item.key) })
    }
    if (route === '/pdf') return servePdf(req, res, url)
    if (route === '/translations' && req.method === 'GET') {
      const attachmentId = numberOrUndefined(url.searchParams.get('attachment'))
      if (!attachmentId) return sendJson(res, 400, { error: 'missing attachment' })
      const version = Number(url.searchParams.get('v') || 0)
      return sendJson(res, 200, { version, map: await readTranslationCache(attachmentId, version) })
    }
    if (route.startsWith('/vendor/')) return serveStatic(req, res, route.slice('/vendor/'.length))
    if (route === '/note-html') return serveNoteHtml(req, res, url)
    if (route === '/note-pdf') return serveNoteFile(req, res, url)
    if (route === '/note-asset') return serveNoteAsset(req, res, url)
    if (route === '/translate' && req.method === 'POST') return apiTranslate(req, res)
    if (route === '/ask' && req.method === 'POST') return apiAsk(req, res)
    if (route === '/notes' && req.method === 'POST') return apiNotesStart(req, res)
    if (route === '/notes/status' && req.method === 'GET') return apiNotesStatus(req, res, url)
    if (route === '/notes/jobs' && req.method === 'GET') return apiNotesJobs(req, res)
    if (route === '/attach' && req.method === 'POST') return apiAttach(req, res)
    if (route === '/reload-client' && req.method === 'POST') {
      // Push an edited browser bundle to open pages without a Host restart.
      const modules = ctx.get('clientModules')
      let rev
      try {
        rev = modules?.rebuilt?.('@local/dsh-paper-reader')
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error?.message || error) })
      }
      return sendJson(res, 200, { ok: Boolean(rev), rev: rev || null })
    }
    return sendJson(res, 404, { error: `unknown route ${route}` })
  }

  async function statePayload() {
    const bridge = await bridgePing()
    let zoteroRunning = false
    try {
      const response = await fetch('http://127.0.0.1:23119/api/users/0/items?limit=1', { signal: AbortSignal.timeout(1500) })
      zoteroRunning = response.ok
    } catch { /* not running */ }
    let stats
    let dbError
    try {
      stats = await store.stats()
    } catch (error) {
      dbError = String(error?.message || error)
    }
    return {
      ok: true,
      build: 'paper-reader-2',
      zotero: {
        running: zoteroRunning,
        dataDir: store.dataDir,
        dbPath: store.dbPath,
        bridge: bridge.ok,
        bridgeVersion: bridge.version,
        bridgeDiag: {
          lastSeen: bridge.lastSeen,
          lastAction: bridge.lastAction,
          lastError: bridge.lastError,
        },
        error: dbError,
      },
      stats,
      engines: availableEngines(ctx),
      model: modelInfo(ctx, cfg),
      outputDir: cfg.outputDir,
      noteCount: state.noteHtml.size,
    }
  }

  function bridgeDir() {
    return path.join(store.dataDir, 'paper-reader-bridge')
  }

  /**
   * Liveness comes from the file the Zotero plugin refreshes every 2s, because
   * Zotero's own HTTP server is not always running.
   */
  async function bridgePing() {
    try {
      const raw = await fsp.readFile(path.join(bridgeDir(), 'alive.json'), 'utf8')
      const info = JSON.parse(raw)
      const age = Date.now() - Number(info.at || 0)
      return {
        ok: age >= 0 && age < 20_000,
        version: info.version,
        zotero: info.zotero,
        age,
        lastSeen: info.lastSeen,
        lastAction: info.lastAction,
        lastError: info.lastError,
      }
    } catch {
      return { ok: false }
    }
  }

  /**
   * Fixed-file handshake: the plugin watches `request.json` and answers in
   * `result.json`. A token keeps a stale reply from an earlier attempt from
   * being mistaken for this one.
   */
  async function attachViaQueue({ item, pdfPath, title }) {
    const dir = bridgeDir()
    await fsp.mkdir(dir, { recursive: true })
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const requestPath = path.join(dir, 'request.json')
    const resultPath = path.join(dir, 'result.json')
    const temporary = `${requestPath}.tmp`
    await fsp.writeFile(temporary, JSON.stringify({
      token,
      itemKey: item.key,
      libraryID: 1,
      path: pdfPath,
      title,
      contentType: 'application/pdf',
      at: Date.now(),
    }), 'utf8')
    await fsp.rm(resultPath, { force: true }).catch(() => {})
    await fsp.rename(temporary, requestPath)

    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500))
      let raw
      try {
        raw = await fsp.readFile(resultPath, 'utf8')
      } catch {
        continue
      }
      let result
      try {
        result = JSON.parse(raw)
      } catch {
        continue
      }
      if (result.token !== token) continue
      await fsp.rm(resultPath, { force: true }).catch(() => {})
      await fsp.rm(requestPath, { force: true }).catch(() => {})
      if (result.ok) {
        return {
          ok: true,
          attachmentKey: result.attachmentKey,
          attachmentID: result.attachmentID,
          mode: result.mode || 'imported',
        }
      }
      return { ok: false, reason: result.error || '桥接写入失败' }
    }
    await fsp.rm(requestPath, { force: true }).catch(() => {})
    return { ok: false, reason: '等待 Zotero 写入超时（60 秒）' }
  }

  async function attachViaHttp({ item, pdfPath, title }) {
    try {
      const response = await fetch(`${BRIDGE_ORIGIN}/paper-reader/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemKey: item.key,
          libraryID: 1,
          path: pdfPath,
          title,
          contentType: 'application/pdf',
        }),
        signal: AbortSignal.timeout(30_000),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok === false) return { ok: false, reason: body.error || `bridge ${response.status}` }
      return { ok: true, attachmentKey: body.attachmentKey, mode: body.mode }
    } catch {
      return { ok: false, reason: 'unreachable' }
    }
  }

  function qaPath(key) {
    return path.join(cfg.dataDir, 'qa', `${key}.json`)
  }

  async function readQa(key) {
    try {
      return JSON.parse(await fsp.readFile(qaPath(key), 'utf8'))
    } catch {
      return []
    }
  }

  async function appendQa(key, entry) {
    const list = await readQa(key)
    list.push(entry)
    await fsp.mkdir(path.dirname(qaPath(key)), { recursive: true })
    await fsp.writeFile(qaPath(key), JSON.stringify(list, null, 2), 'utf8')
    return list
  }

  async function servePdf(req, res, url) {
    const attachmentId = numberOrUndefined(url.searchParams.get('attachment'))
    if (!attachmentId) return sendJson(res, 400, { error: 'missing attachment' })
    const attachment = await store.attachmentById(attachmentId)
    if (!attachment?.path || !fs.existsSync(attachment.path)) {
      return sendJson(res, 404, { error: 'PDF 不存在或路径无法解析' })
    }
    const stat = await fsp.stat(attachment.path)
    const range = req.headers.range
    const type = attachment.contentType || 'application/pdf'
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range)
      const start = match && match[1] ? Number(match[1]) : 0
      const end = match && match[2] ? Number(match[2]) : stat.size - 1
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
      })
      fs.createReadStream(attachment.path, { start, end }).pipe(res)
      return
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' })
    fs.createReadStream(attachment.path).pipe(res)
  }

  async function serveStatic(req, res, relativePath) {
    const relative = decodeURIComponent(relativePath)
    const vendorRoot = path.join(root, 'vendor')
    const target = path.resolve(vendorRoot, relative)
    if (!target.startsWith(vendorRoot) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return sendJson(res, 404, { error: 'not found' })
    }
    res.writeHead(200, { 'Content-Type': contentTypeFor(target), 'Cache-Control': 'public, max-age=86400' })
    fs.createReadStream(target).pipe(res)
  }

  /** Local note PDF, for when the Zotero attachment step failed. */
  async function serveNoteFile(req, res, url) {    const requested = url.searchParams.get('p') || ''
    const outputRoot = path.resolve(cfg.outputDir)
    const target = path.resolve(requested)
    if (!target.startsWith(outputRoot) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return sendJson(res, 404, { error: 'note file not found' })
    }
    const stat = await fsp.stat(target)
    const range = req.headers.range
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range)
      const start = match && match[1] ? Number(match[1]) : 0
      const end = match && match[2] ? Number(match[2]) : stat.size - 1
      res.writeHead(206, {
        'Content-Type': 'application/pdf',
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
      })
      fs.createReadStream(target, { start, end }).pipe(res)
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' })
    fs.createReadStream(target).pipe(res)
  }

  async function serveNoteHtml(req, res, url) {
    const id = url.searchParams.get('id') || ''
    const html = state.noteHtml.get(id)
    if (!html) return sendJson(res, 404, { error: 'note html not found' })
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  }

  async function serveNoteAsset(req, res, url) {
    const requested = url.searchParams.get('p') || ''
    const target = path.resolve(requested)
    const outputRoot = path.resolve(cfg.outputDir)
    if (!target.startsWith(outputRoot) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return sendJson(res, 404, { error: 'asset not found' })
    }
    res.writeHead(200, { 'Content-Type': contentTypeFor(target), 'Cache-Control': 'public, max-age=3600' })
    fs.createReadStream(target).pipe(res)
  }

  async function apiTranslate(req, res) {
    const body = await readJson(req)
    const engine = body.engine || cfg.translateEngine
    const blocks = Array.isArray(body.blocks) ? body.blocks : []
    // A stray request must not translate a whole book: cap one round trip.
    const characters = blocks.reduce((sum, block) => sum + String(block?.text || '').length, 0)
    if (blocks.length > 60 || characters > 24_000) {
      return sendJson(res, 413, {
        error: `单次翻译请求过大（${blocks.length} 段 / ${characters} 字），已拒绝；请减少每批段数`,
      })
    }
    const results = await translateBlocks(ctx, cfg, blocks, engine, abortFor(req))
    const attachmentId = numberOrUndefined(body.attachment)
    const version = Number(body.v || 0)
    if (attachmentId && results.length) await mergeTranslationCache(attachmentId, version, results)
    return sendJson(res, 200, { engine, results })
  }

  function translationCachePath(attachmentId) {
    return path.join(cfg.dataDir, 'cache', `translations-${attachmentId}.json`)
  }

  async function readTranslationCache(attachmentId, version) {
    try {
      const raw = JSON.parse(await fsp.readFile(translationCachePath(attachmentId), 'utf8'))
      // A plain object is the legacy format: no version, so it is never reused.
      if (raw && typeof raw === 'object' && raw.map && Number(raw.version) === version) return raw.map
      return {}
    } catch {
      return {}
    }
  }

  async function mergeTranslationCache(attachmentId, version, results) {
    const existing = await readTranslationCache(attachmentId, version)
    const cache = { version, map: { ...existing } }
    let added = 0
    for (const result of results) {
      if (!result?.id || typeof result.text !== 'string') continue
      if (cache.map[result.id] === undefined) added += 1
      cache.map[result.id] = result.text
    }
    if (!added) return
    await fsp.mkdir(path.dirname(translationCachePath(attachmentId)), { recursive: true })
    await fsp.writeFile(translationCachePath(attachmentId), JSON.stringify(cache), 'utf8')
  }

  async function apiAsk(req, res) {
    const body = await readJson(req)
    const itemId = numberOrUndefined(body.itemId)
    if (!itemId) return sendJson(res, 400, { error: 'missing itemId' })
    const item = await store.item(itemId)
    if (!item) return sendJson(res, 404, { error: 'item not found' })
    const question = String(body.question || '').trim()
    if (!question) return sendJson(res, 400, { error: 'missing question' })
    const history = (await readQa(item.key)).slice(-3)
    const sse = createSse(res)
    let answer = ''
    let sources = []
    let webUnavailable = false
    let webError = ''
    if (body.web) {
      // Tell the client the search is running: it takes a moment and otherwise
      // looks like nothing happened before the first token arrives.
      sse.send({ type: 'web', status: 'searching' })
      const searched = await searchSupplement(ctx, question, item, body.selection)
      sources = searched.sources
      webUnavailable = !searched.ok
      webError = searched.error || ''
      sse.send({
        type: 'web',
        status: searched.ok ? 'done' : 'failed',
        count: sources.length,
        error: webError,
      })
    }
    try {
      const askedModel = normalizeModel(body.model)
      let askUsage = null
      const stream = await answerQuestion(ctx, cfg, {
        paper: item,
        question,
        selection: body.selection || '',
        context: body.context || '',
        history,
        web: sources,
        model: askedModel,
        signal: abortFor(req),
        onUsage: reported => {
          const normalized = normalizeUsage(reported)
          if (normalized) askUsage = normalized
        },
      })
      for await (const delta of stream) {
        answer += delta
        sse.send({ type: 'delta', text: delta })
      }
      await appendQa(item.key, {
        at: new Date().toISOString(),
        question,
        selection: String(body.selection || '').slice(0, 4000),
        answer,
        page: body.page || null,
      })
      await recordUsage('ask', askedModel, askUsage, { itemId })
      sse.send({ type: 'done', answer, sources: sources.map(source => ({ title: source.title, url: source.url })), webUnavailable, webError })
      sse.close()
    } catch (error) {
      sse.send({ type: 'error', error: String(error?.message || error) })
      sse.close()
    }
  }

  /** Append one model call to data/usage.jsonl and (optionally) the whale ledger. */
  async function recordUsage(kind, model, usage, extra = {}) {
    if (!usage?.total) return
    try {
      const file = path.join(cfg.dataDir, 'usage.jsonl')
      await fsp.mkdir(path.dirname(file), { recursive: true })
      const resolved = model
        ? { provider: model.provider, model: model.model }
        : modelInfo(ctx, cfg)
      const line = JSON.stringify({
        at: new Date().toISOString(),
        kind,
        provider: resolved?.provider || null,
        model: resolved?.model || null,
        input: usage.input || 0,
        output: usage.output || 0,
        cached: usage.cached || 0,
        total: usage.total || 0,
        ...extra,
      })
      await fsp.appendFile(file, `${line}\n`, 'utf8')
      if (cfg.whaleLedger !== false) {
        await appendWhaleEvent({ model: resolved?.model || '', usage, ts: Date.now() })
          .catch(() => false)
      }
    } catch { /* usage logging is best effort */ }
  }

  /** Optional web lookup through the harness web service; failure is not fatal. */
  async function searchSupplement(ctx, question, item, selection) {
    const web = ctx.get('web')
    if (!web?.search) return { ok: false, sources: [], error: 'no web service' }
    // Search the question itself: adding the paper title mostly returns the
    // paper's own landing pages instead of outside background.
    const query = `${question} ${String(selection || '').slice(0, 80)}`
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200)
    if (!query) return { ok: false, sources: [], error: 'empty query' }
    const request = { query, maxResults: 4 }
    const errors = []
    try {
      const result = await runAsInitiator(ctx, () => web.search(request))
      const sources = normalizeSources(result)
      return { ok: true, sources }
    } catch (error) {
      errors.push(String(error?.message || error))
    }
    // The account-sign-in credential only resolves inside an agent turn, so a
    // plain call fails without an API key; retry with a live agent as initiator.
    try {
      const result = await web.search(request)
      return { ok: true, sources: normalizeSources(result) }
    } catch (error) {
      errors.push(String(error?.message || error))
    }
    return { ok: false, sources: [], error: errors[errors.length - 1] || 'search failed' }
  }

  function normalizeSources(result) {
    return (result?.sources || [])
      .filter(source => source?.url)
      .map(source => ({
        title: source.title || source.url,
        url: source.url,
        snippet: String(source.snippet || '').slice(0, 400),
      }))
  }

  /**
   * Run `task` as a live DeepSeek-Account agent: the web provider only uses the
   * signed-in account when `agents.currentInitiator()` reports such a session.
   */
  async function runAsInitiator(ctx, task) {
    const agents = ctx.get('agents')
    if (!agents?.initiators?.run || !agents.list) return task()
    const candidate = agents.list().find(agent => {
      try {
        return agent?.session?.requestContext?.()?.provider === 'deepseek-account'
      } catch {
        return false
      }
    })
    if (!candidate) return task()
    return agents.initiators.run(candidate, task)
  }

  function publicNoteJob(job) {
    return {
      itemId: job.itemId,
      running: job.running,
      step: job.step,
      text: job.text,
      log: job.log.slice(-20),
      startedAt: job.startedAt,
      finishedAt: job.finishedAt || null,
      tokens: job.tokens || null,
      truncated: Boolean(job.truncated),
      model: job.model || null,
      inputTruncated: Boolean(job.inputTruncated),
      inputChars: job.inputChars || 0,
      inputTotalChars: job.inputTotalChars || 0,
      result: job.result || null,
      error: job.error || null,
    }
  }

  /**
   * Notes run as a Host-side job: the browser may close the panel, switch
   * papers or reload, and polling `/notes/status` reattaches to the same run.
   */
  async function apiNotesStart(req, res) {
    const body = await readJson(req)
    const itemId = numberOrUndefined(body.itemId)
    if (!itemId) return sendJson(res, 400, { error: 'missing itemId' })
    const existing = state.noteJobs.get(itemId)
    if (existing && existing.running) {
      return sendJson(res, 200, { job: publicNoteJob(existing), resumed: true })
    }
    // Different papers may generate at the same time; keep the machine honest.
    const running = [...state.noteJobs.values()].filter(entry => entry.running)
    const limit = cfg.noteJobConcurrency || 4
    if (running.length >= limit) {
      return sendJson(res, 429, {
        error: `已有 ${running.length} 篇正在生成笔记（上限 ${limit}），等一篇完成后再试`,
      })
    }
    const job = {
      itemId,
      running: true,
      step: 'start',
      text: '准备中…',
      log: ['开始生成'],
      startedAt: Date.now(),
      updatedAt: Date.now(),
      model: normalizeModel(body.model),
      result: null,
      error: null,
    }
    state.noteJobs.set(itemId, job)
    runNoteJob(itemId, job)
    return sendJson(res, 200, { job: publicNoteJob(job), resumed: false })
  }

  async function apiNotesStatus(req, res, url) {
    const itemId = numberOrUndefined(url.searchParams.get('itemId'))
    if (!itemId) return sendJson(res, 400, { error: 'missing itemId' })
    const job = state.noteJobs.get(itemId)
    return sendJson(res, 200, { job: job ? publicNoteJob(job) : null })
  }

  /** Every known job, newest first, so the UI can show concurrent generation. */
  async function apiNotesJobs(req, res) {
    const jobs = []
    for (const job of state.noteJobs.values()) {
      let title = ''
      try {
        title = (await store.item(job.itemId))?.title || ''
      } catch { /* missing item: keep the row without a title */ }
      jobs.push({ ...publicNoteJob(job), title })
    }
    jobs.sort((first, second) => (second.startedAt || 0) - (first.startedAt || 0))
    return sendJson(res, 200, { jobs })
  }

  async function runNoteJob(itemId, job) {
    const progress = (step, text) => {
      job.step = step
      job.text = text
      job.log.push(text)
      if (job.log.length > 40) job.log.splice(0, job.log.length - 40)
      job.updatedAt = Date.now()
    }
    try {
      const item = await store.item(itemId)
      if (!item) throw new Error('论文条目不存在')
      const pdf = await store.firstPdf(itemId)
      if (!pdf) throw new Error('该条目没有本地 PDF 附件')
      progress('extract', '正在提取 PDF 正文…')
      const pythonOptions = {
        python: cfg.python,
        autoVenv: cfg.autoVenv !== false,
        pipIndex: cfg.pipIndex || '',
        onProgress: message => progress('extract', message),
      }
      const extract = await extractPdf(pdf.path, {
        ...pythonOptions,
        scriptPath: path.join(root, 'scripts', 'extract_pdf.py'),
        workDir: path.join(cfg.dataDir, 'tmp'),
      })
      progress('extract', `已读取 ${extract.pages.length} 页`)

      const slug = slugFor(item.title, item.key)
      const dir = path.join(cfg.outputDir, slug)
      await fsp.mkdir(dir, { recursive: true })
      // Version numbers must stay unique even after the user deletes a note in
      // Zotero: the history lives in both the surviving attachments and the
      // local files, so the next number is one past the highest either knows.
      const existingNotes = (item.attachments || []).filter(attachment =>
        attachment.isPdf && /阅读笔记/.test(attachment.title || ''))
      const versions = existingNotes.map(attachment => noteVersionOf(attachment.title))
      versions.push(...(await localNoteVersions(dir, slug)))
      const version = (versions.length ? Math.max(...versions) : 0) + 1
      const noteTitle = version > 1 ? `${item.title} - 阅读笔记 (v${version})` : `${item.title} - 阅读笔记`
      const figuresDir = path.join(dir, 'figures')
      let suffix = version > 1 ? `-v${version}` : ''
      // A leftover file from a deleted version must not be clobbered either.
      if (fs.existsSync(path.join(dir, `${slug}${suffix}.pdf`))) suffix = `-v${version}-${Date.now()}`

      progress('figures', '正在截取方法图…')
      const figures = await extractFigures(pdf.path, {
        ...pythonOptions,
        scriptPath: path.join(root, 'scripts', 'extract_figures.py'),
        outDir: figuresDir,
        workDir: path.join(cfg.dataDir, 'tmp'),
      })
      progress('figures', figures.length ? `已截取 ${figures.length} 张图` : '未截取到可用的图')

      const skillText = await fsp.readFile(path.join(cfg.skillDir, 'SKILL.md'), 'utf8').catch(() => '')
      const templateText = await fsp.readFile(path.join(cfg.skillDir, 'references', 'brief-template.md'), 'utf8').catch(() => '')
      if (!skillText) {
      // The reading skill is optional: fall back to the built-in structure.
      progress('draft', '未找到阅读技能，使用内置笔记结构')
    }
      const qa = await readQa(item.key)
      progress('draft', '正在按技能生成笔记…')
      const draft = await draftNote(ctx, cfg, {
        skillText,
        templateText,
        extract,
        item: { ...item, pdfName: pdf.filename },
        qa,
        figures,
        maxTokens: cfg.notesMaxTokens || 32_000,
        model: job.model,
      })
      const drafted = stripFence(draft.text)
      if (!drafted.trim()) throw new Error('模型没有返回内容')
      job.tokens = draft.usage || null
      job.truncated = Boolean(draft.truncated)
      job.inputTruncated = Boolean(draft.input?.truncated)
      job.inputChars = draft.input?.usedChars || 0
      job.inputTotalChars = draft.input?.totalChars || 0
      await recordUsage('notes', job.model, draft.usage, { itemId })
      if (job.truncated) progress('draft', '输出达到上限，笔记可能不完整')
      if (job.inputTruncated) {
        progress('draft', `原文过长，仅前 ${Math.round(job.inputChars / 1000)}K 字符参与生成`)
      }
      const markdown = keepReferencedFigures(drafted, figures)
      await pruneUnusedFigures(figuresDir, markdown)

      const mdPath = path.join(dir, `${slug}${suffix}.md`)
      await fsp.writeFile(mdPath, markdown, 'utf8')
      progress('render', '正在排版并打印 PDF…')

      const origin = ctx.webServer.getOrigin()
      const html = await renderNoteHtml({
        markdown,
        title: item.title,
        vendorBaseUrl: `${origin}/paper-reader/vendor`,
        vendorDir: path.join(root, 'vendor'),
        figureBaseUrl: `${origin}/paper-reader/note-asset?p=${encodeURIComponent(`${figuresDir}${path.sep}`)}`,
      })
      const htmlId = `${slug}-${Date.now()}`
      state.noteHtml.set(htmlId, html)
      const htmlUrl = `${origin}/paper-reader/note-html?id=${encodeURIComponent(htmlId)}`
      let pdfPath = path.join(dir, `${slug}${suffix}.pdf`)
      const printed = await htmlToPdf({
        target: htmlUrl,
        pdfPath,
        browser: findBrowser(cfg.browser),
      })
      progress('attach', '正在写入 Zotero 附件…')
      const attached = await attachToZotero({ item, pdfPath, title: noteTitle })
      job.result = {
        markdownPath: mdPath,
        pdfPath,
        bytes: printed.bytes,
        slug,
        version,
        qaCount: qa.length,
        figureCount: figures.length,
        attached,
      }
      job.text = '完成'
    } catch (error) {
      job.error = String(error?.message || error)
      job.text = `失败：${job.error}`
      job.log.push(job.text)
    } finally {
      job.running = false
      job.finishedAt = Date.now()
      // Keep the registry bounded, but never drop a running job.
      if (state.noteJobs.size > 20) {
        const finished = [...state.noteJobs.values()]
          .filter(entry => !entry.running)
          .sort((first, second) => (first.finishedAt || 0) - (second.finishedAt || 0))
        while (state.noteJobs.size > 20 && finished.length) {
          state.noteJobs.delete(finished.shift().itemId)
        }
      }
    }
  }

  async function apiAttach(req, res) {
    const body = await readJson(req)
    const itemId = numberOrUndefined(body.itemId)
    if (!itemId) return sendJson(res, 400, { error: 'missing itemId' })
    const item = await store.item(itemId)
    if (!item) return sendJson(res, 404, { error: 'item not found' })
    const pdfPath = body.pdfPath
    if (!pdfPath) return sendJson(res, 400, { error: 'missing pdfPath' })
    const result = await attachToZotero({ item, pdfPath, title: body.title })
    return sendJson(res, 200, result)
  }

  async function attachToZotero({ item, pdfPath, title }) {
    const resolvedTitle = title || `${item.title} - 阅读笔记`
    const ping = await bridgePing()
    if (ping.ok) {
      const result = await attachViaQueue({ item, pdfPath, title: resolvedTitle })
      if (result.ok) return { ...result, transport: 'queue' }
      return result
    }
    const http = await attachViaHttp({ item, pdfPath, title: resolvedTitle })
    if (http.ok) return { ...http, transport: 'http' }
    return {
      ok: false,
      reason: '未检测到 Zotero 桥接插件：先启动 Zotero，再在「工具 → 插件」里安装 paper-reader-bridge.xpi',
    }
  }

  function abortFor(req) {
    const controller = new AbortController()
    req.on('close', () => controller.abort())
    return controller.signal
  }
}

/** Accept a {provider, model, reasoningEffort} override, or undefined. */
function normalizeModel(value) {
  if (!value || typeof value !== 'object') return undefined
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (!provider || !model) return undefined
  const reasoningEffort = typeof value.reasoningEffort === 'string' ? value.reasoningEffort.trim() : ''
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
}

/** "… - 阅读笔记 (v3)" -> 3; a title without a suffix is version 1. */
function noteVersionOf(title) {
  const match = /\(v(\d+)\)/.exec(String(title || ''))
  return match ? Number(match[1]) : 1
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Versions that still exist on disk, so a deleted version is never reused. */
async function localNoteVersions(dir, slug) {
  let entries = []
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return []
  }
  const exact = new RegExp(`^${escapeRegExp(slug)}\\.pdf$`)
  const versioned = new RegExp(`^${escapeRegExp(slug)}-v(\\d+)(?:-\\d+)?\\.pdf$`)
  const versions = []
  for (const name of entries) {
    if (exact.test(name)) versions.push(1)
    const match = versioned.exec(name)
    if (match) versions.push(Number(match[1]))
  }
  return versions
}

function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.js' || ext === '.mjs') return 'text/javascript; charset=utf-8'
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.json') return 'application/json; charset=utf-8'
  if (ext === '.woff2') return 'font/woff2'
  if (ext === '.woff') return 'font/woff'
  if (ext === '.ttf') return 'font/ttf'
  if (ext === '.bcmap') return 'application/octet-stream'
  if (ext === '.pfb') return 'application/octet-stream'
  if (ext === '.wasm') return 'application/wasm'
  if (ext === '.html') return 'text/html; charset=utf-8'
  if (ext === '.svg') return 'image/svg+xml'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  return 'application/octet-stream'
}

/** Drop image references the model invented so the note never prints a broken box. */
function keepReferencedFigures(markdown, figures) {
  const allowed = new Set((figures || []).map(figure => `figures/${figure.file}`))
  const normalized = String(markdown || '').replace(/\.\/figures\//g, 'figures/')
  return normalized.replace(/!\[([^\]]*)\]\((figures\/[^)\s]+)\)/g, (match, alt, src) => (
    allowed.has(src) ? match : ''
  ))
}

/** Remove captured figures the note never mentions, so the output folder stays small. */
async function pruneUnusedFigures(figuresDir, markdown) {
  let entries = []
  try {
    entries = await fsp.readdir(figuresDir)
  } catch {
    return
  }
  for (const name of entries) {
    if (!markdown.includes(`figures/${name}`)) {
      await fsp.rm(path.join(figuresDir, name), { force: true }).catch(() => {})
    }
  }
}

function numberOrUndefined(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function sendJson(res, status, payload) {
  if (res.headersSent) {
    res.end()
    return
  }
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function createSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')
  return {
    send(payload) {
      if (res.writableEnded) return
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    },
    close() {
      if (!res.writableEnded) res.end()
    },
  }
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 32 * 1024 * 1024) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
