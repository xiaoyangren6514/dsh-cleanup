---
description: "删除已注册工作区的真实目录与会话日志：显式复核、默认移入可恢复回收站、live 会话可延迟到下次启动，并提供只读的存储总览页。"
kind: "package-bundle"
---

# dsh-cleanup

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件，补上 DSH 刻意不提供的两个删除：删除**已注册工作区的真实目录**，以及**删除一个会话的事件日志**（连同其子代理会话）。每次删除都走「计划 → 复核 → 确认」，默认移入可恢复的回收站，绝不会有「点一下就删掉」的路径。

DSH 本身对工作区只做「移除注册」（目录、文件与会话历史都留在磁盘上），对会话只做「归档」。`dsh-cleanup` 补上这一段，但不会把接口变成 `rm -rf`：目标必须由 DSH 已经知道的 id 指定，并且先让你看清具体会消失什么。

| | |
|---|---|
| 包名 | `dsh-cleanup`（不依赖任何 `@deepseek-ai/*` 包，运行时零依赖） |
| 版本 | 0.4.0 |
| 仓库 | <https://github.com/xiaoyangren6514/dsh-cleanup> |
| 作者 | fly |
| 许可证 | [MIT](LICENSE) |
| 验证环境 | DSH 0.2.2-rc.1 |
| Host 平台 | macOS（`darwin`）、Linux 与 Windows（`win32`） |

## 能做什么

| 能力 | 位置 |
|---|---|
| 删除一个已注册工作区的**真实目录**（递归） | 侧栏工作区右键 → **删除工作区目录…** |
| 删除一个**会话**（含其子代理会话日志） | 侧栏会话右键 → **删除会话…** |
| 总览每个工作区 / 会话占多少磁盘，批量删除 | 设置 → **存储清理** |
| 找回误删内容（默认移入回收站） | 设置 → 存储清理 → **回收站** |
| 本次 Host 内已打开的会话：安排到下次启动删除 | 复核弹窗 → **安排删除（本次启动结束后自动执行）**；设置里可查看/取消 |
| 调整清理策略（回收站位置/保留期/容量、审计日志、扫描预算、是否允许永久删除） | 设置 → 存储清理 → **清理设置** |
| 查看删除审计与上次启动的处理结果 | 设置 → 存储清理 → 清理设置 → **最近删除** |
| 回收站过大/过旧时得到提醒，并清理最旧条目（永不自动删） | 设置 → 存储清理 → 回收站 |
| 删除工作区目录前只读检查 Git 未提交/未推送内容 | 工作区复核弹窗；可在清理设置里关闭 |
| 按规则批量挑会话（天龄/归档/大小/工作区/来源），先预览再复核 | 设置 → 存储清理 → 会话 → **按规则选择** |
| 让 agent 查看「可以清理什么、占多少空间」 | 只读工具 `cleanup_inventory` |

**删除只能由你在界面上完成。** 提供给 agent 的工具是只读的：它可以报告有哪些会话和目录、各占多少空间、哪些因为正在使用而不能删，但没有任何删除入口。

## 安全模型

从一次点击到一个字节被删除，中间有四道闸：

1. **先计划，后执行。** 删除请求先生成*计划*：具体目标、文件/目录数、字节数、警告与阻塞项。计划一次性、5 分钟内有效；执行前会重新校验世界，任何变化都会以 `STATE_CHANGED` 拒绝。
2. **默认进回收站。** 目标被移动到 `<DSH_HOME>/trash/dsh-cleanup/<时间>-<名称>/`，之后可以恢复或彻底删除。永久删除是显式的第二种模式；永久删除工作区目录还要**手动输入目录名**。
3. **只删已注册、路径未漂移的目标。** 工作区目录必须是 DSH 注册过的工作区；执行前重新 `lstat` + `realpath`，必须仍等于注册表保存的规范路径，符号链接直接拒绝。文件系统根目录、家目录、`~/.dsh`、Host 进程工作目录**及其祖先目录**、回收站自身、层级过浅的路径都受保护。
4. **绝不碰正在使用的会话。** 即时删除与延迟删除都会探测会话持久化的写句柄，包括**另一个 Host 进程**持有的会话，运行中或已打开的会话一律拒绝（`SESSION_RUNNING` / `SESSION_LIVE`）。在会话仍持有写句柄时删除日志会损坏日志，拒绝是唯一安全的答案。

另外两条针对记账的护栏：

- **回收站归属校验。** 回收站条目带归属标记；`trashRoot` 只能指向本插件专用的目录，外来目录既不会被列出，也不会被删除。
- **自有状态。** 队列、设置、审计文件都在 `<DSH_HOME>/cleanup/` 下，属于用户可写状态，不是安全边界（见[安全说明](#安全说明)）。

## 安装

把 bundle 装进一个 DSH profile，然后**刷新一次浏览器页面**：Host 半部会热更新，但浏览器半部是新的客户端模块，页面需要重新加载才会出现菜单和设置页。

```sh
# 从 npm 安装（包发布之后）
dsh plugin --profile web add dsh-cleanup@0.4.0

# 从 GitHub 安装并固定到一个提交
dsh plugin --profile web add github:xiaoyangren6514/dsh-cleanup#<sha>

# 从本地 checkout 安装
git clone https://github.com/xiaoyangren6514/dsh-cleanup.git
dsh plugin --profile web add ./dsh-cleanup
```

`web` 是示例 profile 名，替换成你实际运行的 profile（`demo`、`headless` 等）。`dsh plugin --profile <name> <pnpm 参数>` 会在 profile 目录里转发给 pnpm 执行，所需的确认由 DSH 自己询问。

卸载用 `dsh plugin --profile web remove dsh-cleanup`，或在设置 → 插件里禁用/移除该 bundle。移除 bundle **不会**删除回收站里的文件和 `<DSH_HOME>/cleanup/` 下的状态文件。

从本地 checkout 安装的是链接目录：使用期间不要移动或删除它，否则 profile 可能无法启动。npm 与 GitHub 安装是普通的 profile 依赖。

### Discover

DSH 0.2.2-rc.1 **没有官方插件市场或官方索引**。Discover 页签由可选的实验性 plugin-market bundle 提供（出厂 profile 默认不启用），且默认没有配置任何索引源——需要你自己在 Discover 或设置 → 插件里添加索引 URL。社区维护的 DSH 插件索引包括：

- [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) —— 索引 <https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json>
- [dshopen.org](https://dshopen.org)

等 `dsh-cleanup` 发布并出现在某个索引里之后，添加该索引 URL，再从 Discover 安装（Discover 执行的仍是上面那条 `dsh plugin add` 命令），或继续用 CLI。在此之前请使用 npm / GitHub / 本地命令。

## 环境与兼容性

- **DSH 0.2.2-rc.1**（已验证）。`package.json` 声明 `engines.dsh: ^0.2.2-alpha.3`；插件管理器会在安装/启用前检查，版本不兼容时直接拒绝，而不是让插件在半坏的 API 上运行。
- Host 半部需要 **Node.js ≥ 20**。
- **Web 界面**。浏览器半部是 Web 客户端模块，通过 `window.__ModuleLoader__` 与 `shell.overlay` / `settings.section` / `contextMenu.*` 插槽注册。
- **macOS（`darwin`）、Linux 与 Windows（`win32`）**。bundle 声明 `dsh.bundle.platforms: ["darwin", "linux", "win32"]`。Windows 上使用盘符根与反斜杠路径：盘符根、系统目录（`C:\Windows`、`Program Files`、`ProgramData`）与家目录的上级均受保护，路径比较不区分大小写，层级按「相对盘符根的段数」计算，所以 `C:\proj` 与 `/proj` 一样被视为顶层目录而拒绝；junction 与符号链接同等拒绝。
- **本地文件系统**。插件操作的是 Host 进程可见的真实路径，不感知远程或非本地文件系统提供者。

## 界面语言

插件界面（设置页、复核弹窗、右键菜单、通知）只提供**简体中文与英文**。DSH 0.2.2-rc.1 还内置日语、西班牙语、法语、德语、俄语、巴西葡萄牙语；当 DSH 界面语言是这六种时，本插件的页面会**回落为英文**，而不是显示机翻内容。

插件管理器显示用的元数据（`locale/*.json`）保留**八种语言**，所以在设置 → 插件里的标题与简短描述仍按当前语言显示。长文详情以**中文为默认文档**：[docs/DETAIL.md](docs/DETAIL.md)，英文版为 [docs/DETAIL.en.md](docs/DETAIL.en.md)；中文界面读中文，英文界面读英文版，其余内置语言读中文默认文档。

## 文档

- [使用与故障排查 FAQ](docs/FAQ.md) —— 删除/恢复、live 会话、延迟队列、回收站、设置、审计、Git 检查、语言、排障
- [详情文档](docs/DETAIL.md) —— 面向市场详情页的长文（能力、安全模型、兼容性），**中文为默认文档**（[英文版](docs/DETAIL.en.md)）
- [冻结契约 SPEC](SPEC.md) —— Host ↔ 浏览器半部的接口契约
- [更新日志](CHANGELOG.md) —— 版本变更记录

## 许可证

[MIT](LICENSE) © 2026 fly。

## 安全说明

删除是用户动作，不是 agent 动作：面向 agent 的唯一入口是只读工具 `cleanup_inventory`。插件不写 DSH 自身的配置、不向 `document.body` 追加内容、不发起任何对外网络请求——仅向本机 Host 的同源 API 发请求，且全部针对 Host 已经知道的路径运行。剩下的信任边界在操作系统层面：任何与 Host 同权限的进程都能读写插件的状态文件，也能直接删除文件。请把 profile 目录当作私有目录。
