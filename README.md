# 论文阅读模块（@local/dsh-paper-reader）

在 Harness Web 界面里读 Zotero 文献：浏览文献库、原位看 PDF、把英文替换成中文、划词向 DSH 提问、生成笔记 PDF 并回写 Zotero 附件。装好后侧边栏会多出一个「论文」图标。

## 安装

1. 安装到 DSH（任选其一）：

```
# GitHub（把 user/repo 换成你的仓库）
dsh plugin install github:user/repo

# 本地 tarball
dsh plugin install "<绝对路径>\paper-reader-1.0.0.tgz"
```

   也可以在 DSH 侧边栏「插件 → 安装组合包」里填 tarball 路径或 `github:user/repo`。安装后确认 `@local/dsh-paper-reader` 已启用，侧边栏出现「论文」。

2. 安装 Zotero 桥接插件（见下文「Zotero 桥接插件」）。只读文献、看 PDF、翻译、问答不需要它；把生成的笔记写成 Zotero 附件才需要。

3. 生成笔记需要额外依赖：Python + PyMuPDF（`pip install pymupdf`）和 Edge/Chrome。只读、翻译、问答不需要。

## 依赖

| 依赖 | 必需 | 说明 |
| --- | --- | --- |
| Zotero 7 / 10+ | 读库必需 | 只读 `zotero.sqlite`，Zotero 开着或关着都能读 |
| DSH 里的模型 | 笔记、问答必需 | 走当前会话模型；翻译可切免费通道 |
| Python + PyMuPDF | 笔记必需 | `pip install pymupdf` |
| Edge 或 Chrome | 笔记必需 | 把笔记 HTML 打印成 PDF |
| 阅读技能（SKILL.md） | 可选 | 不装就用内置笔记结构，只是章节样式不同 |

## 打开方式

左栏图标条（设置齿轮上方那一列）新增「论文」图标，点开即进入主面板。面板分三栏：

| 区域 | 内容 |
| --- | --- |
| 左 | Zotero 集合树（与 Zotero 一致的层级与条目数），顶部「全部文献」 |
| 中 | 条目列表，可按标题/期刊搜索，标出是否有 PDF、已有几条笔记 |
| 右 | 条目详情（摘要、元数据、附件、笔记生成状态）或 PDF 阅读器 |

## 阅读器

- 顶部工具栏：返回、页码/总页数、缩放、`中文替换` 开关、翻译通道下拉、`翻译全文`、`生成笔记`。
- 页面按可视区域惰性渲染；滚到哪页翻哪页（开关打开时），`翻译全文` 会从头到尾逐页翻译并显示进度。
- 翻译是**原位替换**：把每段英文的文字块盖上白底、在原位置画中文，字号自动缩放到能塞进原段落框，不改变页面版式，不额外生成一段中文。
- 译文按段落文本做缓存（`data\cache\translations-<附件ID>.json`），同一篇论文再次打开不会重复调用模型。缓存文件带 `BLOCK_VERSION`（客户端常量，切块算法变更时递增）；版本不符的旧缓存直接作废，不会被误用。
- 单次翻译请求上限 60 段 / 24000 字符（超出返回 413）；每批最多 12 段；`翻译全文` 逐页执行，进度条右侧有「停止」。
- 每篇论文的「中文替换 / 翻译通道 / 缩放」按附件 ID 存进 localStorage（键 `dpr:reader:<附件ID>`），整页刷新后仍保持。

## 笔记版本规则

- 「打开笔记」= 打开的永远是该条目下**版本号最大**的笔记附件；版本号取标题里的 `(vN)`，没有后缀的标题算 `v1`；版本号相同则取附件 ID 更大的（更晚导入）。
- 在 Zotero 里删掉某一版，只影响那一版：`v1/v2/v3` 删掉 `v3` 后打开 `v2`，删掉 `v2` 后打开 `v3`，全删则回到「生成阅读笔记」。
- 「重新生成」不会复用已删除的编号：下一版 = `max(现存附件版本, 本地 notes 目录里的历史文件版本) + 1`。所以删掉 `v3` 再生成得到的是 `v4`，文件名也不会覆盖旧文件。
- 划词：在 PDF 文字层里拖选 → 出现「问 DSH」按钮 → 右侧抽屉提问，回答流式返回；本轮问答自动存盘，生成笔记时会用到。

## 生成阅读笔记

点「生成阅读笔记」后按顺序执行：

1. 用技能 venv 的 PyMuPDF 抽取 PDF 全文（按页）。
2. 截取方法图：按 `Figure N` / `Fig. N` 标题定位图区（图注上方或下方相邻的嵌入图块，矢量图取最大的绘图矩形），按 200 dpi 渲染成 PNG 存到该论文的 `figures\` 下；截不到就跳过。
3. 把（可选的）技能 `SKILL.md`、`references/brief-template.md`、论文全文、方法图清单（图号/页码/图注/文件名）、该文献已有问答一起交给当前模型，产出中文 Markdown 笔记（模板 0–10 节 + 追加的「11. 问答与追问」）；第 4 节按清单嵌入方法图，未引用的图在生成后自动删除。**没装技能也能生成**：会退回内置的 11 节结构，只是章节粒度不如技能版细。
4. Markdown → HTML（marked + KaTeX 渲染 `$...$` / `$$...$$`，图片经本地接口按绝对路径取回）→ 用本机 Edge/Chrome 无头模式打印成 A4 PDF。
5. 通过 Zotero 桥接插件把 PDF 挂到该条目下，命名为「<标题> - 阅读笔记」。

产物位置：

```
shared\paper-reader\data\notes\<slug>\<slug>.md
shared\paper-reader\data\notes\<slug>\<slug>.pdf
shared\paper-reader\data\notes\<slug>\figures\figN_*.png
```

问答记录：`shared\paper-reader\data\qa\<itemKey>.json`。

## Zotero 桥接插件（写入附件用，装一次）

Zotero 10 的本地 API 只读，写附件必须走一条本地通道。这个很小的 Zotero 插件在数据目录里做一次固定文件名握手，不依赖 Zotero 自己的 HTTP 服务（该服务并非总是启动）：

```
%USERPROFILE%\Zotero\paper-reader-bridge\
  request.json   模块写入：{ token, itemKey, libraryID, path, title, contentType }
  result.json    插件写回：{ ok, token, attachmentKey } 或 { ok:false, error }
  alive.json     每 2 秒刷新，带 lastSeen / lastAction / lastError 诊断字段
```

装了它：笔记 PDF 会作为附件挂到条目下；不装也能读库、看 PDF、翻译、问答、生成 PDF，只是最后一步不写入 Zotero。

安装：

1. 启动 Zotero。
2. `工具 → 插件`，点右上角齿轮 → `Install Plugin From File…`（需要 Zotero 7 及以上）。
3. 选插件目录下的 `paper-reader-bridge.xpi`（GitHub 仓库根目录也有）。
4. 重启 Zotero。

清单必须带 `applications.zotero.update_url`，缺了会被 Zotero 判为 invalid XPI（日志里写 `Reading manifest: applications.zotero.update_url not provided`）。

**备用安装法**：如果界面安装后重启插件消失（部分版本会丢掉未签名插件），运行仓库根目录的 `install-zotero-addon.py`：它会把 xpi 复制进 profile 的 `extensions\` 并在 `extensions.json` 里登记一条记录（自动备份原文件）。跑之前先完全退出 Zotero，跑完再启动。

装好后 `alive.json` 会持续刷新，`/paper-reader/state` 的 `zotero.bridge` 变成 `true`，`bridgeDiag.lastSeen.request` 会随请求变化。插件同时也会在 Zotero 的 127.0.0.1:23119 服务可用时注册 `/paper-reader/ping` 与 `/paper-reader/attach`，两条通道都认。

## 数据来源与配置

- 文献库直接读 `zotero.sqlite`（只读连接），与 Zotero 是否运行无关；数据目录从 `%APPDATA%\Zotero\Zotero\Profiles\*\prefs.js` 的 `extensions.zotero.dataDir` 解析，默认 `%USERPROFILE%\Zotero`。
- 可调配置写在装配文件里该 bundle 行的 `config` 下（改完 reload 该插件生效）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `zoteroDataDir` | 自动解析 | Zotero 数据目录 |
| `outputDir` | `<包目录>\data\notes` | 笔记输出目录 |
| `skillDir` | `~\.codex\skills\remote-sensing-paper-brief`（可选） | 技能目录，找不到就用内置结构 |
| `python` | 技能 venv | 抽取 PDF 用的解释器 |
| `browser` | 自动探测 Edge/Chrome | 打印 PDF 用 |
| `notesMaxTokens` | `32000` | 笔记生成的输出上限 |
| `translateEngine` | `free` | 默认翻译通道（`free` 免费通道 / `llm` DSH 模型） |
| `whaleLedger` | `true` | 是否把小鲸鱼插件的账本也记上论文模块的用量 |

- 翻译通道有两个：`DSH 模型`（走当前默认模型，质量最好，按 token 计费）和 `免费通道`（官方 translator 服务，Bing/Google 匿名端点，不计费、长句略弱）。免费通道由本 bundle 的 `paper-reader-translator` 行提供，只挂 Host 服务，不启用实验性的思考翻译界面。

## HTTP 接口（同源，`/paper-reader/*`）

`GET /state`、`GET /collections`、`GET /items`、`GET /item`、`GET /pdf`（支持 Range）、`GET /translations`、`GET /vendor/*`、`GET /note-html`、`GET /note-asset`；
`POST /translate`、`POST /ask`（SSE）、`POST /notes`（SSE）、`POST /attach`。

## 已知限制

- 扫描版（无文字层）PDF 不能翻译也不能划词。
- 翻译按文字块合并段落，表格行、公式块会被判定为不可译而保留英文；跨栏大标题可能被合并成一块。
- 方法图按图注定位自动截取：图注在图上方或下方、且图是嵌入位图或大块矢量绘图时效果好；整页拼版、图注离图很远、或多图共用一条图注时可能截偏，需人工检查 `figures\` 里的图。
- 问答是模型的独立调用（不进聊天记录），笔记生成时从 `data/qa` 读取；需要真正带工具的会话版本可以后续替换。
- 修改 `client.js` 后需要刷新页面；修改 `lib/*.js` 后禁用再启用该插件即可生效（Host 半用缓存参数重新 import）。

## 维护

- 语法检查：`node --check index.js lib\*.js client.js`
- 重新打包桥接插件：把 `zotero-bridge\` 下两个文件压成 zip，改名 `.xpi`
