/* eslint-disable */
/**
 * Paper Reader Bridge — a Zotero 7+/10 bootstrap plugin.
 *
 * Zotero's local API is read-only, and its loopback HTTP server is not always
 * available, so the bridge uses two files in the Zotero data directory:
 *
 *   <dataDir>/paper-reader-bridge/request.json   written by DSH
 *   <dataDir>/paper-reader-bridge/result.json    written by this plugin
 *   <dataDir>/paper-reader-bridge/alive.json     heartbeat + diagnostics
 *
 * Only fixed paths are used (no directory listing), and every primitive has a
 * fallback, because the plugin sandbox is not a normal window scope.
 */
var PaperReaderBridge = {
  VERSION: '2.1.0',
  INTERVAL_MS: 2000,
  timer: null,
  busy: false,
  lastError: null,
  lastSeen: null,
  lastAction: null,

  baseDir() {
    var base = Zotero.DataDirectory.dir || Zotero.Prefs.get('dataDir');
    return PathUtils.join(base, 'paper-reader-bridge');
  },

  path(name) {
    return PathUtils.join(this.baseDir(), name);
  },

  fileExists(path) {
    try {
      return Zotero.File.pathToFile(path).exists();
    } catch (error) {
      this.lastError = 'exists:' + String((error && error.message) || error);
    }
    try {
      return IOUtils.exists(path);
    } catch (error) {
      this.lastError = 'exists2:' + String((error && error.message) || error);
    }
    return false;
  },

  async readText(path) {
    try {
      return await Zotero.File.getContentsAsync(path);
    } catch (error) {
      this.lastError = 'read:' + String((error && error.message) || error);
    }
    return await IOUtils.readUTF8(path);
  },

  async writeText(path, text) {
    // In-place write first: the atomic temp+rename used by putContentsAsync fails
    // with NS_ERROR_FILE_ACCESS_DENIED whenever another process briefly holds the
    // destination, and one such failure used to wedge the whole timer.
    try {
      await IOUtils.writeUTF8(path, text);
      return;
    } catch (error) {
      this.lastError = 'write:' + String((error && error.message) || error);
    }
    await Zotero.File.putContentsAsync(path, text);
  },

  removeFile(path) {
    try {
      var file = Zotero.File.pathToFile(path);
      if (file.exists()) file.remove(false);
      return;
    } catch (error) {
      this.lastError = 'remove:' + String((error && error.message) || error);
    }
    IOUtils.remove(path, { ignoreAbsent: true }).catch(function () {});
  },

  async importAttachment(request) {
    if (!request || !request.itemKey) throw new Error('ITEM_KEY_NOT_PROVIDED');
    if (!request.path) throw new Error('PATH_NOT_PROVIDED');
    var libraryID = request.libraryID || Zotero.Libraries.userLibraryID;
    var item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, request.itemKey);
    if (!item) throw new Error('ITEM_NOT_FOUND ' + request.itemKey);
    if (!this.fileExists(request.path)) throw new Error('FILE_NOT_FOUND ' + request.path);
    var attachment = await Zotero.Attachments.importFromFile({
      file: request.path,
      parentItemID: item.id,
      title: request.title || item.getField('title') + ' - 阅读笔记',
      contentType: request.contentType || 'application/pdf',
    });
    Zotero.debug('[paper-reader-bridge] attached ' + attachment.key + ' -> ' + request.itemKey);
    return { attachmentKey: attachment.key, attachmentID: attachment.id, mode: 'imported' };
  },

  async handleRequest() {
    var requestPath = this.path('request.json');
    var present = this.fileExists(requestPath);
    this.lastSeen = { at: Date.now(), request: present };
    if (!present) return;

    var request = null;
    try {
      request = JSON.parse(await this.readText(requestPath));
    } catch (error) {
      this.lastError = 'parse:' + String((error && error.message) || error);
      return;
    }
    if (!request) return;

    var result;
    try {
      var value = await this.importAttachment(request);
      result = {
        ok: true,
        token: request.token,
        at: Date.now(),
        attachmentKey: value.attachmentKey,
        attachmentID: value.attachmentID,
        mode: value.mode,
      };
    } catch (error) {
      Zotero.logError(error);
      result = { ok: false, token: request.token, at: Date.now(), error: String((error && error.message) || error) };
    }
    await this.writeText(this.path('result.json'), JSON.stringify(result));
    this.removeFile(requestPath);
    this.lastAction = { at: Date.now(), ok: result.ok, attachmentKey: result.attachmentKey || null, error: result.error || null };
  },

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await Zotero.File.createDirectoryIfMissingAsync(this.baseDir());
      await this.handleRequest();
      await this.writeText(this.path('alive.json'), JSON.stringify({
        version: this.VERSION,
        zotero: Zotero.version,
        at: Date.now(),
        pid: Services.appinfo.processID,
        lastSeen: this.lastSeen,
        lastAction: this.lastAction,
        lastError: this.lastError,
      }));
      this.lastError = null;
    } catch (error) {
      this.lastError = 'tick:' + String((error && error.message) || error);
      Zotero.logError(error);
    } finally {
      this.busy = false;
    }
  },

  start() {
    var self = this;
    if (this.timer) return;
    var loop = function () {
      self.timer = setTimeout(async function () {
        try {
          // A hung await must not stop the heartbeat for good: race it against a
          // watchdog and force the busy flag down on timeout.
          await Promise.race([
            self.tick(),
            new Promise(function (resolve) { setTimeout(resolve, 20000, 'timeout'); }),
          ]);
        } catch (error) {
          Zotero.logError(error);
        } finally {
          self.timer = null;
          self.busy = false;
          loop();
        }
      }, self.INTERVAL_MS);
    };
    loop();
  },

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      Zotero.File.pathToFile(this.path('alive.json')).remove(false);
    } catch (e) { /* ignore */ }
  },

  registerHttp() {
    var self = this;
    if (!Zotero.Server || !Zotero.Server.Endpoints) return;
    Zotero.Server.Endpoints['/paper-reader/ping'] = function () {};
    Zotero.Server.Endpoints['/paper-reader/ping'].prototype = {
      supportedMethods: ['GET', 'POST'],
      supportedDataTypes: ['*'],
      init: async function () {
        return [200, 'application/json', JSON.stringify({ ok: true, version: self.VERSION, transport: 'http' })];
      },
    };
    Zotero.Server.Endpoints['/paper-reader/attach'] = function () {};
    Zotero.Server.Endpoints['/paper-reader/attach'].prototype = {
      supportedMethods: ['POST'],
      supportedDataTypes: ['application/json'],
      init: async function (requestData) {
        try {
          var value = await self.importAttachment(requestData.data || {});
          return [200, 'application/json', JSON.stringify(Object.assign({ ok: true }, value))];
        } catch (error) {
          return [500, 'application/json', JSON.stringify({ ok: false, error: String((error && error.message) || error) })];
        }
      },
    };
  },
};

function install() {}

function uninstall() {
  try { PaperReaderBridge.stop(); } catch (e) { /* Zotero not ready during uninstall */ }
}

function startup({ id, version, rootURI }) {
  try {
    PaperReaderBridge.registerHttp();
    PaperReaderBridge.start();
    Zotero.debug('[paper-reader-bridge] started ' + PaperReaderBridge.VERSION);
  } catch (error) {
    Zotero.logError(error);
  }
}

function shutdown() {
  try { PaperReaderBridge.stop(); } catch (e) { /* ignore */ }
}

function onMainWindowLoad() {}
function onMainWindowUnload() {}
