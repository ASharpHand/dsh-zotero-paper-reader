window.__ModuleLoader__.load({
  id: '@local/dsh-paper-reader',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } = React

    const API = '/paper-reader'

    /**
     * Bump when block segmentation changes: cached translations keyed by the old
     * paragraph text must not be reused, because their keys will never match.
     */
    const BLOCK_VERSION = 3

    // ------------------------------------------------------------------ utils

    async function apiGet(path) {
      const response = await fetch(API + path, { headers: { accept: 'application/json' } })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      return body
    }

    async function apiPost(path, payload) {
      const response = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      return body
    }

    async function streamPost(path, payload, onEvent, signal) {
      const response = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      })
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${response.status}`)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const chunk = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue
            const raw = line.slice(5).trim()
            if (!raw) continue
            try { onEvent(JSON.parse(raw)) } catch { /* ignore malformed frame */ }
          }
          boundary = buffer.indexOf('\n\n')
        }
      }
    }

    let pdfjsPromise
    let pdfjsModule
    function loadPdfjs() {
      if (!pdfjsPromise) {
        pdfjsPromise = import(`${API}/vendor/pdfjs/pdf.min.mjs`).then(module => {
          module.GlobalWorkerOptions.workerSrc = `${API}/vendor/pdfjs/pdf.worker.min.mjs`
          pdfjsModule = module
          return module
        })
      }
      return pdfjsPromise
    }

    async function startNoteJob(itemId, model) {
      const response = await fetch(`${API}/notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId, ...(model ? { model } : {}) }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      return body.job
    }

    /**
     * Every notes job the Host knows about, newest first. Jobs live on the Host,
     * so several papers can generate at once and hiding the panel loses nothing.
     */
    function useNotesJobs() {
      const [jobs, setJobs] = useState([])
      const [tick, setTick] = useState(0)

      useEffect(() => {
        let cancelled = false
        let timer = null
        const load = async () => {
          try {
            const body = await apiGet('/notes/jobs')
            if (cancelled) return
            const list = body.jobs || []
            setJobs(list)
            if (list.some(job => job.running)) timer = setTimeout(load, 2000)
          } catch { /* transient Host error: keep the previous snapshot */ }
        }
        load()
        return () => { cancelled = true; clearTimeout(timer) }
      }, [tick])

      const refresh = useCallback(() => setTick(value => value + 1), [])
      return { jobs, refresh }
    }

    function normalizeKey(text) {
      return String(text || '').replace(/\s+/g, ' ').trim()
    }

    /** Token counts read best in K/M: 940, 12.4K, 1.35M. */
    function formatTokens(value) {
      const total = Number(value) || 0
      if (!total) return ''
      if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(2)}M`
      if (total >= 1_000) return `${(total / 1_000).toFixed(1)}K`
      return String(total)
    }

    function isTranslatable(text) {
      const value = String(text || '').trim()
      if (!value) return false
      const letters = (value.match(/[A-Za-z]/g) || []).length
      const ratio = letters / value.length
      if (letters >= 18 && ratio > 0.45) return true
      // Section headings are short but worth translating: "3.1. Study area".
      const heading = /^\d{1,2}(\.\d{1,2})*\.?\s+[A-Z][A-Za-z0-9 ,&/-]{2,60}$/.test(value)
      return heading && letters >= 6 && ratio > 0.6
    }

    // ------------------------------------------------------- block extraction

    function splitColumns(boxes, minX, maxX) {
      const width = maxX - minX
      if (!(width > 80) || boxes.length < 8) return [boxes]
      // Full-width furniture (running heads, the title, footers) spans the gutter,
      // so only body-width boxes may vote on where the gutter is.
      const bodyBoxes = boxes.filter(box => box.width < width * 0.5)
      if (bodyBoxes.length < 6) return [boxes]

      // Pick the x in the middle of the page that the fewest body boxes cross.
      // Justified lines and split running heads reach into the gutter, so this
      // scores candidates instead of looking for a completely empty band.
      let best = null
      const from = minX + width * 0.3
      const to = minX + width * 0.7
      for (let x = from; x <= to; x += 2) {
        let crossing = 0
        let leftCount = 0
        let rightCount = 0
        for (const box of bodyBoxes) {
          const boxLeft = box.x
          const boxRight = box.x + box.width
          if (boxLeft < x - 1 && boxRight > x + 1) crossing += 1
          if (boxRight <= x + 1) leftCount += 1
          if (boxLeft >= x - 1) rightCount += 1
        }
        if (leftCount < 3 || rightCount < 3) continue
        if (!best || crossing < best.crossing) best = { crossing, x, leftCount, rightCount }
      }
      if (!best || best.crossing > bodyBoxes.length * 0.12) return [boxes]
      const split = best.x
      const left = boxes.filter(box => box.x + box.width / 2 < split)
      const rightSide = boxes.filter(box => box.x + box.width / 2 >= split)
      return left.length && rightSide.length ? [left, rightSide] : [boxes]
    }

    function joinLineText(boxes) {
      let text = ''
      for (const box of boxes) {
        const piece = box.text
        if (!text) { text = piece; continue }
        if (/-$/.test(text) && /^[a-z]/.test(piece)) text = text.slice(0, -1) + piece
        else text += (text.endsWith(' ') ? '' : ' ') + piece
      }
      return text.replace(/\s+/g, ' ').trim()
    }

    // Running heads, footers, copyright lines and captions stay in English.
    const META = /^(manuscript received|digital object identifier|authorized licensed|all rights reserved|copyright|©|issn\b|isbn\b|https?:\/\/doi|doi:\s*10\.|downloaded (on|from)|received \d|accepted \d|revised \d|published \d)/i
    const META_ANYWHERE = /authorized licensed use|personal use is permitted|all rights reserved|©\s*\d{4}|downloaded (on|from)/i
    // One such line must never be merged into a body paragraph.
    const CAPTION = /^(fig(ure)?\.?\s*\d+|table\s*\d+|图\s*\d+|表\s*\d+)/i

    function buildBlocks(boxes) {
      if (!boxes.length) return []
      const minX = Math.min(...boxes.map(box => box.x))
      const maxX = Math.max(...boxes.map(box => box.x + box.width))
      const columns = splitColumns(boxes, minX, maxX)
      const blocks = []
      for (const column of columns) {
        const sorted = column.slice().sort((a, b) => (Math.abs(a.y - b.y) > 2 ? a.y - b.y : a.x - b.x))
        const lines = []
        for (const box of sorted) {
          const line = lines[lines.length - 1]
          if (line && Math.abs(line.baseline - box.y) <= Math.max(2.5, box.height * 0.45)) {
            line.boxes.push(box)
            line.baseline = Math.min(line.baseline, box.y)
            line.bottom = Math.max(line.bottom, box.y + box.height)
            line.height = Math.max(line.height, box.height)
          } else {
            lines.push({ baseline: box.y, bottom: box.y + box.height, height: box.height, boxes: [box] })
          }
        }
        let current = null
        for (const line of lines) {
          line.boxes.sort((a, b) => a.x - b.x)
          const text = joinLineText(line.boxes)
          if (!text) continue
          const top = Math.min(...line.boxes.map(box => box.y))
          const bottom = Math.max(...line.boxes.map(box => box.y + box.height))
          const left = Math.min(...line.boxes.map(box => box.x))
          const right = Math.max(...line.boxes.map(box => box.x + box.width))
          // Rows in a table split into several short cells separated by wide gaps.
          let maxGap = 0
          for (let index = 1; index < line.boxes.length; index += 1) {
            const gap = line.boxes[index].x - (line.boxes[index - 1].x + line.boxes[index - 1].width)
            if (gap > maxGap) maxGap = gap
          }
          const wideLine = line.boxes.length >= 3 && maxGap > (maxX - minX) * 0.06
          // Never merge across a font-size jump: a running head must not swallow
          // the title, and a title must not swallow the author row.
          const fontJump = current !== null
            && Math.abs(line.height - current.fontSize) > Math.max(2.5, current.fontSize * 0.4)
          // Copyright / licence / access lines sit right under the last body
          // line of a column; merging them would make the whole paragraph look
          // like metadata and skip it.
          const furniture = META.test(text) || META_ANYWHERE.test(text)
          // A lower-case line right below a furniture line is its continuation
          // (the funding note under "Received …"), so it stays furniture too.
          const continuesFurniture = Boolean(current?.furniture) && !furniture && /^[a-z(]/.test(text)
          if (current && !fontJump && !furniture && (continuesFurniture || !current.furniture)
            && top - current.y - current.height < line.height * 0.72) {
            current.text += (current.text.endsWith('-') && /^[a-z]/.test(text)
              ? text
              : ` ${text}`).replace(/-\s+([a-z])/g, '-$1')
            // Bounding box must be the union of every merged line, otherwise the
            // translation box leaves the tail of longer lines uncovered.
            if (left < current.x) current.x = left
            if (right > current.right) current.right = right
            if (bottom > current.bottom) current.bottom = bottom
            current.width = current.right - current.x
            current.height = current.bottom - current.y
            current.lineCount += 1
            if (wideLine) current.wideCount += 1
          } else {
            current = {
              x: left,
              y: top,
              right,
              bottom,
              width: right - left,
              height: bottom - top,
              fontSize: line.height,
              text,
              furniture,
              lineCount: 1,
              wideCount: wideLine ? 1 : 0,
            }
            blocks.push(current)
          }
        }
      }
      const kept = blocks.filter(block => block.width > 4 && block.height > 3)
      const pageHeight = Math.max(1, ...kept.map(block => block.y + block.height))
      // Body size is the median of every text run: most blocks on a first page are
      // small print (references, copyright), so a per-block median undershoots.
      const itemHeights = boxes.map(box => box.height).sort((a, b) => a - b)
      const medianFont = itemHeights[Math.floor(itemHeights.length / 2)] || 10


      return kept.map(block => {
        const text = block.text
        const trimmed = text.trim()
        // One oddly spaced line is text; most lines spaced like cells is a table.
        const tableish = block.wideCount >= 2
          && block.wideCount / Math.max(1, block.lineCount) >= 0.4
        // Only small print in the margins is furniture: a title placed high on the
        // page must still translate, so large-font blocks are exempt.
        const inMargin = (block.y < pageHeight * 0.04 && block.fontSize <= medianFont * 1.4)
          || (block.y > pageHeight * 0.9 && block.height < pageHeight * 0.06)
        const metadata = META.test(trimmed) || META_ANYWHERE.test(trimmed)
        const caption = CAPTION.test(trimmed)
        const digitRatio = (trimmed.match(/\d/g) || []).length / Math.max(1, trimmed.length)
        // Table fragments that lost their caption: short and number-dominated.
        const numericish = trimmed.length < 90 && digitRatio > 0.12
        const skip = inMargin || metadata || caption || tableish || numericish
        return {
          ...block,
          key: normalizeKey(text),
          translate: !skip && isTranslatable(text),
        }
      })
    }

    // ------------------------------------------------------------- components

    function PanelIcon({ size, active }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active ? 2.1 : 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', opacity: active ? 1 : 0.82 },
      },
        h('path', { d: 'M5 4.5h9.5A2.5 2.5 0 0 1 17 7v13H7.5A2.5 2.5 0 0 1 5 17.5z' }),
        h('path', { d: 'M17 8h1.5A1.5 1.5 0 0 1 20 9.5V18a2 2 0 0 1-2 2h-1' }),
        h('path', { d: 'M8.5 9h5M8.5 12.5h5M8.5 16h3' }),
      )
    }

    function Spinner({ label }) {
      return h('div', { className: 'pr-loading' }, h('span', { className: 'pr-spin' }), label ? h('span', null, label) : null)
    }

    function ErrorBox({ message }) {
      if (!message) return null
      return h('div', { className: 'pr-error' }, message)
    }

    function Tree({ collections, selected, onSelect, counts }) {
      const roots = collections.filter(collection => collection.parent === null || collection.parent === 0)
      const childrenOf = parent => collections.filter(collection => collection.parent === parent)
      const [collapsed, setCollapsed] = useState(viewState.treeCollapsed || {})
      const total = counts?.items ?? 0
      const renderNode = (collection, depth) => {
        const kids = childrenOf(collection.id)
        const isOpen = !collapsed[collection.id]
        const active = selected === collection.id
        return h('div', { key: collection.id },
          h('div', {
            className: 'pr-tree-row' + (active ? ' is-active' : ''),
            style: { paddingLeft: 6 + depth * 12 },
            onClick: () => onSelect(collection.id),
            title: collection.name,
          },
            kids.length
              ? h('button', {
                  className: 'pr-caret' + (isOpen ? ' is-open' : ''),
                  onClick: event => {
                    event.stopPropagation()
                    const next = { ...collapsed, [collection.id]: isOpen }
                    viewState.treeCollapsed = next
                    setCollapsed(next)
                  },
                  'aria-label': isOpen ? '折叠' : '展开',
                }, h('svg', { viewBox: '0 0 16 16', width: 11, height: 11, 'aria-hidden': true },
                  h('path', {
                    d: 'M6 3.6 10.4 8 6 12.4',
                    fill: 'none',
                    stroke: 'currentColor',
                    strokeWidth: 1.9,
                    strokeLinecap: 'round',
                    strokeLinejoin: 'round',
                  })))
              : h('span', { className: 'pr-caret-space' }),
            h('span', { className: 'pr-tree-name' }, collection.name),
            h('span', { className: 'pr-tree-count' }, collection.count),
          ),
          isOpen ? kids.map(kid => renderNode(kid, depth + 1)) : null,
        )
      }
      return h('div', { className: 'pr-tree' },
        h('div', { className: 'pr-tree-head' },
          h('span', null, '文献库'),
          h('span', { className: 'pr-tree-head-count' }, total),
        ),
        h('div', {
          className: 'pr-tree-row' + (selected === null ? ' is-active' : ''),
          onClick: () => onSelect(null),
        },
          h('span', { className: 'pr-caret-space' }),
          h('span', { className: 'pr-tree-name' }, '全部文献'),
          h('span', { className: 'pr-tree-count' }, total),
        ),
        roots.map(root => renderNode(root, 0)),
      )
    }

    function ItemRow({ item, active, onOpen }) {
      return h('div', {
        className: 'pr-item' + (active ? ' is-active' : ''),
        onClick: () => onOpen(item),
      },
        h('div', { className: 'pr-item-title' }, item.title),
        h('div', { className: 'pr-item-meta' },
          h('span', { className: 'pr-item-year' }, item.year || '—'),
          item.venue ? h('span', { className: 'pr-item-venue' }, item.venue) : null,
        ),
        h('div', { className: 'pr-item-badges' },
          item.pdfs ? h('span', { className: 'pr-badge is-pdf' }, 'PDF') : h('span', { className: 'pr-badge is-muted' }, '无 PDF'),
          item.notes ? h('span', { className: 'pr-badge is-notes' }, `笔记 ${item.notes}`) : null,
        ),
      )
    }

    function Detail({ item, onRead, onNotes, noteJob, notes = [], onOpenNote, qaCount, model, catalog, onModelChange }) {
      const [confirmRegen, setConfirmRegen] = useState(false)
      if (!item) {
        return h('div', { className: 'pr-empty' },
          h('svg', { className: 'pr-empty-icon', viewBox: '0 0 48 48', 'aria-hidden': true },
            h('path', {
              d: 'M10 10h16a5 5 0 0 1 5 5v23H15a5 5 0 0 1-5-5z',
              fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinejoin: 'round',
            }),
            h('path', { d: 'M31 16h4a3 3 0 0 1 3 3v16a5 5 0 0 1-5 5h-2', fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' }),
            h('path', { d: 'M16 19h9M16 25h9M16 31h5', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' }),
          ),
          h('div', { className: 'pr-empty-title' }, '选择一篇论文'),
          h('div', { className: 'pr-empty-body' }, '左侧按 Zotero 集合浏览，点击条目查看详情并打开 PDF。'))
      }
      const pdf = item.attachments.find(attachment => attachment.isPdf)
      return h('div', { className: 'pr-detail' },
        h('div', { className: 'pr-detail-head' },
          h('h2', { className: 'pr-detail-title' }, item.title),
          h('div', { className: 'pr-detail-sub' },
            item.creators.map(creator => creator.name).slice(0, 6).join('；') || '—',
          ),
          h('div', { className: 'pr-detail-chips' },
            item.type ? h('span', { className: 'pr-chip is-brand' }, item.type) : null,
            item.year ? h('span', { className: 'pr-chip' }, item.year) : null,
            item.publication ? h('span', { className: 'pr-chip' }, item.publication) : null,
            item.doi ? h('span', { className: 'pr-chip' }, item.doi) : null,
            qaCount ? h('span', { className: 'pr-chip' }, `问答 ${qaCount} 条`) : null,
          ),
          h('div', { className: 'pr-detail-actions' },
            h('button', {
              className: 'pr-btn is-primary',
              disabled: !pdf,
              onClick: () => onRead(item, pdf),
            }, pdf ? '打开 PDF' : '没有 PDF 附件'),
            h('button', {
              className: 'pr-btn',
              disabled: Boolean(noteJob?.running) || (!pdf && !notes.length),
              onClick: () => {
                if (noteJob?.running) return
                if (notes.length) {
                  onOpenNote(notes[0])
                  return
                }
                onNotes(item)
              },
            }, noteJob?.running ? '生成中…（后台运行）' : (notes.length ? '查看笔记' : '生成阅读笔记')),
          ),
        ),
        h('div', { className: 'pr-detail-grid' },
          h('div', { className: 'pr-card' },
            h('h3', { className: 'pr-card-title' }, '摘要'),
            h('p', { className: 'pr-abstract' }, item.abstract || '（无摘要）'),
          ),
          h('div', { className: 'pr-card' },
            h('h3', { className: 'pr-card-title' }, '元数据'),
            h('table', { className: 'pr-table' }, h('tbody', null,
              row('类型', item.type),
              row('DOI', item.doi || '—'),
              row('语言', item.language || '—'),
              row('标签', item.tags.join('、') || '—'),
              row('PDF', pdf ? pdf.filename : '无'),
            )),
            h('h3', { className: 'pr-card-title' }, '附件'),
            item.attachments.length
              ? h('ul', { className: 'pr-attachments' }, item.attachments.map(attachment =>
                  h('li', { key: attachment.id },
                    h('span', { className: 'pr-attach-name' }, attachment.filename || '(无文件名)'),
                    h('span', { className: 'pr-attach-type' }, attachment.contentType || ''))))
              : h('p', { className: 'pr-muted' }, '没有附件'),
            noteJob?.running ? h('div', { className: 'pr-notes-log' },
              h('div', { className: 'pr-notes-line' }, h('span', { className: 'pr-spin' }), ' ', noteJob.text || '生成中…')) : null,
            noteJob?.error ? h('div', { className: 'pr-notes-result is-error' }, noteJob.error) : null,
            noteJob?.result ? h('div', { className: 'pr-notes-result' },
              h('div', null, '笔记 PDF 已生成：'),
              h('code', { className: 'pr-path' }, noteJob.result.pdfPath),
              h('div', { className: 'pr-attach-state' },
                noteJob.result.attached?.ok
                  ? `已写入 Zotero 附件（${noteJob.result.attached.attachmentKey}）`
                  : `未写入 Zotero：${noteJob.result.attached?.reason || '未知原因'}`),
              noteJob.tokens?.total
                ? h('div', { className: 'pr-attach-state' }, `本次消耗 ${formatTokens(noteJob.tokens.total)} token`)
                : null,
              noteJob.truncated
                ? h('div', { className: 'pr-notes-warn' }, '输出达到上限，笔记可能不完整')
                : null,
              noteJob.inputTruncated
                ? h('div', { className: 'pr-notes-warn' },
                    `原文过长，仅前 ${(noteJob.inputChars / 10000).toFixed(1)} 万字符参与生成（共 ${(noteJob.inputTotalChars / 10000).toFixed(1)} 万）`)
                : null,
            ) : null,
            h('h3', { className: 'pr-card-title' }, '阅读笔记'),
            h('div', { className: 'pr-note-tools' },
              h(ModelPicker, { catalog, value: model, onChange: onModelChange }),
            ),
            notes.length
              ? h('div', { className: 'pr-note-versions' },
                  h('div', { className: 'pr-muted' }, `共 ${notes.length} 版，默认打开最新版`),
                  notes.map((note, index) => h('div', { key: note.id, className: 'pr-note-version' },
                    h('span', { className: 'pr-note-version-badge' }, `v${note.version}`),
                    h('span', { className: 'pr-note-version-name', title: note.title || '' },
                      note.title || '阅读笔记'),
                    index === 0 ? h('span', { className: 'pr-note-version-latest' }, '最新') : null,
                    h('button', { className: 'pr-btn pr-btn-sm', onClick: () => onOpenNote(note) }, '打开'),
                  )),
                )
              : h('p', { className: 'pr-muted' }, '还没有阅读笔记'),
            notes.length
              ? (confirmRegen
                  ? h('div', { className: 'pr-confirm' },
                      h('span', null, `已有 ${notes.length} 版笔记。重新生成会新增一版，旧版不会被覆盖。`),
                      h('button', { className: 'pr-btn', onClick: () => { setConfirmRegen(false); onNotes(item) } }, '继续生成'),
                      h('button', { className: 'pr-btn', onClick: () => setConfirmRegen(false) }, '取消'),
                    )
                  : h('div', { className: 'pr-notes-actions' },
                      h('button', { className: 'pr-btn', onClick: () => onOpenNote(notes[0]) }, '打开最新版'),
                      h('button', { className: 'pr-btn', onClick: () => setConfirmRegen(true) }, '重新生成'),
                    ))
              : null,
          ),
        ),
      )
      function row(label, value) {
        return h('tr', null, h('th', null, label), h('td', null, String(value ?? '—')))
      }
    }

    // ---------------------------------------------------------------- reader

    function PdfPage({ doc, num, scale, active, blocks, translateOn, translations, onTextSelection }) {
      const canvasRef = useRef(null)
      const textRef = useRef(null)
      const [spans, setSpans] = useState([])
      const [failed, setFailed] = useState('')

      useEffect(() => {
        if (!active || !doc) return undefined
        let cancelled = false
        ;(async () => {
          try {
            const page = await doc.getPage(num)
            if (cancelled) return
            const viewport = page.getViewport({ scale })
            const canvas = canvasRef.current
            if (!canvas) return
            const dpr = Math.min(2, window.devicePixelRatio || 1)
            canvas.width = Math.floor(viewport.width * dpr)
            canvas.height = Math.floor(viewport.height * dpr)
            canvas.style.width = `${Math.floor(viewport.width)}px`
            canvas.style.height = `${Math.floor(viewport.height)}px`
            const context = canvas.getContext('2d', { alpha: false })
            await page.render({
              canvasContext: context,
              viewport,
              transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
            }).promise
            if (cancelled) return
            const content = await page.getTextContent()
            const items = []
            for (const item of content.items) {
              if (!item.str || !item.str.trim()) continue
              const transform = pdfjsModule.Util.transform(viewport.transform, item.transform)
              const fontHeight = Math.hypot(transform[2], transform[3]) || item.height * scale
              items.push({
                text: item.str,
                left: transform[4],
                top: transform[5] - fontHeight,
                fontSize: fontHeight,
                width: item.width * scale,
              })
            }
            if (!cancelled) setSpans(items)
          } catch (error) {
            if (!cancelled) setFailed(String(error?.message || error))
          }
        })()
        return () => { cancelled = true }
      }, [doc, num, scale, active])

      useLayoutEffect(() => {
        const layer = textRef.current
        if (!layer) return
        const children = layer.children
        for (let index = 0; index < children.length; index += 1) {
          const child = children[index]
          const target = Number(child.dataset.width || 0)
          if (!target) continue
          child.style.transform = 'scaleX(1)'
          const measured = child.getBoundingClientRect().width
          if (measured > 1) child.style.transform = `scaleX(${target / measured})`
        }
      }, [spans])

      const overlay = []
      if (translateOn && blocks && translations) {
        for (const block of blocks) {
          if (!block.translate) continue
          const translated = translations[block.key]
          if (!translated) continue
          overlay.push(h(TranslatedBlock, {
            key: block.key + block.x.toFixed(1) + block.y.toFixed(1),
            block,
            scale,
            text: translated,
          }))
        }
      }

      return h('div', { className: 'pr-page' + (active ? ' is-ready' : '') },
        !active ? h('div', { className: 'pr-page-placeholder' }, `第 ${num} 页`) : null,
        h('canvas', { ref: canvasRef, className: 'pr-page-canvas' }),
        h('div', {
          ref: textRef,
          className: 'pr-text-layer',
          onMouseUp: event => onTextSelection(event, num),
          onTouchEnd: event => onTextSelection(event, num),
        }, spans.map((span, index) => h('span', {
          key: index,
          className: 'pr-text-span',
          'data-width': span.width,
          style: {
            left: `${span.left}px`,
            top: `${span.top}px`,
            fontSize: `${span.fontSize}px`,
          },
        }, span.text))),
        overlay,
        failed ? h('div', { className: 'pr-page-error' }, failed) : null,
      )
    }

    function TranslatedBlock({ block, scale, text }) {
      const ref = useRef(null)
      useLayoutEffect(() => {
        const node = ref.current
        if (!node) return
        let size = block.fontSize * scale * 1.02
        node.style.fontSize = `${size}px`
        for (let guard = 0; guard < 60; guard += 1) {
          if (node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1) break
          if (size <= 5) break
          size -= Math.max(0.35, size * 0.04)
          node.style.fontSize = `${size}px`
        }
      }, [text, scale, block])
      return h('div', {
        ref,
        className: 'pr-trans-block',
        style: {
          // A couple of pixels of bleed hide glyphs that overhang the reported box.
          left: `${block.x * scale - 2}px`,
          top: `${block.y * scale - 2}px`,
          width: `${block.width * scale + 4}px`,
          height: `${block.height * scale + 4}px`,
        },
      }, text)
    }

    /** Model + thinking-effort pickers, mirroring the conversation composer. */
    function ModelPicker({ catalog, value, onChange }) {
      const models = catalog?.models || []
      if (!models.length) return null
      const defaultKey = catalog?.default ? `${catalog.default.provider}/${catalog.default.model}` : ''
      const selectedKey = value?.provider && value?.model ? `${value.provider}/${value.model}` : defaultKey
      const current = models.find(entry => `${entry.provider}/${entry.id}` === selectedKey) || models[0]
      const efforts = current?.reasoning?.efforts || []
      const effort = value?.reasoningEffort || current?.reasoning?.defaultEffort || ''
      const multipleProviders = new Set(models.map(entry => entry.provider)).size > 1
      return h('span', { className: 'pr-model-picker' },
        h('select', {
          className: 'pr-select pr-select-sm',
          value: `${current.provider}/${current.id}`,
          title: '模型',
          onChange: event => {
            const [provider, model] = event.target.value.split('/')
            const picked = models.find(entry => entry.provider === provider && entry.id === model)
            onChange({ provider, model, reasoningEffort: picked?.reasoning?.defaultEffort || '' })
          },
        }, models.map(entry => h('option', {
          key: `${entry.provider}/${entry.id}`,
          value: `${entry.provider}/${entry.id}`,
        }, multipleProviders ? `${entry.name} · ${entry.providerName}` : entry.name))),
        efforts.length
          ? h('select', {
              className: 'pr-select pr-select-sm',
              value: effort,
              title: '思考程度',
              onChange: event => onChange({
                provider: current.provider,
                model: current.id,
                reasoningEffort: event.target.value,
              }),
            }, efforts.map(item => h('option', { key: item.id, value: item.id }, item.name)))
          : null,
      )
    }

    /** Minimal rich-text rendering for answers: paragraphs, lists, bold, code. */
    function renderRichText(text) {
      const source = String(text || '')
      if (!source.trim()) return null
      const blocks = source.split(/\n{2,}/)
      const nodes = []
      blocks.forEach((block, blockIndex) => {
        const lines = block.split('\n').map(line => line.trim()).filter(Boolean)
        if (!lines.length) return
        const isBullet = lines.every(line => /^[-*]\s+/.test(line))
        const isNumbered = lines.every(line => /^\d+[.)]\s+/.test(line))
        if (isBullet || isNumbered) {
          nodes.push(h(isBullet ? 'ul' : 'ol', { key: `list-${blockIndex}`, className: 'pr-rich-list' },
            lines.map((line, index) => h('li', { key: index },
              inlineRichText(line.replace(/^([-*]|\d+[.)])\s+/, ''))))))
          return
        }
        nodes.push(h('p', { key: `p-${blockIndex}`, className: 'pr-rich-p' },
          lines.map((line, index) => h('span', { key: index },
            index ? h('br', null) : null,
            inlineRichText(line)))))
      })
      return nodes
    }

    function inlineRichText(line) {
      const parts = []
      const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g
      let last = 0
      let match
      let key = 0
      while ((match = pattern.exec(line)) !== null) {
        if (match.index > last) parts.push(line.slice(last, match.index))
        if (match[1]) parts.push(h('strong', { key: key++ }, match[1]))
        else parts.push(h('code', { key: key++, className: 'pr-inline-code' }, match[2]))
        last = match.index + match[0].length
      }
      if (last < line.length) parts.push(line.slice(last))
      return parts
    }

    function timeLabel(iso) {
      if (!iso) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      const pad = value => String(value).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function AskMessage({ entry, onCopy, copied }) {
      return h('div', { className: 'pr-msg' },
        entry.selection
          ? h('blockquote', { className: 'pr-msg-quote', title: entry.selection }, entry.selection)
          : null,
        h('div', { className: 'pr-msg-q' }, entry.question),
        h('div', { className: 'pr-msg-a' }, renderRichText(entry.answer) || h('span', { className: 'pr-muted' }, '（无内容）')),
        entry.sources?.length
          ? h('div', { className: 'pr-msg-sources' }, entry.sources.map((source, index) => h('a', {
              key: index,
              className: 'pr-msg-source',
              href: source.url || '#',
              target: '_blank',
              rel: 'noreferrer',
              title: source.url || '',
            }, `${index + 1}. ${source.title || source.url}`)))
          : null,
        entry.webUnavailable && !entry.sources?.length
          ? h('div', { className: 'pr-msg-note' }, entry.webError ? `网络补充不可用：${entry.webError.slice(0, 80)}` : '网络补充不可用')
          : null,
        h('div', { className: 'pr-msg-meta' },
          h('span', { className: 'pr-msg-time' }, timeLabel(entry.at)),
          entry.webRequested
            ? h('span', { className: 'pr-msg-web' },
                entry.sources?.length ? `已联网 · ${entry.sources.length} 条` : '联网 · 无结果')
            : null,
          h('button', { className: 'pr-msg-action', onClick: () => onCopy(entry.answer) }, copied ? '已复制' : '复制')))
    }

    const ASK_SUGGESTIONS = [
      '这篇论文要解决什么问题？',
      '方法的关键创新是什么？',
      '实验用了哪些数据集和指标？',
    ]

    function AskDrawer({ item, selection, page, onClose, onAsked, model, catalog, onModelChange }) {
      const [question, setQuestion] = useState('')
      const [pending, setPending] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [entries, setEntries] = useState([])
      const [contextOpen, setContextOpen] = useState(false)
      const [showAll, setShowAll] = useState(false)
      const [stuck, setStuck] = useState(false)
      const [webStatus, setWebStatus] = useState(null)
      const [inflight, setInflight] = useState(null)
      const [clock, setClock] = useState(() => Date.now())
      const [copiedAt, setCopiedAt] = useState(0)
      const busyRef = useRef(false)
      const lastAskedRef = useRef(null)
      const [width, setWidth] = useState(() => {
        const stored = Number(localStorage.getItem('dpr:ask:width'))
        return Number.isFinite(stored) && stored >= 320 ? stored : 396
      })
      const [webOn, setWebOn] = useState(() => {
        try {
          const stored = localStorage.getItem('dpr:ask:web')
          return stored === null ? true : stored === '1'
        } catch {
          return true
        }
      })
      const abortRef = useRef(null)
      const threadRef = useRef(null)
      const inputRef = useRef(null)
      const stickRef = useRef(true)
      const selectionRef = useRef({ selection, page })
      selectionRef.current = { selection, page }
      const draftKey = `dpr:ask:draft:${item.id}`

      useEffect(() => {
        let cancelled = false
        apiGet(`/item?id=${item.id}`)
          .then(body => {
            if (!cancelled) setEntries((body.qa || []).slice().reverse())
          })
          .catch(() => {})
        return () => { cancelled = true }
      }, [item.id])

      useEffect(() => {
        try {
          const stored = localStorage.getItem(draftKey)
          if (stored) setQuestion(stored)
        } catch { /* storage disabled */ }
        const timer = setTimeout(() => inputRef.current?.focus(), 60)
        return () => clearTimeout(timer)
      }, [draftKey])

      useEffect(() => {
        try {
          if (question) localStorage.setItem(draftKey, question)
          else localStorage.removeItem(draftKey)
        } catch { /* storage disabled */ }
      }, [question, draftKey])

      // Grow the composer with the draft, up to a small cap.
      useEffect(() => {
        const node = inputRef.current
        if (!node) return
        node.style.height = 'auto'
        node.style.height = `${Math.min(168, Math.max(56, node.scrollHeight))}px`
      }, [question])

      useEffect(() => {
        try { localStorage.setItem('dpr:ask:width', String(width)) } catch { /* storage disabled */ }
      }, [width])

      useEffect(() => {
        try { localStorage.setItem('dpr:ask:web', webOn ? '1' : '0') } catch { /* storage disabled */ }
      }, [webOn])

      // Keep the newest exchange in view unless the reader scrolled up.
      useEffect(() => {
        const node = threadRef.current
        if (!node || !stickRef.current) return
        node.scrollTop = node.scrollHeight
      }, [entries.length, pending, inflight])

      // Tick a clock while a request is in flight so waiting is visible.
      useEffect(() => {
        if (!inflight) return undefined
        const timer = setInterval(() => setClock(Date.now()), 500)
        return () => clearInterval(timer)
      }, [inflight])

      const onThreadScroll = () => {
        const node = threadRef.current
        if (!node) return
        const distance = node.scrollHeight - node.scrollTop - node.clientHeight
        stickRef.current = distance < 60
        setStuck(distance > 120)
      }

      /** One request round trip, shared by send and retry. */
      const send = useCallback(async (text, askedInput) => {
        const content = String(text || '').trim()
        if (!content || busyRef.current) return
        const asked = askedInput || {
          selection: selectionRef.current.selection || '',
          page: selectionRef.current.page || null,
        }
        lastAskedRef.current = { question: content, ...asked }
        busyRef.current = true
        setBusy(true)
        setPending('')
        setError('')
        setWebStatus(webOn ? { status: 'searching', count: 0, error: '' } : null)
        setInflight({ question: content, ...asked, startedAt: Date.now() })
        setClock(Date.now())
        stickRef.current = true
        const controller = new AbortController()
        abortRef.current = controller
        try {
          await streamPost('/ask', {
            itemId: item.id,
            question: content,
            selection: asked.selection,
            page: asked.page,
            context: '',
            web: webOn,
            model,
          }, event => {
            if (event.type === 'delta') setPending(previous => previous + event.text)
            else if (event.type === 'web') {
              setWebStatus({ status: event.status, count: event.count || 0, error: event.error || '' })
            } else if (event.type === 'done') {
              setEntries(previous => [...previous, {
                question: content,
                answer: event.answer,
                selection: asked.selection,
                page: asked.page,
                sources: Array.isArray(event.sources) ? event.sources : [],
                webUnavailable: Boolean(event.webUnavailable),
                webError: event.webError || '',
                webRequested: webOn,
                at: new Date().toISOString(),
              }])
              setPending('')
              setWebStatus(null)
              setInflight(null)
              onAsked?.()
            } else if (event.type === 'error') {
              setError(event.error || '回答失败')
              setInflight(null)
            }
          }, controller.signal)
        } catch (failure) {
          setInflight(null)
          if (failure?.name !== 'AbortError') setError(String(failure?.message || failure))
          else setError('已停止回答')
        } finally {
          busyRef.current = false
          setBusy(false)
          setWebStatus(null)
          abortRef.current = null
        }
      }, [item.id, onAsked, webOn, model])

      const submit = useCallback(() => {
        const text = question.trim()
        if (!text || busy) return
        setQuestion('')
        send(text)
      }, [question, busy, send])

      const retry = useCallback(() => {
        const previous = lastAskedRef.current
        if (!previous || busy) return
        setError('')
        send(previous.question, { selection: previous.selection, page: previous.page })
      }, [busy, send])

      const copy = answer => {
        try {
          navigator.clipboard?.writeText(String(answer || ''))
          setCopiedAt(Date.now())
          setTimeout(() => setCopiedAt(0), 1500)
        } catch { /* clipboard blocked */ }
      }

      const startResize = event => {
        event.preventDefault()
        const startX = event.clientX
        const startWidth = width
        const move = moveEvent => {
          const next = Math.min(680, Math.max(320, startWidth + (startX - moveEvent.clientX)))
          setWidth(next)
        }
        const stop = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', stop)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', stop)
      }

      const quote = selection || ''
      const long = quote.length > 160
      const visible = showAll ? entries : entries.slice(-6)
      const hidden = entries.length - visible.length
      const elapsed = inflight ? Math.max(0, Math.round((clock - inflight.startedAt) / 1000)) : 0

      return h('div', { className: 'pr-ask', style: { width: `${width}px` } },
        h('div', { className: 'pr-ask-resizer', onPointerDown: startResize, title: '拖动调整宽度' }),
        h('div', { className: 'pr-ask-head' },
          h('span', { className: 'pr-ask-title' }, '论文问答'),
          h('button', {
            className: 'pr-icon-btn is-ghost',
            title: '关闭（Esc）',
            onClick: onClose,
            'aria-label': '关闭',
          }, '×'),
        ),
        quote
          ? h('div', { className: 'pr-ask-context' + (contextOpen ? ' is-open' : ''), key: quote.slice(0, 40) },
              h('div', { className: 'pr-ask-context-head' },
                h('span', null, page ? `已选段 · 第 ${page} 页` : '已选段'),
                long
                  ? h('button', {
                      className: 'pr-ask-link',
                      onClick: () => setContextOpen(value => !value),
                    }, contextOpen ? '收起' : '展开')
                  : null,
              ),
              h('div', { className: 'pr-ask-context-body' }, quote))
          : null,
        h('div', {
          className: 'pr-ask-thread',
          ref: threadRef,
          onScroll: onThreadScroll,
        },
          !entries.length && !pending
            ? h('div', { className: 'pr-ask-empty' },
                h('div', { className: 'pr-ask-empty-title' }, quote ? '就选中的内容提问' : '就这篇论文提问'),
                h('div', { className: 'pr-ask-chips' }, ASK_SUGGESTIONS.map((text, index) => h('button', {
                  key: index,
                  className: 'pr-suggest',
                  onClick: () => {
                    setQuestion(text)
                    inputRef.current?.focus()
                  },
                }, text))))
            : null,
          hidden > 0
            ? h('button', { className: 'pr-ask-more', onClick: () => setShowAll(true) }, `显示更早的 ${hidden} 条`)
            : null,
          visible.map((entry, index) => h(AskMessage, {
            key: `${entry.at || index}-${index}`,
            entry,
            onCopy: copy,
            copied: copiedAt && entry.answer && Date.now() - copiedAt < 1500,
          })),
          inflight
            ? h('div', { className: 'pr-msg is-live' },
                inflight.selection ? h('blockquote', { className: 'pr-msg-quote' }, inflight.selection) : null,
                h('div', { className: 'pr-msg-q' }, inflight.question),
                h('div', { className: 'pr-msg-a' },
                  h('div', { className: 'pr-web-status' + (webStatus?.status === 'failed' ? ' is-error' : '') },
                    webStatus?.status === 'searching'
                      ? '正在联网检索…'
                      : (webStatus?.status === 'failed'
                          ? '联网检索失败，继续依据论文内容回答…'
                          : (webStatus?.status === 'done'
                              ? `已联网 · ${webStatus.count} 条来源，正在生成回答…`
                              : (pending ? '正在生成回答…' : '已发送，等待模型响应…'))),
                    h('span', { className: 'pr-msg-elapsed' }, ` ${elapsed}s`)),
                  pending ? renderRichText(pending) : null,
                  h('div', { className: 'pr-typing' }, h('span', null), h('span', null), h('span', null))))
            : null,
        ),
        stuck
          ? h('button', {
              className: 'pr-ask-jump',
              onClick: () => {
                const node = threadRef.current
                if (node) node.scrollTop = node.scrollHeight
                stickRef.current = true
                setStuck(false)
              },
            }, '↓ 最新')
          : null,
        error
          ? h('div', { className: 'pr-ask-error' },
              h('span', null, error),
              h('button', {
                className: 'pr-msg-action',
                onClick: retry,
              }, '重试'))
          : null,
        h('div', { className: 'pr-ask-compose' },
          h('textarea', {
            ref: inputRef,
            className: 'pr-textarea',
            placeholder: quote ? '就选中的内容提问…' : '就这篇论文提问…',
            value: question,
            rows: 2,
            onChange: event => setQuestion(event.target.value),
            onKeyDown: event => {
              if (event.key !== 'Enter' || event.shiftKey) return
              // Never send while a Chinese IME is composing a candidate.
              if (event.nativeEvent?.isComposing || event.isComposing) return
              event.preventDefault()
              submit()
            },
          }),
          h('div', { className: 'pr-ask-actions' },
            h(ModelPicker, { catalog, value: model, onChange: onModelChange }),
            h('button', {
              className: 'pr-chip' + (webOn ? '' : ' is-off'),
              title: webOn ? '联网补充：开（点击关闭）' : '联网补充：关（点击开启）',
              onClick: () => setWebOn(value => !value),
            }, webOn ? '联网 开' : '联网 关'),
            h('div', { className: 'pr-ask-actions-spacer' }),
            busy
              ? h('button', { className: 'pr-btn', onClick: () => abortRef.current?.abort() }, '停止')
              : h('button', { className: 'pr-btn is-primary', disabled: !question.trim(), onClick: submit }, '发送'),
          ),
          h('div', { className: 'pr-ask-hint' }, 'Enter 发送 · Shift+Enter 换行'),
        ),
      )
    }

    function NotesPanel({ jobs, onHide, onDismiss, onAttach }) {
      const [clock, setClock] = useState(() => Date.now())
      const running = jobs.filter(job => job.running)
      useEffect(() => {
        if (!running.length) return undefined
        const timer = setInterval(() => setClock(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [running.length])
      if (!jobs.length) return null
      return h('div', { className: 'pr-notes-float' },
        h('div', { className: 'pr-notes-float-head' },
          h('span', { className: 'pr-notes-float-title' },
            running.length ? h('span', { className: 'pr-spin' }) : null,
            running.length ? `笔记生成中 ${running.length} 篇` : '笔记任务',
          ),
          h('button', {
            className: 'pr-icon-btn is-ghost',
            title: running.length ? '隐藏（生成继续）' : '隐藏',
            onClick: onHide,
          }, '×'),
        ),
        running.length ? h('div', { className: 'pr-notes-indeterminate' }, h('span', null)) : null,
        h('div', { className: 'pr-notes-list' }, jobs.map(job => {
          const elapsed = job.running && job.startedAt
            ? Math.max(0, Math.round((clock - job.startedAt) / 1000))
            : 0
          const failed = !job.running && Boolean(job.error)
          const done = !job.running && Boolean(job.result)
          const tokens = job.tokens?.total ? formatTokens(job.tokens.total) : ''
          const tokenHint = tokens
            ? `输入 ${formatTokens(job.tokens.input)} / 输出 ${formatTokens(job.tokens.output)} token`
            : ''
          return h('div', { key: job.itemId, className: 'pr-notes-row' + (job.running ? '' : ' is-idle') },
            h('span', { className: 'pr-notes-row-icon' + (failed ? ' is-error' : done ? ' is-done' : '') },
              job.running ? h('span', { className: 'pr-spin' }) : (failed ? '!' : '✓')),
            h('div', { className: 'pr-notes-row-main' },
              h('div', { className: 'pr-notes-row-title', title: job.title || '' }, job.title || `条目 ${job.itemId}`),
              h('div', { className: 'pr-notes-row-meta' },
                job.running
                  ? `${job.text || '生成中…'} · ${elapsed}s`
                  : (failed
                      ? `失败：${job.error}`
                      : `已完成${tokens ? ` · ${tokens} token` : ''}${job.result?.attached?.ok ? ' · 已写入 Zotero' : ' · 未写入 Zotero'}`)),
              done ? h('div', { className: 'pr-notes-row-path' }, job.result.pdfPath) : null,
              tokens ? h('div', { className: 'pr-notes-row-path', title: tokenHint }, tokenHint) : null,
              done && !job.result?.attached?.ok
                ? h('div', { className: 'pr-notes-row-actions' },
                    h('button', {
                      className: 'pr-btn pr-btn-sm',
                      onClick: () => onAttach?.(job),
                    }, '写入 Zotero'),
                    h('span', { className: 'pr-notes-row-meta' },
                      (job.result?.attached?.reason || '未写入').slice(0, 46)))
                : null,
              done && job.truncated
                ? h('div', { className: 'pr-notes-row-meta pr-notes-warn' }, '输出达到上限，笔记可能不完整')
                : null,
              done && job.inputTruncated
                ? h('div', { className: 'pr-notes-row-meta pr-notes-warn' },
                    `原文过长，仅前 ${(job.inputChars / 10000).toFixed(1)} 万字符参与生成（共 ${(job.inputTotalChars / 10000).toFixed(1)} 万）`)
                : null,
            ),
            !job.running
              ? h('button', {
                  className: 'pr-icon-btn is-ghost',
                  title: '从列表移除',
                  onClick: () => onDismiss(job.itemId),
                }, '×')
              : null,
          )
        })),
      )
    }

    /** Editable zoom percentage, shared by the paper and note viewers. */
    function ZoomInput({ scale, onChange, min = 0.5, max = 3 }) {
      const [text, setText] = useState(String(Math.round(scale * 100)))

      useEffect(() => {
        setText(String(Math.round(scale * 100)))
      }, [scale])

      const commit = () => {
        const value = Number(String(text).replace(/[^\d.]/g, ''))
        if (!Number.isFinite(value) || value <= 0) {
          setText(String(Math.round(scale * 100)))
          return
        }
        const next = Math.min(max, Math.max(min, value / 100))
        onChange(next)
        setText(String(Math.round(next * 100)))
      }

      return h('span', { className: 'pr-zoom-wrap' },
        h('input', {
          className: 'pr-zoom-input',
          value: text,
          inputMode: 'numeric',
          'aria-label': '缩放百分比',
          onChange: event => setText(event.target.value),
          onBlur: commit,
          onKeyDown: event => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            commit()
            event.currentTarget.blur()
          },
        }),
        h('span', { className: 'pr-zoom-suffix' }, '%'),
      )
    }

    /** Note PDF rendered with the same pdf.js pipeline as the paper reader. */
    function NotePane({ note, onClose }) {
      const [doc, setDoc] = useState(null)
      const [pages, setPages] = useState([])
      const [scale, setScale] = useState(note.scale || 1)
      const [visible, setVisible] = useState({})
      const [error, setError] = useState('')
      const containerRef = useRef(null)
      const selectNothing = useCallback(() => {}, [])

      useEffect(() => {
        let cancelled = false
        setDoc(null)
        setPages([])
        setError('')
        const url = note.attachmentId
          ? `${API}/pdf?attachment=${note.attachmentId}`
          : `${API}/note-pdf?p=${encodeURIComponent(note.filePath || '')}`
        loadPdfjs()
          .then(pdfjs => pdfjs.getDocument({
            url,
            cMapUrl: `${API}/vendor/pdfjs/cmaps/`,
            cMapPacked: true,
            standardFontDataUrl: `${API}/vendor/pdfjs/standard_fonts/`,
            wasmUrl: `${API}/vendor/pdfjs/wasm/`,
          }).promise)
          .then(async loaded => {
            if (cancelled) return
            setDoc(loaded)
            const sizes = []
            for (let num = 1; num <= loaded.numPages; num += 1) {
              const page = await loaded.getPage(num)
              if (cancelled) return
              const viewport = page.getViewport({ scale: 1 })
              sizes.push({ num, width: viewport.width, height: viewport.height, proxy: page })
              setPages(sizes.slice())
            }
          })
          .catch(failure => {
            if (!cancelled) setError(String(failure?.message || failure))
          })
        return () => { cancelled = true }
      }, [note.attachmentId, note.filePath])

      useEffect(() => {
        const root = containerRef.current
        if (!root) return undefined
        const observer = new IntersectionObserver(entries => {
          setVisible(previous => {
            const next = { ...previous }
            for (const entry of entries) next[entry.target.dataset.page] = entry.isIntersecting
            return next
          })
        }, { root, rootMargin: '400px 0px' })
        root.querySelectorAll('[data-page]').forEach(node => observer.observe(node))
        return () => observer.disconnect()
      }, [pages.length])

      return h('div', { className: 'pr-reader' },
        h('div', { className: 'pr-reader-bar' },
          h('span', { className: 'pr-reader-title', title: note.title }, note.title || '阅读笔记'),
          h('span', { className: 'pr-reader-pages' }, doc ? `${doc.numPages} 页` : ''),
          h('div', { className: 'pr-reader-tools' },
            h('div', { className: 'pr-group' },
              h('button', { className: 'pr-icon-btn', onClick: () => setScale(value => Math.max(0.5, +(value - 0.15).toFixed(2))), title: '缩小' }, '−'),
              h(ZoomInput, { scale, onChange: setScale, min: 0.5, max: 3.2 }),
              h('button', { className: 'pr-icon-btn', onClick: () => setScale(value => Math.min(3, +(value + 0.15).toFixed(2))), title: '放大' }, '+'),
            ),
            h('button', { className: 'pr-btn', onClick: onClose }, '关闭'),
          ),
        ),
        h(ErrorBox, { message: error }),
        !doc && !error ? h('div', { className: 'pr-empty' }, h(Spinner, { label: '正在打开笔记…' })) : null,
        h('div', { className: 'pr-reader-scroll', ref: containerRef },
          pages.map(page => h('div', {
            key: page.num,
            'data-page': page.num,
            className: 'pr-page-wrap',
            style: { width: Math.floor(page.width * scale), height: Math.floor(page.height * scale) },
          },
            h(PdfPage, {
              doc,
              num: page.num,
              scale,
              active: !!visible[page.num],
              blocks: undefined,
              translateOn: false,
              translations: {},
              onTextSelection: selectNothing,
            })))),
      )
    }

    function Reader({ item, attachment, engines, onClose, noteJob, noteAttachment, onStartNotes, onShowNotes, onOpenNote, model, catalog, onModelChange }) {
      const saved = viewState.reader && viewState.reader.attachmentId === attachment.id ? viewState.reader : null
      const defaultEngine = (engines || []).some(option => option.id === 'free')
        ? 'free'
        : (engines?.[0]?.id || 'llm')
      // Per-paper view settings survive a full page reload, not just a panel switch.
      const settingsKey = `dpr:reader:${attachment.id}`
      const stored = (() => {
        try {
          return JSON.parse(localStorage.getItem(settingsKey) || 'null')
        } catch {
          return null
        }
      })()
      const base = saved || stored
      const [doc, setDoc] = useState(saved && pdfCache.attachmentId === attachment.id ? pdfCache.doc : null)
      const [error, setError] = useState('')
      const [scale, setScale] = useState(base?.scale || 1.35)
      const [pageSizes, setPageSizes] = useState(saved && pdfCache.attachmentId === attachment.id ? (pdfCache.pages || []) : [])
      const [visible, setVisible] = useState({})
      const [translateOn, setTranslateOn] = useState(Boolean(base?.translateOn))
      const [engine, setEngine] = useState(base?.engine || defaultEngine)
      const [translations, setTranslations] = useState({})
      const [blocksTick, setBlocksTick] = useState(0)
      const [progress, setProgress] = useState({ busy: false, text: '' })
      const [ask, setAsk] = useState(null)
      const [clock, setClock] = useState(() => Date.now())
      const [confirmRegen, setConfirmRegen] = useState(false)
      const noteReady = Boolean(noteJob?.result || noteAttachment)
      const openNoteNow = useCallback(() => {
        const result = noteJob?.result
        if (result?.attached?.attachmentID) {
          onOpenNote?.({ attachmentId: result.attached.attachmentID, title: '阅读笔记', version: result.version })
          return
        }
        if (result?.pdfPath) {
          onOpenNote?.({ filePath: result.pdfPath, title: '阅读笔记', version: result.version })
          return
        }
        if (noteAttachment) onOpenNote?.(noteAttachment)
      }, [noteJob?.result, noteAttachment, onOpenNote])
      const containerRef = useRef(null)
      const blocksRef = useRef(new Map())
      const inflightRef = useRef(new Set())
      const translationsRef = useRef({})
      const translateRef = useRef({ on: false })
      const cancelTranslate = useRef(false)
      const scrollRestored = useRef(false)
      translateRef.current.on = translateOn

      useEffect(() => {
        if (!noteJob?.running) return undefined
        const timer = setInterval(() => setClock(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [noteJob?.running])
      const noteElapsed = noteJob?.startedAt
        ? Math.max(0, Math.round((clock - noteJob.startedAt) / 1000))
        : 0

      // Keep the reading position and view settings for the next mount.
      useEffect(() => {
        const previous = viewState.reader && viewState.reader.attachmentId === attachment.id
          ? viewState.reader.scrollTop
          : 0
        viewState.reader = { attachmentId: attachment.id, scale, translateOn, engine, scrollTop: previous }
        try {
          localStorage.setItem(settingsKey, JSON.stringify({ scale, translateOn, engine }))
        } catch { /* storage full or disabled */ }
      }, [attachment.id, scale, translateOn, engine, settingsKey])

      useEffect(() => {
        if (scrollRestored.current || !doc || !pageSizes.length) return undefined
        scrollRestored.current = true
        const node = containerRef.current
        if (node && saved?.scrollTop) node.scrollTop = saved.scrollTop
        return undefined
      }, [doc, pageSizes, saved])

      useEffect(() => {
        let cancelled = false
        setError('')
        const cachedDoc = pdfCache.attachmentId === attachment.id ? pdfCache.doc : null
        if (cachedDoc) {
          setDoc(cachedDoc)
          setPageSizes(pdfCache.pages || [])
          return () => { cancelled = true }
        }
        setDoc(null); setPageSizes([]); setVisible({}); setTranslations({}); blocksRef.current.clear()
        translationsRef.current = {}
        ;(async () => {
          const pdfjs = await loadPdfjs()
          const task = pdfjs.getDocument({
            url: `${API}/pdf?attachment=${attachment.id}`,
            cMapUrl: `${API}/vendor/pdfjs/cmaps/`,
            cMapPacked: true,
            standardFontDataUrl: `${API}/vendor/pdfjs/standard_fonts/`,
            wasmUrl: `${API}/vendor/pdfjs/wasm/`,
          })
          const document = await task.promise
          if (cancelled) return
          setDoc(document)
          const sizes = []
          for (let index = 1; index <= document.numPages; index += 1) {
            const page = await document.getPage(index)
            const viewport = page.getViewport({ scale: 1 })
            sizes.push({ num: index, width: viewport.width, height: viewport.height })
          }
          pdfCache.attachmentId = attachment.id
          pdfCache.doc = document
          pdfCache.pages = sizes
          if (!cancelled) setPageSizes(sizes)
        })().catch(failure => { if (!cancelled) setError(String(failure?.message || failure)) })
        return () => { cancelled = true }
      }, [attachment.id])

      // Reuse translations already stored for this PDF so re-reading costs nothing.
      useEffect(() => {
        let cancelled = false
        apiGet(`/translations?attachment=${attachment.id}&v=${BLOCK_VERSION}`)
          .then(body => {
            if (cancelled) return
            const cached = Number(body.version) === BLOCK_VERSION ? (body.map || {}) : {}
            translationsRef.current = { ...cached, ...translationsRef.current }
            setTranslations(translationsRef.current)
          })
          .catch(() => {})
        return () => { cancelled = true }
      }, [attachment.id])

      const loadBlocks = useCallback(async num => {
        const cached = blocksRef.current.get(num)
        if (cached) return cached
        const pdfjs = await loadPdfjs()
        const page = await doc.getPage(num)
        const viewport = page.getViewport({ scale: 1 })
        const content = await page.getTextContent()
        const boxes = []
        for (const textItem of content.items) {
          if (!textItem.str || !textItem.str.trim()) continue
          const transform = pdfjs.Util.transform(viewport.transform, textItem.transform)
          const fontHeight = Math.hypot(transform[2], transform[3]) || textItem.height
          if (!(fontHeight > 0)) continue
          boxes.push({
            x: transform[4],
            y: transform[5] - fontHeight,
            width: Math.max(1, textItem.width),
            height: fontHeight,
            text: textItem.str,
          })
        }
        const blocks = buildBlocks(boxes)
        blocksRef.current.set(num, blocks)
        setBlocksTick(tick => tick + 1)
        return blocks
      }, [doc])

      const translateKeys = useCallback(async (blocks, label) => {
        const known = translationsRef.current
        const unique = []
        const seen = new Set()
        for (const block of blocks) {
          if (!block.translate || !block.key) continue
          if (known[block.key] || seen.has(block.key) || inflightRef.current.has(block.key)) continue
          seen.add(block.key)
          inflightRef.current.add(block.key)
          unique.push({ id: block.key, text: block.text })
        }
        if (!unique.length) return
        setProgress({ busy: true, text: label })
        try {
          for (let index = 0; index < unique.length; index += 12) {
            if (cancelTranslate.current) break
            const batch = unique.slice(index, index + 12)
            const response = await apiPost('/translate', { blocks: batch, engine, attachment: attachment.id, v: BLOCK_VERSION })
            const patch = {}
            for (const result of response.results || []) patch[result.id] = result.text
            translationsRef.current = { ...translationsRef.current, ...patch }
            setTranslations(translationsRef.current)
          }
        } catch (failure) {
          setError(`翻译失败：${String(failure?.message || failure)}`)
        } finally {
          for (const entry of unique) inflightRef.current.delete(entry.id)
          setProgress({ busy: false, text: '' })
        }
      }, [engine, attachment.id])

      // Lazy per-page translation: a page translates once it is on screen.
      useEffect(() => {
        if (!translateOn || !doc) return undefined
        const pages = Object.keys(visible).filter(key => visible[key])
        if (!pages.length) return undefined
        let cancelled = false
        ;(async () => {
          for (const num of pages) {
            const blocks = await loadBlocks(Number(num))
            if (cancelled || !translateRef.current.on) return
            await translateKeys(blocks, `正在翻译第 ${num} 页…`)
          }
        })()
        return () => { cancelled = true }
      }, [translateOn, doc, visible, loadBlocks, translateKeys])

      const translateAll = useCallback(async () => {
        if (!doc) return
        cancelTranslate.current = false
        setTranslateOn(true)
        const total = doc.numPages
        for (let num = 1; num <= total; num += 1) {
          if (cancelTranslate.current) break
          const blocks = await loadBlocks(num)
          if (cancelTranslate.current) break
          setProgress({ busy: true, text: `正在翻译第 ${num}/${total} 页…` })
          await translateKeys(blocks, `正在翻译第 ${num}/${total} 页…`)
        }
        if (cancelTranslate.current) setProgress({ busy: false, text: '已停止翻译' })
        else setProgress({ busy: false, text: '' })
      }, [doc, loadBlocks, translateKeys])

      useEffect(() => {
        const root = containerRef.current
        if (!root || !doc) return undefined
        const observer = new IntersectionObserver(entries => {
          const update = {}
          for (const entry of entries) {
            const num = entry.target.dataset.page
            update[num] = entry.isIntersecting
          }
          setVisible(previous => ({ ...previous, ...update }))
        }, { root, rootMargin: '800px 0px' })
        const nodes = root.querySelectorAll('[data-page]')
        nodes.forEach(node => observer.observe(node))
        return () => observer.disconnect()
      }, [doc, pageSizes])

      const onTextSelection = useCallback((event, num) => {
        const selection = window.getSelection()
        if (!selection || selection.isCollapsed) return
        const text = selection.toString().trim()
        if (!text) return
        const range = selection.getRangeAt(0)
        const rect = range.getBoundingClientRect()
        const next = { text: text.slice(0, 4000), page: num, x: Math.min(window.innerWidth - 160, rect.left), y: Math.min(window.innerHeight - 60, rect.bottom + 6) }
        // With the drawer open, a new selection swaps the context card and keeps
        // the conversation going instead of closing the panel.
        setAsk(previous => (previous?.fixed ? { ...previous, ...next, fixed: true } : next))
      }, [])

      const startNotes = useCallback(async () => {
        onShowNotes?.()
        await onStartNotes?.(model)
      }, [onShowNotes, onStartNotes, model])

      useEffect(() => {
        const onKey = event => { if (event.key === 'Escape') setAsk(null) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [])

      return h('div', { className: 'pr-reader' },
        h('div', { className: 'pr-reader-bar' },
          h('button', { className: 'pr-btn', onClick: onClose }, '← 返回'),
          h('span', { className: 'pr-reader-title', title: item.title }, item.title),
          h('span', { className: 'pr-reader-pages' }, doc ? `${doc.numPages} 页` : ''),
          h('div', { className: 'pr-reader-tools' },
            h('div', { className: 'pr-group' },
              h('button', { className: 'pr-icon-btn', onClick: () => setScale(value => Math.max(0.6, +(value - 0.15).toFixed(2))), title: '缩小' }, '−'),
              h(ZoomInput, { scale, onChange: setScale, min: 0.5, max: 3.2 }),
              h('button', { className: 'pr-icon-btn', onClick: () => setScale(value => Math.min(3.2, +(value + 0.15).toFixed(2))), title: '放大' }, '+'),
            ),
            h('label', { className: 'pr-switch' },
              h('input', {
                type: 'checkbox',
                checked: translateOn,
                onChange: event => setTranslateOn(event.target.checked),
              }),
              h('span', null, '中文替换'),
            ),
            h('select', {
              className: 'pr-select',
              value: engine,
              onChange: event => setEngine(event.target.value),
              title: '翻译通道',
            }, (engines?.length ? engines : [{ id: 'llm', label: 'DSH 模型' }]).map(option =>
              h('option', { key: option.id, value: option.id }, option.label))),
            h('button', { className: 'pr-btn', disabled: progress.busy || !doc, onClick: translateAll }, '翻译全文'),
            h('button', {
              className: 'pr-btn' + (ask?.fixed ? ' is-running' : ''),
              title: '打开论文问答面板',
              onClick: () => setAsk(previous => (previous?.fixed
                ? previous
                : { text: previous?.text || '', page: previous?.page ?? null, fixed: true })),
            }, '问答'),
            h(ModelPicker, { catalog, value: model, onChange: onModelChange }),
            noteReady
              ? h('button', { className: 'pr-btn', onClick: openNoteNow, title: '打开阅读笔记' }, '查看笔记')
              : null,
            h('button', {
              className: 'pr-btn' + (noteJob?.running ? ' is-running' : ''),
              onClick: () => {
                if (noteJob?.running) {
                  onShowNotes?.()
                  return
                }
                if (noteJob?.error && !noteReady) {
                  onShowNotes?.()
                  return
                }
                if (noteReady) {
                  // Regenerating adds a version instead of overwriting, but say so first.
                  setConfirmRegen(true)
                  return
                }
                startNotes()
              },
            },
              noteJob?.running ? h('span', { className: 'pr-spin' }) : null,
              noteJob?.running
                ? `笔记生成中 ${noteElapsed}s`
                : (noteReady ? '重新生成' : '生成笔记'),
            ),
          ),
        ),
        confirmRegen ? h('div', { className: 'pr-confirm' },
          h('span', null, `这篇论文已有阅读笔记${noteAttachment?.title ? `（${noteAttachment.title}）` : ''}。重新生成会新增一版，旧版不会被覆盖。`),
          h('button', { className: 'pr-btn', onClick: () => { setConfirmRegen(false); startNotes() } }, '继续生成'),
          h('button', { className: 'pr-btn', onClick: () => setConfirmRegen(false) }, '取消'),
        ) : null,
        progress.text ? h('div', { className: 'pr-progress' },
          progress.busy ? h('span', { className: 'pr-spin' }) : null,
          h('span', null, progress.text),
          progress.busy ? h('button', {
            className: 'pr-btn',
            style: { marginLeft: 'auto', padding: '2px 10px', fontSize: '11px' },
            onClick: () => {
              cancelTranslate.current = true
              setProgress({ busy: false, text: '正在停止…' })
            },
          }, '停止') : null,
        ) : null,
        h(ErrorBox, { message: error }),
        h('div', { className: 'pr-reader-body' },
          h('div', { className: 'pr-reader-canvas' },
            h('div', {
              className: 'pr-reader-scroll',
              ref: containerRef,
              onScroll: event => {
                if (viewState.reader?.attachmentId === attachment.id) {
                  viewState.reader.scrollTop = event.currentTarget.scrollTop
                }
              },
            },
              !doc && !error ? h(Spinner, { label: '正在打开 PDF…' }) : null,
              pageSizes.map(page => h('div', {
                key: page.num,
                'data-page': page.num,
                className: 'pr-page-wrap',
                style: { width: Math.floor(page.width * scale), height: Math.floor(page.height * scale) },
              }, h(PdfPage, {
                doc,
                num: page.num,
                scale,
                active: !!visible[page.num],
                blocks: blocksRef.current.get(page.num),
                translateOn,
                translations,
                onTextSelection,
              }))),
            ),
            ask && !ask.fixed ? h('button', {
              className: 'pr-ask-fab',
              style: { left: ask.x, top: ask.y },
              onMouseDown: event => event.preventDefault(),
              onClick: () => setAsk({ ...ask, fixed: true }),
            }, '问 DSH') : null,
          ),
          ask?.fixed ? h(AskDrawer, {
            item,
            selection: ask.text,
            page: ask.page,
            onClose: () => setAsk(null),
            onAsked: () => {},
            model,
            catalog,
            onModelChange,
          }) : null,
        ),
      )
    }

    // ------------------------------------------------------------------- app

    /** Column visibility: memory first, then the last choice stored on disk. */
    function readToggle(key, memoryValue) {
      if (typeof memoryValue === 'boolean') return memoryValue
      try {
        const stored = localStorage.getItem(key)
        return stored === null ? true : stored === '1'
      } catch {
        return true
      }
    }

    function writeToggle(key, value) {
      try {
        localStorage.setItem(key, value ? '1' : '0')
      } catch { /* storage disabled */ }
    }

    /**
     * Panel state that must survive leaving the module (the slot unmounts the
     * occupant when another main panel is selected) and coming back.
     */
    const viewState = {
      selected: null,
      query: '',
      activeItem: null,
      detail: null,
      qaCount: 0,
      reading: null,
      listScroll: 0,
      reader: null,
      treeCollapsed: {},
      treeOpen: true,
      listOpen: true,
      boot: null,
      items: null,
      total: 0,
    }

    /** Parsed PDF kept across remounts so returning to a paper is instant. */
    const pdfCache = { attachmentId: null, doc: null, pages: null }

    function PaperApp() {
      const [state, setState] = useState(viewState.boot?.state || { loading: true, error: '' })
      const [collections, setCollections] = useState(viewState.boot?.collections || [])
      const [selected, setSelected] = useState(viewState.selected)
      const [items, setItems] = useState(viewState.items || [])
      const [total, setTotal] = useState(viewState.total || 0)
      const [query, setQuery] = useState(viewState.query)
      const [activeItem, setActiveItem] = useState(viewState.activeItem)
      const [detail, setDetail] = useState(viewState.detail)
      const [detailLoading, setDetailLoading] = useState(false)
      const [qaCount, setQaCount] = useState(viewState.qaCount)
      const [reading, setReading] = useState(viewState.reading)
      const [noteView, setNoteView] = useState(viewState.noteView || null)
      const [paperCollapsed, setPaperCollapsed] = useState(false)
      const [noteCollapsed, setNoteCollapsed] = useState(false)
      const notes = useNotesJobs()
      const [catalog, setCatalog] = useState(null)
      const [askModel, setAskModel] = useState(() => {
        try {
          return JSON.parse(localStorage.getItem('dpr:model') || 'null')
        } catch {
          return null
        }
      })
      const [notesPanelHidden, setNotesPanelHidden] = useState(false)
      const [dismissedJobs, setDismissedJobs] = useState(() => viewState.dismissedJobs || [])
      const [attachFixes, setAttachFixes] = useState({})
      const noteJobs = notes.jobs
        .filter(job => !dismissedJobs.includes(job.itemId))
        .map(job => {
          const fix = attachFixes[job.itemId]
          if (!fix || !job.result) return job
          return {
            ...job,
            result: {
              ...job.result,
              attached: fix.ok ? { ok: true, attachmentKey: fix.key } : { ok: false, reason: fix.error },
            },
          }
        })
      const noteJobFor = useCallback(
        itemId => noteJobs.find(job => job.itemId === itemId) || null,
        [noteJobs],
      )
      const [treeOpen, setTreeOpen] = useState(() => readToggle('dpr:tree', viewState.treeOpen))
      const [listOpen, setListOpen] = useState(() => readToggle('dpr:list', viewState.listOpen))
      const searchTimer = useRef(null)
      const queryRef = useRef(viewState.query)
      const listRef = useRef(null)
      const scrollRestored = useRef(false)
      const columnsBeforeNote = useRef(null)

      useEffect(() => { viewState.selected = selected }, [selected])
      useEffect(() => { viewState.query = query }, [query])
      useEffect(() => { viewState.activeItem = activeItem }, [activeItem])
      useEffect(() => { viewState.detail = detail }, [detail])
      useEffect(() => { viewState.qaCount = qaCount }, [qaCount])
      useEffect(() => { viewState.reading = reading }, [reading])
      useEffect(() => { viewState.noteView = noteView }, [noteView])
      useEffect(() => {
        viewState.treeOpen = treeOpen
        writeToggle('dpr:tree', treeOpen)
      }, [treeOpen])
      useEffect(() => {
        viewState.listOpen = listOpen
        writeToggle('dpr:list', listOpen)
      }, [listOpen])

      useEffect(() => {
        let cancelled = false
        apiGet('/models')
          .then(body => { if (!cancelled) setCatalog(body) })
          .catch(() => {})
        return () => { cancelled = true }
      }, [])

      useEffect(() => {
        try {
          if (askModel) localStorage.setItem('dpr:model', JSON.stringify(askModel))
        } catch { /* storage disabled */ }
      }, [askModel])

      useEffect(() => {
        if (scrollRestored.current || state.loading || !items.length) return undefined
        scrollRestored.current = true
        const node = listRef.current
        if (node && viewState.listScroll) node.scrollTop = viewState.listScroll
        return undefined
      }, [items.length, state.loading])

      useEffect(() => {
        let cancelled = false
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
        ;(async () => {
          let lastError
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              const body = await apiGet('/state')
              if (cancelled) return
              if (body.zotero?.error) throw new Error(body.zotero.error)
              const collectionsBody = await apiGet('/collections')
              if (cancelled) return
              const nextCollections = collectionsBody.collections || []
              const nextState = { loading: false, error: '', engines: body.engines || [], zotero: body.zotero, stats: body.stats }
              viewState.boot = { state: nextState, collections: nextCollections }
              setCollections(nextCollections)
              setState(nextState)
              return
            } catch (failure) {
              lastError = failure
              // Zotero may be mid-write on the database; the Host falls back to a
              // copy after a moment, so a couple of retries are worth it.
              await wait(1200)
            }
          }
          if (!cancelled) {
            setState({ loading: false, error: String(lastError?.message || lastError), engines: [] })
          }
        })()
        return () => { cancelled = true }
      }, [])

      const loadItems = useCallback((collection, needle) => {
        const params = new URLSearchParams({ limit: '200' })
        if (collection) params.set('collection', String(collection))
        if (needle) params.set('q', needle)
        apiGet(`/items?${params.toString()}`)
          .then(body => {
            const nextItems = body.items || []
            viewState.items = nextItems
            viewState.total = body.total || 0
            setItems(nextItems)
            setTotal(body.total || 0)
          })
          .catch(failure => setState(previous => ({ ...previous, error: String(failure?.message || failure) })))
      }, [])

      useEffect(() => { if (!state.loading) loadItems(selected, queryRef.current) }, [state.loading, selected, loadItems])

      const openItem = useCallback(item => {
        // A note belongs to the paper it came from: switching papers closes it
        // and restores the columns so the new paper's detail is visible.
        if (noteView) {
          const previous = columnsBeforeNote.current
          setNoteView(null)
          setPaperCollapsed(false)
          setNoteCollapsed(false)
          if (previous) {
            setTreeOpen(previous.treeOpen)
            setListOpen(previous.listOpen)
          }
        }
        setActiveItem(item)
        setReading(null)
        // Drop the previous paper's detail immediately: its "open PDF" button must
        // not stay clickable against the newly selected row.
        setDetail(null)
        setDetailLoading(true)
        setQaCount(0)
        apiGet(`/item?id=${item.id}`)
          .then(body => {
            // Ignore a slow reply for a row the user already left.
            setDetail(previous => (viewState.activeItem?.id === body.item.id ? body.item : previous))
            setQaCount((body.qa || []).length)
          })
          .catch(failure => setState(previous => ({ ...previous, error: String(failure?.message || failure) })))
          .finally(() => setDetailLoading(false))
      }, [noteView])

      const startReading = useCallback((item, attachment) => {
        setReading({ item, attachment })
      }, [])

      /** Note attachments of a paper, newest version first. */
      const notesOf = useCallback(item => (item?.attachments || [])
        .filter(attachment => attachment.isPdf && /阅读笔记/.test(attachment.title || ''))
        .map(attachment => {
          const match = /\(v(\d+)\)/.exec(attachment.title || '')
          return { ...attachment, version: match ? Number(match[1]) : 1 }
        })
        .sort((first, second) => (second.version - first.version) || (second.id - first.id)), [])

      const openNote = useCallback(note => {
        if (!note) return
        columnsBeforeNote.current = { treeOpen, listOpen }
        // Match the paper's current zoom so both panes read at the same size.
        const paperScale = viewState.reader && reading && viewState.reader.attachmentId === reading.attachment?.id
          ? viewState.reader.scale
          : 0
        setNoteView({
          attachmentId: note.attachmentId ?? note.id ?? null,
          filePath: note.filePath || '',
          title: note.title || '阅读笔记',
          version: note.version || 0,
          scale: note.scale || paperScale || 1,
        })
        // Reading a note is a focused task: give it the whole window.
        setTreeOpen(false)
        setListOpen(false)
        setPaperCollapsed(false)
        setNoteCollapsed(false)
      }, [treeOpen, listOpen, reading])

      const closeNote = useCallback(() => {
        const previous = columnsBeforeNote.current
        setNoteView(null)
        setPaperCollapsed(false)
        setNoteCollapsed(false)
        if (previous) {
          setTreeOpen(previous.treeOpen)
          setListOpen(previous.listOpen)
        }
      }, [])

      const startNotesFor = useCallback(async (itemId, model) => {
        if (!itemId) return
        try {
          await startNoteJob(itemId, model)
        } catch (error) {
          setState(previous => ({ ...previous, error: String(error?.message || error) }))
        }
        setNotesPanelHidden(false)
        notes.refresh()
      }, [notes.refresh])

      const dismissJob = useCallback(itemId => {
        setDismissedJobs(previous => {
          const next = Array.from(new Set([...previous, itemId]))
          viewState.dismissedJobs = next
          return next
        })
      }, [])

      /** Attach an already generated note after Zotero was closed at that time. */
      const retryAttach = useCallback(async job => {
        const result = job?.result
        if (!result?.pdfPath) return
        const base = job.title || ''
        const suffix = result.version > 1 ? ` (v${result.version})` : ''
        try {
          const body = await apiPost('/attach', {
            itemId: job.itemId,
            pdfPath: result.pdfPath,
            title: `${base} - 阅读笔记${suffix}`,
          })
          setAttachFixes(previous => ({
            ...previous,
            [job.itemId]: body.ok
              ? { ok: true, key: body.attachmentKey || '' }
              : { ok: false, error: body.reason || '未写入 Zotero' },
          }))
        } catch (error) {
          setAttachFixes(previous => ({
            ...previous,
            [job.itemId]: { ok: false, error: String(error?.message || error) },
          }))
        }
      }, [])

      if (state.loading) {
        return h('div', { className: 'pr-root is-loading' }, h(Spinner, { label: '正在连接 Zotero 资料库…' }))
      }

      const selectedName = selected
        ? (collections.find(collection => collection.id === selected)?.name || '集合')
        : '全部文献'

      const treeToggle = h('button', {
        className: 'pr-icon-btn is-ghost',
        title: treeOpen ? '收起目录树' : '展开目录树',
        'aria-label': treeOpen ? '收起目录树' : '展开目录树',
        onClick: () => setTreeOpen(value => !value),
      }, h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true },
        h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { d: 'M6 2.5v11', stroke: 'currentColor', strokeWidth: 1.4 }),
        treeOpen ? h('path', { d: 'M8.6 6.2 6.6 8l2 1.8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }) : null,
      ))

      const listToggle = h('button', {
        className: 'pr-icon-btn is-ghost',
        title: listOpen ? '收起文献列表' : '展开文献列表',
        'aria-label': listOpen ? '收起文献列表' : '展开文献列表',
        onClick: () => setListOpen(value => !value),
      }, h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true },
        h('path', { d: 'M2.5 4h11M2.5 8h11M2.5 12h7', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      ))

      return h('div', { className: 'pr-root' },
        treeOpen ? h('div', { className: 'pr-side' },
          h(Tree, { collections, selected, onSelect: setSelected, counts: state.stats }),
          h('div', { className: 'pr-status' },
            h('span', { className: 'pr-status-dot' + (state.zotero?.running ? ' is-on' : '') }),
            h('span', null, state.zotero?.running ? 'Zotero 运行中' : 'Zotero 未运行'),
            h('span', { className: 'pr-status-sep' }, '·'),
            h('span', { className: 'pr-status-dot' + (state.zotero?.bridge ? ' is-on' : '') }),
            h('span', null, state.zotero?.bridge ? '桥接已装' : '桥接未装'),
          ),
        ) : null,
        !listOpen ? h('div', { className: 'pr-rail' }, treeToggle, listToggle) : null,
        listOpen ? h('div', { className: 'pr-list' },
          h('div', { className: 'pr-list-head' },
            h('div', { className: 'pr-list-title' },
              h('div', { className: 'pr-list-title-main' },
                treeToggle,
                h('strong', { title: selectedName }, selectedName),
              ),
              h('div', { className: 'pr-list-title-actions' },
                h('span', { className: 'pr-list-count' }, `${total} 篇`),
                listToggle,
              ),
            ),
            h('div', { className: 'pr-search-wrap' },
              h('svg', { className: 'pr-search-icon', viewBox: '0 0 16 16', 'aria-hidden': true },
                h('circle', { cx: 7, cy: 7, r: 4.6, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
                h('path', { d: 'M10.4 10.4 14 14', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
              ),
              h('input', {
                className: 'pr-search',
                placeholder: '搜索标题、期刊…',
                value: query,
                onChange: event => {
                  const value = event.target.value
                  setQuery(value)
                  queryRef.current = value
                  if (searchTimer.current) clearTimeout(searchTimer.current)
                  searchTimer.current = setTimeout(() => loadItems(selected, value), 260)
                },
              }),
            ),
          ),
          h(ErrorBox, { message: state.error }),
          h('div', {
            className: 'pr-list-body',
            ref: listRef,
            onScroll: event => { viewState.listScroll = event.currentTarget.scrollTop },
          },
            items.map(item => h(ItemRow, {
              key: item.id,
              item,
              active: activeItem?.id === item.id,
              onOpen: openItem,
            })),
            !items.length ? h('div', { className: 'pr-muted pr-empty-list' }, '这个集合里没有条目') : null,
          ),
        ) : null,
        h('div', { className: 'pr-main' },
          noteView
            ? h('div', { className: 'pr-split-wrap' },
                h('div', { className: 'pr-split-bar' },
                  reading
                    ? h('button', {
                        className: 'pr-chip' + (paperCollapsed ? ' is-off' : ''),
                        title: paperCollapsed ? '显示论文' : '收起论文',
                        onClick: () => setPaperCollapsed(value => !value),
                      }, '论文')
                    : null,
                  h('button', {
                    className: 'pr-chip' + (noteCollapsed ? ' is-off' : ''),
                    title: noteCollapsed ? '显示笔记' : '收起笔记',
                    onClick: () => setNoteCollapsed(value => !value),
                  }, '阅读笔记'),
                  h('span', { className: 'pr-split-title', title: noteView.title }, noteView.title || ''),
                  h('button', {
                    className: 'pr-chip',
                    title: '关闭笔记',
                    onClick: closeNote,
                  }, '关闭'),
                ),
                h('div', { className: 'pr-split' },
                  reading && !paperCollapsed
                    ? h('div', { className: 'pr-pane' }, h(Reader, {
                        key: reading.attachment?.id ? `attachment-${reading.attachment.id}` : `item-${reading.item?.id}`,
                        item: reading.item,
                        attachment: reading.attachment,
                        engines: state.engines,
                        onClose: () => setReading(null),
                        noteJob: noteJobFor(reading.item?.id),
                        noteAttachment: notesOf(detail)[0] || null,
                        onStartNotes: model => startNotesFor(reading.item?.id, model),
                        onShowNotes: () => setNotesPanelHidden(false),
                        onOpenNote: openNote,
                        model: askModel,
                        catalog,
                        onModelChange: setAskModel,
                      }))
                    : null,
                  !noteCollapsed
                    ? h('div', { className: 'pr-pane' }, h(NotePane, { note: noteView, onClose: closeNote }))
                    : null,
                ),
              )
            : (reading
              ? h(Reader, {
                  key: reading.attachment?.id ? `attachment-${reading.attachment.id}` : `item-${reading.item?.id}`,
                  item: reading.item,
                  attachment: reading.attachment,
                  engines: state.engines,
                  onClose: () => setReading(null),
                  noteJob: noteJobFor(reading.item?.id),
                  noteAttachment: notesOf(detail)[0] || null,
                  onStartNotes: model => startNotesFor(reading.item?.id, model),
                  onShowNotes: () => setNotesPanelHidden(false),
                  onOpenNote: openNote,
                  model: askModel,
                  catalog,
                  onModelChange: setAskModel,
                })
              : (detailLoading && !detail
                ? h('div', { className: 'pr-empty' }, h(Spinner, { label: '正在读取论文信息…' }))
                : h(Detail, {
                    item: detail,
                    onRead: startReading,
                    onNotes: item => startNotesFor(item?.id, askModel),
                    noteJob: noteJobFor(detail?.id),
                    notes: notesOf(detail),
                    onOpenNote: openNote,
                    qaCount,
                    model: askModel,
                    catalog,
                    onModelChange: setAskModel,
                  }))),
          noteJobs.length && !notesPanelHidden
            ? h(NotesPanel, {
                jobs: noteJobs,
                onHide: () => setNotesPanelHidden(true),
                onDismiss: dismissJob,
                onAttach: retryAttach,
              })
            : null,
        ),
      )
    }

    // ------------------------------------------------------------------- css

    const CSS = `
.pr-root{display:flex;height:100%;min-height:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.pr-root.is-loading{align-items:center;justify-content:center;background:transparent}
.pr-side{width:236px;flex:none;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 46%,transparent)}
.pr-tree{flex:1;min-height:0;overflow:auto;padding:10px 8px 6px}
.pr-tree-head{display:flex;align-items:center;justify-content:space-between;padding:2px 8px 8px;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.pr-tree-head-count{font-variant-numeric:tabular-nums;letter-spacing:0}
.pr-tree-row{position:relative;display:flex;align-items:center;gap:6px;min-height:28px;padding:4px 8px;border-radius:7px;cursor:pointer;color:var(--dsw-alias-label-primary);transition:background .12s ease,color .12s ease}
.pr-tree-row:hover{background:var(--dsw-alias-bg-layer-2)}
.pr-tree-row.is-active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent);font-weight:600}
.pr-tree-row.is-active:before{content:"";position:absolute;left:0;top:6px;bottom:6px;width:2px;border-radius:2px;background:var(--dsw-alias-brand-primary)}
.pr-tree-row.is-active .pr-tree-name{color:color-mix(in srgb,var(--dsw-alias-brand-primary) 78%,var(--dsw-alias-label-primary))}
.pr-caret{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:transform .14s ease,color .12s ease;border-radius:4px}
.pr-caret:hover{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,transparent)}
.pr-caret.is-open{transform:rotate(90deg)}
.pr-caret-space{width:16px;flex:none}
.pr-tree-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pr-tree-count{flex:none;min-width:20px;text-align:center;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,transparent);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:16px;font-variant-numeric:tabular-nums}
.pr-status{display:flex;align-items:center;gap:5px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:10.5px;color:var(--dsw-alias-label-secondary);flex:none;flex-wrap:wrap}
.pr-status-sep{opacity:.45}
.pr-status-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none;box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-idle-primary) 18%,transparent)}
.pr-status-dot.is-on{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent)}
.pr-list{width:326px;flex:none;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 38%,transparent)}
.pr-list-head{display:flex;flex-direction:column;gap:9px;padding:12px 12px 11px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.pr-list-title{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.pr-list-title strong{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pr-list-title-main{display:flex;align-items:center;gap:6px;min-width:0}
.pr-list-title-actions{display:flex;align-items:center;gap:2px;flex:none}
.pr-rail{width:34px;flex:none;display:flex;flex-direction:column;align-items:center;gap:8px;padding:10px 0;border-right:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 46%,transparent)}
.pr-icon-btn.is-ghost{border-color:transparent;background:transparent;width:24px;height:24px;padding:0;color:var(--dsw-alias-label-secondary)}
.pr-icon-btn.is-ghost:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pr-search-wrap{position:relative;display:flex;align-items:center}
.pr-search-icon{position:absolute;left:9px;width:13px;height:13px;color:var(--dsw-alias-label-secondary);opacity:.7;pointer-events:none}
.pr-search{width:100%;box-sizing:border-box;padding:7px 10px 7px 28px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 72%,transparent);color:var(--dsw-alias-label-primary);font-size:12.5px;font-family:inherit;outline:none;transition:border-color .12s ease,box-shadow .12s ease}
.pr-search::placeholder{color:color-mix(in srgb,var(--dsw-alias-label-secondary) 72%,transparent)}
.pr-search:focus{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}
.pr-list-count{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.pr-list-body{flex:1;overflow:auto;min-height:0;padding:6px 0}
.pr-item{margin:4px 8px;padding:9px 11px;border-radius:9px;border:1px solid transparent;cursor:pointer;transition:background .12s ease,border-color .12s ease}
.pr-item:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 80%,transparent);border-color:var(--dsw-alias-border-l1)}
.pr-item.is-active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 11%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,transparent)}
.pr-item-title{font-size:12.5px;font-weight:500;line-height:1.5;margin-bottom:4px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.pr-item.is-active .pr-item-title{font-weight:600}
.pr-item-meta{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary);font-size:11px;overflow:hidden}
.pr-item-year{font-variant-numeric:tabular-nums;font-weight:600;color:color-mix(in srgb,var(--dsw-alias-brand-primary) 72%,var(--dsw-alias-label-secondary))}
.pr-item-venue{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pr-item-badges{display:flex;align-items:center;gap:5px;margin-top:6px}
.pr-badge{font-size:10px;line-height:15px;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 11%,transparent);color:var(--dsw-alias-label-secondary)}
.pr-badge.is-pdf{color:color-mix(in srgb,var(--dsw-alias-brand-primary) 85%,var(--dsw-alias-label-primary));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 13%,transparent)}
.pr-badge.is-notes{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
.pr-badge.is-muted{opacity:.55}
.pr-main{position:relative;flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 44%,transparent)}
.pr-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:10px;color:var(--dsw-alias-label-secondary);padding:24px;text-align:center}
.pr-empty-icon{width:44px;height:44px;color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent)}
.pr-empty-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.pr-empty-body{font-size:12px;max-width:320px;line-height:1.7}
.pr-detail{height:100%;overflow:auto;padding:22px 26px 28px;display:flex;flex-direction:column;gap:16px}
.pr-detail-head{display:flex;flex-direction:column;gap:8px}
.pr-detail-title{margin:0;font-size:19px;line-height:1.45;font-weight:650;letter-spacing:.005em}
.pr-detail-sub{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.pr-detail-chips{display:flex;flex-wrap:wrap;gap:6px}
.pr-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:18px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 60%,transparent);color:var(--dsw-alias-label-secondary)}
.pr-chip.is-brand{color:color-mix(in srgb,var(--dsw-alias-brand-primary) 85%,var(--dsw-alias-label-primary));border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.pr-detail-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px}
.pr-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:6px 13px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 72%,transparent);color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit;cursor:pointer;transition:background .12s ease,border-color .12s ease,opacity .12s ease;white-space:nowrap}
.pr-btn:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.pr-btn:disabled{opacity:.42;cursor:not-allowed}
.pr-btn.is-primary{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,var(--dsw-alias-bg-layer-2));border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px color-mix(in srgb,#0c1730 18%,transparent)}
.pr-btn.is-primary:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 27%,var(--dsw-alias-bg-layer-2));border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 58%,var(--dsw-alias-border-l2))}
.pr-detail-grid{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:16px;align-items:start}
.pr-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px 16px;background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 58%,transparent);display:flex;flex-direction:column;gap:10px}
.pr-card-title{display:flex;align-items:center;gap:6px;margin:0;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);font-weight:600}
.pr-abstract{margin:0;white-space:pre-wrap;font-size:12.5px;line-height:1.78}
.pr-table{width:100%;border-collapse:collapse;font-size:12px}
.pr-table tr+tr{border-top:1px dashed var(--dsw-alias-border-l1)}
.pr-table th{text-align:left;color:var(--dsw-alias-label-secondary);font-weight:500;width:74px;padding:6px 0;vertical-align:top;font-size:11.5px}
.pr-table td{padding:6px 0;word-break:break-word;line-height:1.6}
.pr-attachments{list-style:none;padding:0;margin:0;font-size:12px;display:flex;flex-direction:column;gap:6px}
.pr-attachments li{display:flex;justify-content:space-between;gap:10px;padding:7px 9px;border-radius:7px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,transparent)}
.pr-attach-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pr-attach-type{color:var(--dsw-alias-label-secondary);flex:none;font-size:10.5px;line-height:18px}
.pr-muted{color:var(--dsw-alias-label-secondary);font-size:12px}
.pr-empty-list{padding:28px 14px;text-align:center}
.pr-error{margin:8px 12px;padding:8px 11px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 28%,transparent);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.6}
.pr-loading{display:flex;align-items:center;gap:8px;justify-content:center;padding:28px;color:var(--dsw-alias-label-secondary);font-size:12px}
.pr-spin{width:12px;height:12px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;display:inline-block;animation:pr-spin .8s linear infinite}
@keyframes pr-spin{to{transform:rotate(360deg)}}
.pr-reader{display:flex;flex-direction:column;height:100%;min-height:0;position:relative}
.pr-reader-bar{display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent);flex-wrap:wrap}
.pr-reader-title{flex:1;min-width:140px;font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pr-reader-pages{color:var(--dsw-alias-label-secondary);font-size:11px;flex:none}
.pr-reader-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.pr-group{display:flex;align-items:center;gap:2px;padding:2px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 55%,transparent)}
.pr-icon-btn{width:26px;height:26px;border-radius:6px;border:none;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:14px;line-height:1;display:inline-flex;align-items:center;justify-content:center;transition:background .12s ease}
.pr-icon-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.pr-zoom{font-size:11px;color:var(--dsw-alias-label-secondary);min-width:42px;text-align:center;font-variant-numeric:tabular-nums}
.pr-zoom-wrap{display:inline-flex;align-items:center;gap:1px}
.pr-zoom-input{width:44px;text-align:right;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,transparent);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:2px 4px;outline:none}
.pr-zoom-input:focus{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent)}
.pr-zoom-suffix{font-size:11px;color:var(--dsw-alias-label-secondary)}
.pr-switch{display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;user-select:none;color:var(--dsw-alias-label-primary);padding:3px 8px 3px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 55%,transparent)}
.pr-switch input{appearance:none;-webkit-appearance:none;width:26px;height:15px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 30%,transparent);position:relative;cursor:pointer;transition:background .15s ease;margin:0;flex:none}
.pr-switch input:before{content:"";position:absolute;top:2px;left:2px;width:11px;height:11px;border-radius:50%;background:#fff;transition:transform .15s ease;box-shadow:0 1px 2px rgba(0,0,0,.25)}
.pr-switch input:checked{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-label-secondary))}
.pr-switch input:checked:before{transform:translateX(11px)}
.pr-select{font-size:12px;padding:4px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 72%,transparent);color:var(--dsw-alias-label-primary);font-family:inherit;outline:none}
.pr-progress{display:flex;align-items:center;gap:7px;padding:6px 14px;font-size:11.5px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 45%,transparent)}
.pr-reader-scroll{flex:1;overflow:auto;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 62%,transparent);padding:16px;display:flex;flex-direction:column;align-items:center;gap:14px;min-height:0}
.pr-page-wrap{position:relative;flex:none;background:#fff;border-radius:2px;box-shadow:0 2px 10px rgba(15,25,60,.18),0 1px 2px rgba(15,25,60,.12)}
.pr-page{position:relative;width:100%;height:100%;background:#fff;overflow:hidden}
.pr-page-canvas{display:block;position:absolute;inset:0}
.pr-page-placeholder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9aa5ab;font-size:12px;background:#fbfcfd}
.pr-text-layer{position:absolute;inset:0;overflow:hidden;line-height:1;user-select:text;cursor:text}
.pr-text-span{position:absolute;white-space:pre;transform-origin:0 0;color:transparent;font-family:sans-serif}
.pr-text-layer ::selection{background:rgba(82,106,168,.35)}
.pr-trans-block{position:absolute;overflow:hidden;background:#fff;color:#161616;font-family:"Microsoft YaHei","Noto Sans SC",sans-serif;line-height:1.28;padding:0 1px;box-sizing:border-box;pointer-events:none}
.pr-page-error{position:absolute;left:10px;top:10px;color:#b3261e;font-size:12px;background:rgba(255,255,255,.92);padding:5px 9px;border-radius:6px}
.pr-reader-body{flex:1;min-height:0;display:flex}
.pr-reader-canvas{flex:1;min-width:0;display:flex;flex-direction:column;position:relative}
.pr-ask{position:relative;flex:none;display:flex;flex-direction:column;min-height:0;min-width:0;border-left:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent)}
.pr-ask-resizer{position:absolute;left:-3px;top:0;bottom:0;width:6px;cursor:col-resize;z-index:2}
.pr-ask-resizer:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}
.pr-ask-head{flex:none;display:flex;align-items:center;justify-content:space-between;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.pr-ask-title{font-size:12.5px;font-weight:600}
.pr-ask-context{flex:none;margin:8px 10px 0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 45%,transparent);overflow:hidden;animation:pr-context-pop .45s ease}
@keyframes pr-context-pop{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}100%{box-shadow:0 0 0 7px transparent}}
.pr-ask-context-head{display:flex;align-items:center;justify-content:space-between;padding:6px 9px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.pr-ask-link{border:none;background:transparent;color:color-mix(in srgb,var(--dsw-alias-brand-primary) 85%,var(--dsw-alias-label-primary));font-size:10.5px;font-family:inherit;cursor:pointer;padding:0}
.pr-ask-context-body{padding:0 9px 8px;font-size:11.5px;line-height:1.6;white-space:pre-wrap;color:var(--dsw-alias-label-primary);max-height:74px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
.pr-ask-context.is-open .pr-ask-context-body{display:block;max-height:220px;overflow:auto;-webkit-line-clamp:unset}
.pr-ask-thread{position:relative;flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:14px;padding:12px}
.pr-ask-empty{display:flex;flex-direction:column;gap:10px;margin-top:6px}
.pr-ask-empty-title{font-size:12px;color:var(--dsw-alias-label-secondary)}
.pr-ask-chips{display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.pr-suggest{border:1px dashed var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;padding:5px 10px;border-radius:999px;cursor:pointer;font-family:inherit}
.pr-suggest:hover{border-style:solid;color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}
.pr-ask-more{align-self:center;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer;text-decoration:underline;text-decoration-style:dotted}
.pr-msg{display:flex;flex-direction:column;gap:6px}
.pr-msg-quote{margin:0;padding:6px 9px;border-left:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 40%,transparent);border-radius:0 8px 8px 0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.55;white-space:pre-wrap;max-height:74px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
.pr-msg-q{align-self:flex-end;max-width:92%;padding:8px 12px;border-radius:12px 12px 3px 12px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1.6}
.pr-msg-a{padding:10px 12px;border-radius:3px 12px 12px 12px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 70%,transparent);font-size:12.5px;line-height:1.75;color:var(--dsw-alias-label-primary)}
.pr-rich-p{margin:0 0 8px}
.pr-rich-p:last-child{margin-bottom:0}
.pr-rich-list{margin:0 0 8px;padding-left:18px}
.pr-inline-code{font-family:Consolas,monospace;font-size:11.5px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 14%,transparent);padding:0 4px;border-radius:4px}
.pr-msg-sources{display:flex;flex-wrap:wrap;gap:6px}
.pr-msg-source{font-size:10.5px;color:color-mix(in srgb,var(--dsw-alias-brand-primary) 85%,var(--dsw-alias-label-primary));text-decoration:none;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,transparent);border-radius:999px;padding:2px 8px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pr-msg-source:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.pr-msg-note{font-size:10.5px;color:var(--dsw-alias-state-warning-primary,#b26a00)}
.pr-msg-web{font-size:10.5px;color:color-mix(in srgb,var(--dsw-alias-brand-primary) 80%,var(--dsw-alias-label-primary))}
.pr-web-status{font-size:10.5px;color:var(--dsw-alias-label-secondary);padding:2px 0 4px}
.pr-web-status.is-error{color:var(--dsw-alias-state-error-primary)}
.pr-msg-elapsed{font-variant-numeric:tabular-nums;opacity:.75}
.pr-msg-meta{display:flex;align-items:center;gap:8px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.pr-msg-time{font-variant-numeric:tabular-nums}
.pr-msg-action{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:10.5px;cursor:pointer;padding:0;font-family:inherit}
.pr-msg-action:hover{color:var(--dsw-alias-label-primary)}
.pr-msg.is-live .pr-msg-q{align-self:flex-start;background:transparent;padding:0;font-size:11px;color:var(--dsw-alias-label-secondary)}
.pr-typing{display:inline-flex;gap:3px;padding:2px 0}
.pr-typing span{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-brand-primary);opacity:.4;animation:pr-typing 1s infinite}
.pr-typing span:nth-child(2){animation-delay:.15s}
.pr-typing span:nth-child(3){animation-delay:.3s}
@keyframes pr-typing{0%,100%{opacity:.25;transform:translateY(0)}50%{opacity:1;transform:translateY(-2px)}}
.pr-ask-jump{position:absolute;right:18px;bottom:104px;z-index:5;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 92%,transparent);color:var(--dsw-alias-label-secondary);font-size:11px;padding:4px 10px;border-radius:999px;cursor:pointer;box-shadow:0 4px 12px rgba(12,22,55,.18)}
.pr-ask-error{display:flex;align-items:center;gap:8px;margin:0 10px 6px;padding:7px 9px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent);color:var(--dsw-alias-state-error-primary);font-size:11px}
.pr-ask-compose{flex:none;display:flex;flex-direction:column;gap:7px;padding:9px 10px 10px;border-top:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 65%,transparent)}
.pr-ask-hint{font-size:10px;color:var(--dsw-alias-label-secondary);text-align:right}
.pr-textarea{width:100%;box-sizing:border-box;resize:none;min-height:56px;max-height:168px;padding:8px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-base) 55%,transparent);color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1.6;font-family:inherit;outline:none;transition:border-color .12s ease,box-shadow .12s ease}
.pr-textarea:focus{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.pr-ask-actions{display:flex;gap:6px;justify-content:flex-end;align-items:center}
.pr-ask-actions-spacer{flex:1}
.pr-ask-fab{position:fixed;z-index:40;transform:translate(-50%,0);padding:6px 13px;border-radius:999px;border:1px solid rgba(12,23,48,.18);background:#2c3d61;color:#fff;font-size:12px;font-family:inherit;cursor:pointer;box-shadow:0 4px 14px rgba(12,22,55,.28);transition:transform .12s ease}
.pr-ask-fab:hover{transform:translate(-50%,-1px)}
.pr-modal-backdrop{position:absolute;inset:0;background:rgba(10,18,42,.32);display:flex;align-items:center;justify-content:center;z-index:50;backdrop-filter:blur(2px)}
.pr-modal{width:min(640px,92%);max-height:82%;display:flex;flex-direction:column;overflow:hidden;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 96%,transparent);box-shadow:0 18px 48px rgba(10,18,42,.28)}
.pr-modal-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);font-weight:600;font-size:13px}
.pr-modal-body{padding:14px 16px;overflow:auto;font-size:12.5px;line-height:1.7}
.pr-notes-log{margin-top:4px;display:flex;flex-direction:column;gap:2px}
.pr-notes-line{padding:2px 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.pr-notes-result{margin-top:8px;padding:9px 11px;border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,transparent);font-size:12px;line-height:1.7;word-break:break-all}
.pr-notes-result.is-error{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent)}
.pr-notes-float{position:absolute;right:16px;bottom:16px;width:330px;z-index:35;display:flex;flex-direction:column;gap:8px;padding:12px 14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 96%,transparent);box-shadow:0 12px 32px rgba(10,18,42,.22);backdrop-filter:blur(6px)}
.pr-notes-float-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12.5px;font-weight:600}
.pr-notes-float-title{display:flex;align-items:center;gap:7px}
.pr-notes-indeterminate{position:relative;height:3px;border-radius:2px;overflow:hidden;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent)}
.pr-notes-list{display:flex;flex-direction:column;gap:6px;max-height:230px;overflow:auto}
.pr-notes-row{display:flex;align-items:flex-start;gap:8px;padding:7px 8px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 48%,transparent)}
.pr-notes-row.is-idle{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent)}
.pr-notes-row-icon{flex:none;width:14px;text-align:center;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.pr-notes-row-icon.is-done{color:var(--dsw-alias-state-success-primary)}
.pr-notes-row-icon.is-error{color:var(--dsw-alias-state-error-primary)}
.pr-notes-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.pr-notes-row-title{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pr-notes-row-meta{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.pr-notes-row-path{font-size:10.5px;color:var(--dsw-alias-label-secondary);word-break:break-all;font-family:Consolas,monospace}
.pr-notes-row-actions{display:flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap}
.pr-notes-warn{font-size:11px;color:var(--dsw-alias-state-warning-primary,#b26a00)}
.pr-split-wrap{flex:1;min-height:0;display:flex;flex-direction:column}
.pr-split-bar{display:flex;align-items:center;gap:6px;padding:5px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent);flex:none}
.pr-split-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.pr-chip{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 60%,transparent);color:var(--dsw-alias-label-primary);font-size:11px;line-height:1;padding:4px 9px;border-radius:999px;cursor:pointer}
.pr-chip:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.pr-chip.is-off{color:var(--dsw-alias-label-secondary);background:transparent;border-style:dashed}
.pr-split{flex:1;min-height:0;display:flex}
.pr-split .pr-pane{flex:1 1 0;min-width:0;display:flex;flex-direction:column;min-height:0}
.pr-split .pr-pane + .pr-pane{border-left:1px solid var(--dsw-alias-border-l1)}
.pr-confirm{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;font-size:11.5px;color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);border-bottom:1px solid var(--dsw-alias-border-l1)}
.pr-confirm .pr-btn{padding:3px 10px;font-size:11px}
.pr-note-versions{display:flex;flex-direction:column;gap:4px;margin:2px 0 6px}
.pr-note-version{display:flex;align-items:center;gap:8px}
.pr-note-version-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-primary)}
.pr-note-version-badge{flex:none;font-size:10.5px;padding:1px 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:color-mix(in srgb,var(--dsw-alias-brand-primary) 80%,var(--dsw-alias-label-primary))}
.pr-model-picker{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap}
.pr-select-sm{font-size:11px;padding:2px 6px;border-radius:7px;max-width:168px}
.pr-note-tools{display:flex;align-items:center;gap:6px;margin:2px 0 8px}
.pr-note-version-latest{flex:none;font-size:10.5px;color:var(--dsw-alias-state-success-primary)}
.pr-btn-sm{padding:2px 9px;font-size:11px}
.pr-notes-indeterminate span{position:absolute;top:0;bottom:0;left:-40%;width:40%;border-radius:2px;background:var(--dsw-alias-brand-primary);animation:pr-indeterminate 1.2s ease-in-out infinite}
@keyframes pr-indeterminate{0%{left:-40%}100%{left:100%}}
.pr-notes-step{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary)}
.pr-notes-meta{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.pr-notes-result-compact{font-size:11.5px}
.pr-btn.is-running{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,transparent);color:color-mix(in srgb,var(--dsw-alias-brand-primary) 85%,var(--dsw-alias-label-primary))}
.pr-path{font-family:Consolas,monospace;font-size:11px}
.pr-attach-state{color:var(--dsw-alias-label-secondary);margin-top:3px}
.pr-root ::-webkit-scrollbar{width:9px;height:9px}
.pr-root ::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 26%,transparent);border-radius:99px;border:2px solid transparent;background-clip:padding-box}
.pr-root ::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 40%,transparent);background-clip:padding-box}
.pr-root ::-webkit-scrollbar-track{background:transparent}
`

    function applyStyles() {
      const style = document.createElement('style')
      style.setAttribute('data-paper-reader', '')
      style.textContent = CSS
      document.head.appendChild(style)
      return () => style.remove()
    }

    if (typeof window !== 'undefined') {
      window.__paperReaderInternals = { buildBlocks, splitColumns, isTranslatable, normalizeKey }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => applyStyles(), 'paper-reader styles')
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'papers',
          order: 20,
          label: '论文',
        }, PanelIcon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'papers',
        }, PaperApp))
      },
    }
  },
})
