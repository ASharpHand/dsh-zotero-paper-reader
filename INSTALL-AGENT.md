# 让 agent 帮你装这个插件

把下面整段发给你的 DSH agent 即可。它需要一台装了 **Zotero 7+/10** 的电脑。

---

## 可直接粘贴的指令

> 帮我安装论文阅读插件，仓库是 `https://github.com/ASharpHand/dsh-zotero-paper-reader`：
>
> 1. 执行 `dsh plugin install github:ASharpHand/dsh-zotero-paper-reader`，装完确认 profile 的 `dsh.profile.bundles` 里有 `@local/dsh-paper-reader`，然后重启 DSH。
> 2. 从该仓库下载 `paper-reader-bridge.xpi`，装进 Zotero：
>    - 先试 `工具 → 插件 → 从文件安装插件` 选这个 xpi，然后重启 Zotero；
>    - 如果重启后插件消失，完全退出 Zotero，运行仓库里的 `install-zotero-addon.py`，再启动 Zotero。
> 3. 检查 `http://127.0.0.1:<DSH端口>/paper-reader/state`：`zotero.bridge` 应为 `true`，`stats.items` 应大于 0。
> 4. 如果我要用「生成阅读笔记」，确认本机有 Python + `pymupdf`（`pip install pymupdf`）和 Edge/Chrome；没有就装。
> 5. 最后打开 DSH 侧边栏的「论文」图标，随便点一篇有 PDF 的文献，确认能渲染。

---

## agent 需要知道的细节

| 项 | 说明 |
| --- | --- |
| 插件包名 | `@local/dsh-paper-reader`，侧边栏入口叫「论文」 |
| 数据来源 | 只读 Zotero 的 `zotero.sqlite`，Zotero 关着也能浏览 |
| 桥接插件 | `paper-reader-bridge@dsh.local`，负责把生成的笔记 PDF 写成 Zotero 附件；不装只影响这一步 |
| 桥接心跳 | `<Zotero 数据目录>\paper-reader-bridge\alive.json`，每 2 秒刷新；`/paper-reader/state` 的 `zotero.bridge` 据此判断 |
| 需要重启 | DSH 装完插件后重启一次；Zotero 装/注册插件后重启一次 |
| 端口 | DSH Web 的实际端口看运行时的 GUI 地址，插件路由在 `/paper-reader/*` |

## 装完自检

1. `GET /paper-reader/state` → `ok: true`，`stats.items > 0`，`zotero.bridge: true`。
2. 打开「论文」→ 选一篇有 PDF 的条目 → 打开 PDF 能渲染、能滚动。
3. 划一段文字 → 出现「问 DSH」→ 提问能流式回答。
4. 点「生成笔记」→ 任务卡片显示进度，完成后显示 PDF 路径；Zotero 开着时会多出「已写入 Zotero」。

## 常见问题

- `bridge: false`：Zotero 没开，或 xpi 没装/没重启，或 `alive.json` 超过 20 秒没刷新。
- 笔记失败提示没有 PyMuPDF：`pip install pymupdf`，或用配置项 `python` 指向装了它的解释器。
- 打印 PDF 失败：装 Edge/Chrome，或用配置项 `browser` 指定路径。
- 技能目录可以没有：笔记会退回内置 11 节结构；想用自定义结构再把 `skillDir` 指向含 `SKILL.md` 的目录。
