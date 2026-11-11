/**
 * Model access for translation, paper questions and note drafting.
 *
 * Everything goes through the Host `llm` service so the module uses whatever
 * provider/model the user already selected in Harness, without its own keys.
 */

function pickSelection(ctx, cfg, override) {
  if (override?.provider && override?.model) {
    return {
      provider: override.provider,
      model: override.model,
      ...(override.reasoningEffort ? { reasoningEffort: override.reasoningEffort } : {}),
    }
  }
  if (cfg?.provider && cfg?.model) return { provider: cfg.provider, model: cfg.model }
  const service = ctx.get('agentDefaultModel')
  const selection = service?.currentSelection?.()
  if (selection?.provider && selection?.model) {
    return {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    }
  }
  return undefined
}

export function modelInfo(ctx, cfg) {
  const selection = pickSelection(ctx, cfg)
  return selection || { provider: undefined, model: undefined }
}

/** Providers, their models and each model's reasoning efforts, for the pickers. */
export async function listModelCatalog(ctx) {
  const llm = ctx.get('llm')
  if (!llm?.listProviders) return { models: [], default: modelInfo(ctx) }
  const models = []
  for (const provider of llm.listProviders()) {
    let list = []
    try {
      list = await llm.listModels(provider.id)
    } catch {
      continue
    }
    for (const entry of list) {
      let reasoning = null
      try {
        const info = await llm.resolveModelInfo(provider.id, entry.id)
        if (info?.reasoning?.efforts?.length) {
          reasoning = {
            efforts: info.reasoning.efforts.map(effort => ({ id: effort.id, name: effort.name })),
            defaultEffort: info.reasoning.defaultEffort || null,
          }
        }
      } catch { /* model without capability metadata still selectable */ }
      models.push({
        provider: provider.id,
        providerName: provider.name || provider.id,
        id: entry.id,
        name: entry.name || entry.id,
        reasoning,
      })
    }
  }
  return { models, default: modelInfo(ctx) }
}

export async function* streamText(ctx, cfg, { system, prompt, maxTokens, signal, onUsage, onFinish, model }) {
  const llm = ctx.get('llm')
  if (!llm) throw new Error('Harness 未提供 llm 服务，无法调用模型')
  const selection = pickSelection(ctx, cfg, model)
  if (!selection) throw new Error('没有可用的默认模型，请先在 Harness 里选择模型')
  const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  const stream = llm.stream({
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    system,
    messages,
    ...(maxTokens ? { maxTokens } : {}),
    ...(signal ? { signal } : {}),
  })
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') {
      yield chunk.text
    } else if (chunk.type === 'usage') {
      onUsage?.(chunk.usage)
    } else if (chunk.type === 'finish') {
      onFinish?.(chunk.reason)
      if (chunk.reason?.kind === 'error') throw new Error(chunk.reason.failure?.message || '模型调用失败')
    }
  }
}

export async function completeText(ctx, cfg, request) {
  let text = ''
  for await (const delta of streamText(ctx, cfg, request)) text += delta
  return text
}

/** Normalize a provider usage chunk into the numbers we log and show. */
export function normalizeUsage(reported) {
  if (!reported) return null
  const uncachedInput = Number(reported.inputTokens) || 0
  const output = Number(reported.outputTokens) || 0
  const total = Number(reported.totalTokens) || (uncachedInput + output)
  const cached = Number(reported.cacheReadTokens) || 0
  // inputTokens counts only the uncached prompt; the billable total usually
  // includes cache reads, so recover the real input from the total when possible.
  const input = Math.max(uncachedInput + cached, total - output, uncachedInput)
  return { input, output, total, cached }
}

/** Same call as completeText, but also reports provider token accounting. */
export async function completeWithUsage(ctx, cfg, request) {
  let text = ''
  let usage = null
  let truncated = false
  const onUsage = (reported) => {
    const normalized = normalizeUsage(reported)
    if (normalized) usage = normalized
  }
  const onFinish = (reason) => { truncated = reason?.kind === 'max-tokens' }
  for await (const delta of streamText(ctx, cfg, { ...request, onUsage, onFinish })) text += delta
  return { text, usage, truncated }
}

const TRANSLATE_SYSTEM = [
  '你是学术论文翻译器。把英文原文逐段翻译成简体中文，供读者在 PDF 原位阅读。',
  '规则：',
  '1. 只输出翻译，不解释、不总结、不添加原文没有的内容。',
  '2. 保留全部数字、单位、变量名、模型名、数据集名、缩写、公式片段（如 mIoU、Sentinel-2、Transformer、$x_i$）原样。',
  '3. 译文要像中文论文，术语统一；不要逐词直译。',
  '4. 段落之间的换行保持对应。',
  '5. 若某段是参考文献、图表编号、纯符号或几乎不可译，原样返回该段。',
].join('\n')

function parseTranslationArray(raw, expected) {
  let text = String(raw || '').trim()
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1))
      if (Array.isArray(parsed)) {
        const strings = parsed.map(item => (typeof item === 'string' ? item : String(item?.text ?? '')))
        if (strings.length === expected) return strings
      }
    } catch { /* fall through */ }
  }
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  const numbered = lines
    .map(line => line.match(/^(?:段?\s*)?(\d{1,3})[.、:：)\]]\s*(.+)$/))
    .filter(Boolean)
  if (numbered.length === expected) return numbered.map(match => match[2])
  return undefined
}

/** Marker-delimited replies survive quotes and newlines better than JSON does. */
function parseMarkedTranslation(raw, expected) {
  const text = String(raw || '')
  const pattern = /<<<\s*(\d{1,3})\s*>>>/g
  const hits = []
  let match
  while ((match = pattern.exec(text)) !== null) {
    hits.push({ index: Number(match[1]), markStart: match.index, contentStart: pattern.lastIndex })
  }
  if (hits.length !== expected) return undefined
  const byIndex = new Map(hits.map(hit => [hit.index, hit]))
  if (byIndex.size !== expected) return undefined
  const ordered = hits.slice().sort((a, b) => a.markStart - b.markStart)
  const texts = new Map()
  ordered.forEach((hit, position) => {
    const end = position + 1 < ordered.length ? ordered[position + 1].markStart : text.length
    texts.set(hit.index, text.slice(hit.contentStart, end).trim())
  })
  const result = []
  for (let index = 1; index <= expected; index += 1) {
    if (!texts.has(index)) return undefined
    result.push(texts.get(index))
  }
  return result
}

function chunkBlocks(blocks, maxChars) {
  const batches = []
  let current = []
  let size = 0
  for (const block of blocks) {
    const length = block.text.length
    if (current.length && size + length > maxChars) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(block)
    size += length
  }
  if (current.length) batches.push(current)
  return batches
}

async function translateWithModel(ctx, cfg, blocks, signal) {
  const batches = chunkBlocks(blocks, 2600)
  const out = []
  for (const batch of batches) {
    const numbered = batch
      .map((block, index) => `<<<${index + 1}>>>\n${block.text}`)
      .join('\n\n')
    const prompt = [
      '请把下面每一段英文翻译成简体中文。',
      '输出格式：每段译文之前单独一行写标记 <<<序号>>>（序号与输入一致），标记后紧跟该段译文；不要输出解释、JSON、代码块或任何其他内容。',
      `共 ${batch.length} 段，序号 1 到 ${batch.length}。`,
      '',
      numbered,
    ].join('\n')
    let parsed
    for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
      const raw = await completeText(ctx, cfg, {
        system: TRANSLATE_SYSTEM,
        prompt: attempt === 0 ? prompt : `${prompt}\n\n注意：上一次输出缺少完整的 <<<序号>>> 标记，请严格按标记格式重做。`,
        maxTokens: Math.min(8000, 500 + batch.reduce((sum, block) => sum + block.text.length, 0) * 2),
        signal,
      })
      parsed = parseMarkedTranslation(raw, batch.length) || parseTranslationArray(raw, batch.length)
    }
    if (!parsed) {
      if (batch.length === 1) throw new Error('翻译结果解析失败，请重试或换用免费通道')
      // Fall back to one request per block rather than losing the whole page.
      const single = await translateWithModel(ctx, cfg, batch, signal)
      for (const item of single) out.push(item)
      continue
    }
    parsed.forEach((text, index) => out.push({ id: batch[index].id, text }))
  }
  return out
}

/** The anonymous endpoints cap one request at 4000 UTF-16 units. */
function splitForFree(text, limit = 3000) {
  if (text.length <= limit) return [text]
  const parts = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('. ', limit)
    if (cut < limit * 0.4) cut = rest.lastIndexOf('; ', limit)
    if (cut < limit * 0.4) cut = rest.lastIndexOf(' ', limit)
    if (cut < limit * 0.4) cut = limit - 1
    parts.push(rest.slice(0, cut + 1))
    rest = rest.slice(cut + 1)
  }
  if (rest.trim()) parts.push(rest)
  return parts
}

async function translateWithFree(ctx, cfg, blocks, signal) {
  const translator = ctx.get('translator')
  if (!translator) throw new Error('Harness 未提供 translator 服务，免费通道不可用')
  const providers = await translator.availableProviders(signal)
  const names = providers.map(provider => (typeof provider === 'string' ? provider : provider?.provider || provider?.id))
  const provider = names.includes('bing') ? 'bing' : names.includes('google') ? 'google' : names[0]
  if (!provider) throw new Error('没有可用的免费翻译通道')
  const out = []
  for (const block of blocks) {
    if (signal?.aborted) throw new Error('已取消')
    const translated = []
    for (const part of splitForFree(block.text)) {
      const spec = translator.resolve({ text: part, targetLanguage: 'zh-CN', provider })
      translated.push(await translator.translate(spec, signal))
    }
    out.push({ id: block.id, text: translated.join('') })
  }
  return out
}

export async function translateBlocks(ctx, cfg, blocks, engine, signal) {
  const clean = (blocks || []).filter(block => block && typeof block.text === 'string' && block.text.trim())
  if (!clean.length) return []
  if (engine === 'free') {
    const translator = ctx.get('translator')
    // A missing service degrades to the model; a failing request does not, so a
    // free-channel failure never silently spends tokens.
    if (!translator) return translateWithModel(ctx, cfg, clean, signal)
    return translateWithFree(ctx, cfg, clean, signal)
  }
  return translateWithModel(ctx, cfg, clean, signal)
}

export function availableEngines(ctx) {
  const engines = []
  if (pickSelection(ctx, {})) engines.push({ id: 'llm', label: 'DSH 模型' })
  const translator = ctx.get('translator')
  if (translator) engines.push({ id: 'free', label: '免费通道（Bing/Google）' })
  return engines
}

const ASK_SYSTEM = [
  '你是论文阅读助手，正在回答读者对一篇论文的提问。',
  '以论文内容为主；若问题涉及论文没有写到的通识、背景、术语或方法优缺点，且提供了「网络补充」，就用它回答，并在对应句子后用 [1][2] 标注来源。',
  '用了网络补充就必须标注来源编号；一条都没用到时不要出现 [n]，也不要把来源说成论文内容。',
  '回答要简短：一般 3-6 句或不超过 3 条要点，直接给结论，不要复述题目，不要逐条罗列“依据是摘要/选中段落”这类分析。',
  '只在整段末尾用半句注明出处，例如“（摘要）”“（选中段落）”“（Section 3.2）”；论文没有说法时直接说“论文中未说明”。',
  '输出纯文本：不要使用 Markdown 标记（不要 **、#、```、表格），段落之间空一行即可。',
  '涉及数字、指标、术语时保留原文写法。',
].join('\n')

export async function answerQuestion(ctx, cfg, { paper, question, selection, context, history, web, model, signal, onUsage }) {
  const blocks = []
  blocks.push(`论文标题：${paper?.title || '未知'}`)
  if (paper?.venue) blocks.push(`期刊/会议：${paper.venue}`)
  if (paper?.year) blocks.push(`年份：${paper.year}`)
  if (paper?.abstract) blocks.push(`摘要：\n${paper.abstract}`)
  if (context) blocks.push(`选中段落所在页的文本（节选）：\n${String(context).slice(0, 6000)}`)
  if (selection) blocks.push(`读者选中的原文：\n${selection}`)
  if (Array.isArray(history) && history.length) {
    const recent = history.slice(-3).map(item => `问：${item.question}\n答：${String(item.answer).slice(0, 600)}`)
    blocks.push(`此前的问答（供参考）：\n${recent.join('\n\n')}`)
  }
  if (Array.isArray(web) && web.length) {
    const lines = web.map((source, index) => `[${index + 1}] ${source.title}\n${source.url}\n${source.snippet || ''}`)
    blocks.push(`网络补充（仅作背景参考，与论文冲突时以论文为准）：\n${lines.join('\n\n')}`)
  }
  blocks.push(`读者的问题：${question}`)
  return streamText(ctx, cfg, {
    system: ASK_SYSTEM,
    prompt: blocks.join('\n\n'),
    maxTokens: 2000,
    model,
    ...(onUsage ? { onUsage } : {}),
    signal,
  })
}
