/**
 * Read-only access to a local Zotero library.
 *
 * The library is read straight from zotero.sqlite (opened read-only, never
 * written) so the module works whether or not Zotero is running. A running
 * Zotero keeps fresh rows in the WAL file, which a read-only connection sees.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const TITLE_FIELD = 1
const DB_TTL_MS = 30_000

function pickDataDirFromPrefs() {
  const appData = process.env.APPDATA
  if (!appData) return undefined
  const profiles = path.join(appData, 'Zotero', 'Zotero', 'Profiles')
  let entries = []
  try {
    entries = fs.readdirSync(profiles, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const prefs = path.join(profiles, entry.name, 'prefs.js')
    let text
    try {
      text = fs.readFileSync(prefs, 'utf8')
    } catch {
      continue
    }
    const match = text.match(/"extensions\.zotero\.dataDir",\s*"((?:[^"\\]|\\.)*)"/)
    if (match) {
      return match[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"')
    }
  }
  return undefined
}

export function resolveDataDir(configured) {
  if (configured && fs.existsSync(path.join(configured, 'zotero.sqlite'))) return configured
  const fromPrefs = pickDataDirFromPrefs()
  if (fromPrefs && fs.existsSync(path.join(fromPrefs, 'zotero.sqlite'))) return fromPrefs
  const fallback = path.join(os.homedir(), 'Zotero')
  if (fs.existsSync(path.join(fallback, 'zotero.sqlite'))) return fallback
  return fromPrefs || fallback
}

export class ZoteroStore {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.dbPath = path.join(dataDir, 'zotero.sqlite')
    this.conn = undefined
    this.connAt = 0
    this.shadow = undefined
    this.shadowAt = 0
    this.index = undefined
    this.indexAt = 0
    this.sqliteError = undefined
  }

  async openDatabase(file) {
    let DatabaseSync
    try {
      ({ DatabaseSync } = await import('node:sqlite'))
    } catch (error) {
      this.sqliteError = `当前运行时没有 node:sqlite：${error?.message || error}`
      throw new Error(this.sqliteError)
    }
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      db.exec('PRAGMA busy_timeout = 800')
    } catch { /* older runtimes ignore it */ }
    return db
  }

  async connection() {
    const now = Date.now()
    if (this.conn && now - this.connAt < DB_TTL_MS) return this.conn
    if (this.conn) {
      try { this.conn.close() } catch { /* ignore */ }
      this.conn = undefined
    }
    this.conn = await this.openDatabase(this.dbPath)
    this.connAt = now
    return this.conn
  }

  /**
   * Zotero locks its database in rollback-journal mode while it writes, which
   * makes a concurrent reader fail with SQLITE_BUSY. Fall back to a throwaway
   * copy of the database (plus WAL) so browsing still works while Zotero is
   * busy indexing. A copy taken mid-checkpoint can be torn, so every snapshot
   * is verified and retried instead of surfacing SQLite's "malformed" error.
   */
  async shadowConnection() {
    const now = Date.now()
    if (this.shadow && now - this.shadowAt < 20_000) return this.shadow
    this.closeShadow()
    const dir = path.join(os.tmpdir(), 'dsh-paper-reader-shadow')
    fs.mkdirSync(dir, { recursive: true })
    this.cleanShadowDir(dir)
    const target = path.join(dir, `zotero-${process.pid}.sqlite`)
    let lastError
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await this.writeSnapshot(target)
        const db = await this.openDatabase(target)
        if (this.shadowLooksValid(db)) {
          this.shadow = db
          this.shadowAt = Date.now()
          return db
        }
        try { db.close() } catch { /* ignore */ }
        lastError = new Error('database disk image is malformed（快照不完整）')
      } catch (error) {
        lastError = error
      }
      await new Promise(resolve => setTimeout(resolve, 200))
      for (const suffix of ['', '-wal', '-shm']) {
        await fsp.rm(target + suffix, { force: true }).catch(() => {})
      }
    }
    throw new Error(`无法读取 Zotero 数据库快照：${lastError?.message || lastError}；请稍后重试，或重启 Zotero 后再试`)
  }

  async writeSnapshot(target) {
    await fsp.copyFile(this.dbPath, target)
    for (const suffix of ['-wal', '-shm']) {
      const source = this.dbPath + suffix
      const destination = target + suffix
      if (fs.existsSync(source)) await fsp.copyFile(source, destination).catch(() => {})
      else await fsp.rm(destination, { force: true }).catch(() => {})
    }
  }

  /** Drop snapshots left by earlier runs (older than ten minutes). */
  cleanShadowDir(dir) {
    let entries = []
    try {
      entries = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.startsWith('zotero-')) continue
      if (entry.startsWith(`zotero-${process.pid}.sqlite`)) continue
      const full = path.join(dir, entry)
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > 600_000) fs.rmSync(full, { force: true })
      } catch { /* another process may hold it */ }
    }
  }

  shadowLooksValid(db) {
    try {
      const rows = db.prepare('PRAGMA quick_check').all()
      const first = rows[0] ? Object.values(rows[0])[0] : ''
      return String(first || '').toLowerCase() === 'ok'
    } catch {
      return false
    }
  }

  closeShadow() {
    if (!this.shadow) return
    try { this.shadow.close() } catch { /* ignore */ }
    this.shadow = undefined
    this.shadowAt = 0
  }

  async run(db, sql, params) {
    const statement = db.prepare(sql)
    return statement.all(...params)
  }

  async query(sql, ...params) {
    const now = Date.now()
    // A recent SQLITE_BUSY means Zotero is mid-write: go straight to the copy
    // instead of paying the busy timeout again on every query.
    if (this.directLockedAt && now - this.directLockedAt < 10_000) {
      const rows = await this.run(await this.shadowConnection(), sql, params)
      this.scheduleIdleClose()
      return rows
    }
    try {
      const rows = await this.run(await this.connection(), sql, params)
      this.scheduleIdleClose()
      return rows
    } catch (error) {
      const message = String(error?.message || error)
      if (!/locked|busy|malformed|not a database/i.test(message)) throw error
      this.directLockedAt = now
      this.closeShadow()
      const shadow = await this.shadowConnection()
      const rows = await this.run(shadow, sql, params)
      this.scheduleIdleClose()
      return rows
    }
  }

  /**
   * A WAL read connection keeps a read mark for its whole lifetime, and Zotero
   * can only truncate `zotero.sqlite-wal` at shutdown when no reader holds one.
   * A non-empty WAL makes Zotero treat the next launch as an unclean shutdown
   * and run a full integrity check, so drop the handle as soon as we go idle.
   */
  scheduleIdleClose() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      if (this.conn) {
        try { this.conn.close() } catch { /* ignore */ }
        this.conn = undefined
      }
      this.closeShadow()
    }, 4000)
    this.idleTimer.unref?.()
  }

  async get(sql, ...params) {
    const rows = await this.query(sql, ...params)
    return rows[0]
  }

  async collections() {
    const rows = await this.query(
      `SELECT c.collectionID AS id, c.collectionName AS name, c.parentCollectionID AS parent,
              (SELECT COUNT(*) FROM collectionItems ci
                JOIN items i ON i.itemID = ci.itemID
                JOIN itemTypes t ON t.itemTypeID = i.itemTypeID
               WHERE ci.collectionID = c.collectionID
                 AND t.typeName NOT IN ('attachment','note','annotation')) AS count
         FROM collections c
        ORDER BY c.collectionName COLLATE NOCASE`,
    )
    return rows.map(row => ({ ...row, parent: row.parent ?? null }))
  }

  /** Title/date/type index of every top-level item, cached briefly. */
  async itemIndex(force = false) {
    const now = Date.now()
    if (!force && this.index && now - this.indexAt < DB_TTL_MS) return this.index
    const rows = await this.query(
      `SELECT i.itemID AS id, i.key AS key, t.typeName AS type,
              (SELECT v.value FROM itemData d
                 JOIN itemDataValues v ON v.valueID = d.valueID
                WHERE d.itemID = i.itemID AND d.fieldID = ${TITLE_FIELD}) AS title,
              (SELECT v.value FROM itemData d
                 JOIN itemDataValues v ON v.valueID = d.valueID
                 JOIN fieldsCombined f ON f.fieldID = d.fieldID
                WHERE d.itemID = i.itemID AND f.fieldName = 'date') AS date,
              (SELECT v.value FROM itemData d
                 JOIN itemDataValues v ON v.valueID = d.valueID
                 JOIN fieldsCombined f ON f.fieldID = d.fieldID
                WHERE d.itemID = i.itemID AND f.fieldName = 'publicationTitle') AS venue,
              (SELECT COUNT(*) FROM itemAttachments a
                WHERE a.parentItemID = i.itemID AND a.contentType = 'application/pdf') AS pdfs,
              (SELECT COUNT(*) FROM itemNotes n WHERE n.parentItemID = i.itemID) AS notes
         FROM items i
         JOIN itemTypes t ON t.itemTypeID = i.itemTypeID
        WHERE t.typeName NOT IN ('attachment','note','annotation')
        ORDER BY i.dateAdded DESC`,
    )
    const collectionsByItem = new Map()
    const links = await this.query('SELECT collectionID, itemID FROM collectionItems')
    for (const link of links) {
      const list = collectionsByItem.get(link.itemID)
      if (list) list.push(link.collectionID)
      else collectionsByItem.set(link.itemID, [link.collectionID])
    }
    this.index = rows.map(row => ({
      id: row.id,
      key: row.key,
      type: row.type,
      title: row.title || '(无标题)',
      date: row.date || '',
      year: (String(row.date || '').match(/\d{4}/) || [''])[0],
      venue: row.venue || '',
      pdfs: row.pdfs,
      notes: row.notes,
      collections: collectionsByItem.get(row.id) || [],
    }))
    this.indexAt = now
    return this.index
  }

  async listItems({ collection, q, limit = 100, offset = 0 } = {}) {
    const all = await this.itemIndex()
    const needle = (q || '').trim().toLowerCase()
    let rows = all
    if (collection) rows = rows.filter(row => row.collections.includes(collection))
    if (needle) {
      rows = rows.filter(row =>
        row.title.toLowerCase().includes(needle) ||
        row.venue.toLowerCase().includes(needle) ||
        row.key.toLowerCase() === needle)
    }
    return { total: rows.length, items: rows.slice(offset, offset + limit) }
  }

  async item(itemID) {
    const row = (await this.itemIndex()).find(entry => entry.id === itemID)
    if (!row) return undefined
    const fields = await this.query(
      `SELECT f.fieldName AS name, v.value AS value
         FROM itemData d
         JOIN fieldsCombined f ON f.fieldID = d.fieldID
         JOIN itemDataValues v ON v.valueID = d.valueID
        WHERE d.itemID = ?`,
      itemID,
    )
    const creators = await this.query(
      `SELECT c.firstName AS firstName, c.lastName AS lastName, ct.creatorType AS role
         FROM itemCreators ic
         JOIN creators c ON c.creatorID = ic.creatorID
         JOIN creatorTypes ct ON ct.creatorTypeID = ic.creatorTypeID
        WHERE ic.itemID = ?
        ORDER BY ic.orderIndex`,
      itemID,
    )
    const tags = await this.query(
      `SELECT t.name AS name FROM itemTags it JOIN tags t ON t.tagID = it.tagID WHERE it.itemID = ?`,
      itemID,
    )
    const attachments = await this.query(
      `SELECT a.itemID AS id, i.key AS key, a.path AS path, a.contentType AS contentType,
              a.linkMode AS linkMode, i.dateAdded AS dateAdded,
              (SELECT v.value
                 FROM itemData d
                 JOIN itemDataValues v ON v.valueID = d.valueID
                 JOIN fields f ON f.fieldID = d.fieldID
                WHERE d.itemID = a.itemID AND f.fieldName = 'title') AS title
         FROM itemAttachments a
         JOIN items i ON i.itemID = a.itemID
        WHERE a.parentItemID = ?
        ORDER BY a.itemID`,
      itemID,
    )
    const notes = await this.query(
      `SELECT n.itemID AS id, n.note AS note FROM itemNotes n WHERE n.parentItemID = ? ORDER BY n.itemID DESC`,
      itemID,
    )
    const fieldMap = Object.fromEntries(fields.map(field => [field.name, field.value]))
    return {
      ...row,
      title: fieldMap.title || row.title,
      abstract: fieldMap.abstractNote || '',
      doi: fieldMap.DOI || '',
      url: fieldMap.url || '',
      language: fieldMap.language || '',
      publication: fieldMap.publicationTitle || fieldMap.bookTitle || fieldMap.proceedingsTitle || '',
      creators: creators.map(creator => ({
        name: [creator.lastName, creator.firstName].filter(Boolean).join(', '),
        role: creator.role,
      })),
      tags: tags.map(tag => tag.name),
      fields: fieldMap,
      attachments: attachments.map(attachment => ({
        id: attachment.id,
        key: attachment.key,
        contentType: attachment.contentType,
        linkMode: attachment.linkMode,
        title: attachment.title || '',
        dateAdded: attachment.dateAdded || '',
        filename: attachment.path ? attachment.path.replace(/^storage:/, '') : '',
        path: this.attachmentPath(attachment),
        isPdf: attachment.contentType === 'application/pdf',
      })),
      notes: notes.length,
    }
  }

  attachmentPath(attachment) {
    if (!attachment?.path) return undefined
    if (attachment.path.startsWith('storage:')) {
      return path.join(this.dataDir, 'storage', attachment.key, attachment.path.slice('storage:'.length))
    }
    if (/^[A-Za-z]:[\\/]/.test(attachment.path) || attachment.path.startsWith('/')) {
      return attachment.path
    }
    return undefined
  }

  async firstPdf(itemID) {
    const detail = await this.item(itemID)
    if (!detail) return undefined
    const pdf = detail.attachments.find(attachment => attachment.isPdf && attachment.path)
    if (!pdf) return undefined
    if (!fs.existsSync(pdf.path)) return undefined
    return pdf
  }

  async attachmentById(attachmentID) {
    const row = await this.get(
      `SELECT a.itemID AS id, i.key AS key, a.path AS path, a.contentType AS contentType,
              a.parentItemID AS parentItemID
         FROM itemAttachments a JOIN items i ON i.itemID = a.itemID
        WHERE a.itemID = ?`,
      attachmentID,
    )
    if (!row) return undefined
    return {
      ...row,
      filename: row.path ? row.path.replace(/^storage:/, '') : '',
      path: this.attachmentPath(row),
      isPdf: row.contentType === 'application/pdf',
    }
  }

  async stats() {
    const items = await this.itemIndex()
    return { items: items.length, collections: (await this.collections()).length, dbPath: this.dbPath }
  }
}
