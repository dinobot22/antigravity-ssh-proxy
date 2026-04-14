<div align="center">
<img src="https://raw.githubusercontent.com/Eternal-Augustus/antigravity-ssh-proxy/main/ATP.jpg" width="128" />

# Antigravity SSH Proxy (ATP)

**简体中文** · [English](README.en.md)

[![GitHub stars](https://img.shields.io/github/stars/Eternal-Augustus/antigravity-ssh-proxy)](https://github.com/Eternal-Augustus/antigravity-ssh-proxy)
[![GitHub issues](https://img.shields.io/github/issues/Eternal-Augustus/antigravity-ssh-proxy)](https://github.com/Eternal-Augustus/antigravity-ssh-proxy/issues)
[![License](https://img.shields.io/github/license/Eternal-Augustus/antigravity-ssh-proxy)](https://github.com/Eternal-Augustus/antigravity-ssh-proxy/blob/main/LICENSE)

</div>
这是一个基于原始 **Antigravity SSH Proxy (ATP)** 的 fork，目标是在尽量保留 ATP 原有使用体验的前提下，把同一套 SSH 反向隧道和本地代理复用能力扩展到 **Codex**。它让 SSH 远程服务器的 AI 请求可以继续借道本地代理出网，而不是要求远端统一继承全局代理环境。

> ✨ **无需 root 权限** - 所有操作均在用户空间完成，安全便捷！

> **注意:** 支持 **Linux 远程服务器 (x86_64 / amd64)**。ARM64 架构为**实验性支持**（需 v0.0.15+）。

> 本项目基于 [dinobot22/antigravity-ssh-proxy](https://github.com/dinobot22/antigravity-ssh-proxy) 持续修改；其更早的基础来自 [wang-muhan/antigravity-interface](https://github.com/wang-muhan/antigravity-interface)。感谢原作者们的工作。

## Fork 改动概览

这个 fork 主要做了 4 类增强：

- **Codex 进程代理接入**：在 ATP 现有的 SSH 反向隧道和 `mgraftcp` 包装逻辑上，新增 `codex` 目标，让远端 `openai.chatgpt` 扩展内置的 Codex CLI 也能复用本地代理。
- **Codex Profile 同步与恢复**：新增“本地 Codex profile 同步到远端”和“恢复远端 profile 备份”命令，帮助远端直接复用本地已完成的登录态与配置。
- **Codex 历史 rebucket 工具**：针对 Codex 按 `model_provider` 分桶显示历史的问题，新增可选的历史 bucket 迁移与恢复能力。
- **Codex 诊断与面板操作**：在 ATP 面板与诊断报告中加入 Codex 相关检查项和快捷按钮，方便验证包装状态、profile bridge 和恢复操作。

## 设计思路

我们这次没有把重点放在“让远端扩展宿主继承全局代理环境”，而是尽量复用 ATP 原有的优雅路径：

- **优先代理具体工具进程，而不是改远端全局环境**：这样对现有工作区和远端 shell 的侵入更小，也更符合 ATP 原本的使用习惯。
- **把登录问题视为 profile 搬运问题，而不是强行远端 OAuth 问题**：对 Codex 来说，很多时候真正卡住的是远端登录交换和地区限制，而不是 CLI 本身。把本地 `~/.codex` 的关键文件安全同步到远端，通常比远端硬做 OAuth 更稳。
- **把历史合并做成显式的可恢复操作**：Codex 的会话历史本来就按 provider bucket 分组，强行自动合并风险较高，所以这部分被设计为带备份的显式重操作。
- **尽量保持 ATP 双端安装、双端协同的模型不变**：本地负责 SSH 转发和 profile bridge，远端负责包装和使用，避免引入另一套完全不同的运维方式。

## 为什么这样做

这套设计主要是为了覆盖三个真实场景：

- 远端服务器无法直接访问 OpenAI / ChatGPT / Google 等外网能力，但本地代理可用。
- 用户不喜欢或不方便让 `remote.SSH.remoteEnvironment`、远端 shell profile、扩展宿主环境变量长期继承代理。
- 用户需要在官方 Codex、第三方网关、以及其他远端 AI 插件之间来回切换，同时尽量保留各自历史与配置。

---

## ⚠️ 重要：需要双端安装

此插件必须同时安装在 **本地** 和 **远程服务器** 上：

| 位置 | 职责 |
|------|------|
| **本地** | 管理 SSH 端口转发配置 (`~/.ssh/config.antigravity`) |
| **远程** | 配置远程 AI 工具的代理包装器 (mgraftcp) |

---

## 功能特性

- **自动代理配置**：自动部署 `mgraftcp` 并配置代理。
- **SSH 反向隧道**：通过 SSH 端口转发将流量路由到本地代理。
- **进程重定向**：自动拦截并重定向受管工具进程。
- **DNS 污染防护**：集成 FakeDNS 功能，有效解决 DNS 污染导致的连接问题，确保稳定连接。
- **多目标支持**：可通过 `targetApps` 同时管理 `antigravity` 与 `codex`，后续也便于继续扩展更多远程 AI 插件。
- **Codex Profile 同步**：可将本地 `~/.codex/auth.json`、`config.toml`（以及可选的 `installation_id`）同步到远程，并自动备份远程原状态。

## 快速开始

### 前置条件

在开始之前，请确保满足以下条件：

- ✅ 本地代理软件（如 Clash、V2Ray）已启动并正常运行
- ✅ 本地 Antigravity 的 AI 功能可以正常使用（这表明您的网络环境已正确配置）

---

### 配置步骤

**Step 1 — 本地安装与配置**

1. 打开一个本地的 Antigravity项目并在扩展中搜索并安装 **Antigravity SSH Proxy** 插件(目前安装量比较小,可能需要按名称排序才能找到)
2. 安装成功后点击左下角 **ATP 面板**，配置 `localProxyPort` 为您本地代理端口（如 `7890`）
3. 检查面板状态，确认本地配置无异常. 

**Step 2 — 远程安装**

1. 使用 Antigravity SSH 连接到远程 Linux 服务器. PS: 步骤一启动的本地Antigravity窗口,尽量不要关闭
2. 在插件视图的 **"SSH: [服务器名]"** 分类下，再次安装本插件

**Step 3 — 激活并验证**

1. 按照提示执行 **Reload Window** 重启窗口. PS: 由于远程的需要对language server进行wrapper, 插件有的时候会提示您**多次**重启远程窗口,**按提示重启**. 本地的Antigravity窗口一般不需要重启)
2. 打开右下角 **ATP 面板**，运行 **连接诊断** 检查代理状态
3. 显示正常后，远程 AI 功能即可使用 🎉
   
**Step 4 — 简单重试**

如果发现功能不能正常使用时:
1. 关闭所有的(本地+远程)Antigravity窗口
2. 先打开本地的Antigravity窗口,等待本地插件启动完成(左下角ATP变绿),
3. 再点击左边的SSH链接远程服务器进行重试, 连接远程终端时一般有两个选项
> 1. 在当前窗口链接远程服务(connect SSH host in current window)
> 2. 打开新窗口链接远程服务(connect SSH host in new window) **<-- 选择这个**

进行重试,查看是否可行
   
**当系统提示需要重启窗口时，请重启以确保功能正常使用**

---


### 故障排查

如果配置+重试后仍无法正常使用，提交Bug日志时请附带一下远程链接服务器的日志信息：
> 1.  ATP页面中运行诊断, 复制诊断结果
> 2.  Antigravity的Output 面板内容中的
>    
> | 日志频道 | 查看路径 |
> |---------|---------| 
> | `Antigravity` | Output 面板 → Antigravity |
> | `Antigravity SSH Proxy` | Output 面板 → Antigravity SSH Proxy |

> 4. 一些额外的系统信息
> ```bash
>    uname -a                          # 内核版本
>    uname -m                          # 架构 (x86_64/aarch64)
>    ps -aux |grep language_server     # 查看实际启动的language_server
>    cat /proc/sys/kernel/yama/ptrace_scope  # Ptrace 权限信息
>    ls -la /.dockerenv                # 是否在 Docker 中
>    lscpu | grep -i aes               # 查看cpu情况
>    ps -aux | grep language_server
>```

## 扩展设置

| 设置 | 说明 |
|------|------|
| `enableLocalForwarding` | 启用 SSH 反向隧道转发。 |
| `localProxyPort` | 本地计算机上的代理端口。 |
| `remoteProxyHost` | 远程服务器上的代理主机地址。 |
| `remoteProxyPort` | 远程服务器上的代理端口。 |
| `showStatusOnStartup` | 连接远程服务器时显示状态通知。 |
| `targetApps` | 远程需要自动包装的目标应用，当前支持 `antigravity` 与 `codex`。 |

## Codex 支持与测试

当前这版可以完成的目标是：让 **远程服务器上的 Codex CLI/agent 流量** 复用 ATP 已建立的 SSH 反向隧道与本地代理，从而绕过远程环境的外网限制。

需要注意的边界：

- 已覆盖：`openai.chatgpt` 扩展内置的 `codex` 可执行文件会被 ATP 包装并通过 `mgraftcp` 出网。
- 可能未覆盖：`openai.chatgpt` 扩展宿主自身的少量 HTTP 请求不一定都经过 `codex` 子进程，这类流量必要时仍可能需要额外环境代理。

如果您的主要问题出在 **官方 Codex 登录态难以在远程完成**，推荐优先使用以下命令，而不是直接改远程环境变量：

- **Antigravity SSH Proxy: Sync Local Codex Profile To Remote**
- **Antigravity SSH Proxy: Restore Remote Codex Profile Backup**

它们会同步并管理以下文件：

- `~/.codex/auth.json`
- `~/.codex/config.toml`
- `~/.codex/installation_id`（如果本地存在）

同步前 ATP 会先自动备份远程当前 profile，恢复命令会回到最近一次同步前的状态。

### Codex 历史记录说明

Codex 的历史记录会按 `model_provider` / provider bucket 分组显示。也就是说：

- ATP 同步 `auth.json` 与 `config.toml` 时，**不会删除** 您现有的 `sessions/` 或 `state_5.sqlite`。
- 但如果切换后的 `model_provider` 名称不同，Codex UI 只会显示匹配当前 provider bucket 的历史。
- 为了让两套历史长期稳定共存，建议给第三方配置使用固定且独立的 provider 名称，例如 `custom`，避免和官方 `OpenAI` / `openai` 混在一起。

如果您确实想把两边历史显示在同一个 provider 下，需要额外做一次历史迁移（重写 session/db 中的 provider 字段）。这属于可选动作，建议先备份后再进行。

ATP 现在已经提供两条对应命令：

- **Antigravity SSH Proxy: Rebucket Codex History**
- **Antigravity SSH Proxy: Restore Codex History Backup**

它们会：

- 扫描当前 `~/.codex` 里已有的 provider bucket
- 让您选择 source provider，并输入 target provider
- 先自动备份受影响的 `sessions/*.jsonl` 和当前 `state_*.sqlite` / `-wal` / `-shm`
- 再重写 `session_meta.model_provider` 与 `threads.model_provider`

注意：

- 这一步是“合并显示历史”的可选重操作，不是日常切换 profile 的必需步骤。
- 历史 rebucket 依赖远端机器存在 `sqlite3` 命令。
- 如果您只是想在第三方和官方之间来回切换而不丢数据，优先使用 profile 同步/恢复即可，不一定要做 rebucket。

建议按下面顺序测试：

1. 本地与远程都安装 ATP，`targetApps` 保持为 `["antigravity", "codex"]`。
2. 连接远程 SSH 窗口后按提示 `Reload Window`，直到 ATP 面板不再提示需要重载。
3. 在 ATP 面板运行诊断，确认本地转发与远程代理状态都正常。
4. 在远程终端检查 Codex 是否已被包装：
   ```bash
   find ~/.antigravity-server/extensions -path '*openai.chatgpt-*/bin/linux-*/codex' -type f
   find ~/.antigravity-server/extensions -path '*openai.chatgpt-*/bin/linux-*/codex.bak' -type f
   ```
   如果 `codex` 与 `codex.bak` 同时存在，通常表示包装已完成。
5. 打开远程窗口中的 ChatGPT/Codex 插件，发起一个需要联网的 agent 请求。
6. 观察以下日志是否由原来的联网失败变为正常响应：
   - Output 面板 → `Antigravity SSH Proxy`
   - Output 面板 → `ChatGPT` / `Codex`
7. 如果需要进一步确认，可检查远程 Codex 日志中是否还出现 `ENOTFOUND`、`fetch failed`、TLS/DNS 失败等关键字。

最有价值的验收标准是：

- 关闭 ATP 或把 `targetApps` 改成仅 `["antigravity"]` 时，远程 Codex 再次失败。
- 恢复 `codex` 包装后，远程 Codex agent 恢复可用。

## 当前边界

目前这版的定位仍然是“在 ATP 基础上，为 Codex 补齐远端可用性”：

- 已重点覆盖远端 Codex CLI/agent 出网问题。
- 已提供 profile 同步、恢复、历史 rebucket 等配套工具。
- 仍不承诺覆盖 `openai.chatgpt` 扩展宿主内所有可能绕过 `codex` 子进程的联网路径。
- 暂未尝试把这套逻辑抽象成适用于所有远端 AI 插件的通用框架，但 `targetApps` 已为继续扩展留了入口。

## 卸载说明

卸载前，请先执行 **Antigravity SSH Proxy: Rollback Remote Environment** 命令以恢复原始的 Language Server。

## 环境要求

- 远程服务器的 SSH 访问权限。
- Linux 远程服务器（支持 x86_64/amd64，ARM64 为实验性支持，需 v0.0.15+）。
- 本地运行的代理软件（如 Clash、V2Ray）。

## 致谢

特别感谢以下项目：

- [graftcp](https://github.com/hmgle/graftcp): 提供了核心代理功能。
- [antigravity-interface](https://github.com/wang-muhan/antigravity-interface): 提供了最初的插件实现。
