<div align="center">
<img src="https://raw.githubusercontent.com/Eternal-Augustus/antigravity-ssh-proxy/main/ATP.jpg" width="128" />

# Antigravity SSH Proxy (ATP)

**English** · [简体中文](README.md)

[![GitHub stars](https://img.shields.io/github/stars/Eternal-Augustus/antigravity-ssh-proxy)](https://github.com/Eternal-Augustus/antigravity-ssh-proxy)
[![GitHub issues](https://img.shields.io/github/issues/Eternal-Augustus/antigravity-ssh-proxy)](https://github.com/Eternal-Augustus/antigravity-ssh-proxy/issues)
[![License](https://img.shields.io/github/license/Eternal-Augustus/antigravity-ssh-proxy)](https://github.com/Eternal-Augustus/antigravity-ssh-proxy/blob/main/LICENSE)

</div>

This fork builds on the original **Antigravity SSH Proxy (ATP)** and extends the same SSH reverse-tunnel and local-proxy reuse model to **Codex**. The goal is to keep ATP's workflow intact while restoring remote AI functionality without requiring a remote-wide proxy environment.

> ✨ **No Root Permission Required** - All operations run in user space for security and convenience!

> **Note:** Supports **Linux remote servers (x86_64 / amd64)**. ARM64 architecture is **experimentally supported** (requires v0.0.15+).

> This project continues from [dinobot22/antigravity-ssh-proxy](https://github.com/dinobot22/antigravity-ssh-proxy), which itself builds on [wang-muhan/antigravity-interface](https://github.com/wang-muhan/antigravity-interface). Thanks to the original authors for the groundwork.

## What This Fork Adds

This fork mainly adds four things on top of ATP:

- **Codex process proxying**: ATP's existing SSH reverse tunnel and `mgraftcp` wrapping flow now also supports `codex`, so the remote `openai.chatgpt` extension can reuse the local proxy.
- **Codex profile sync and restore**: ATP can sync a local Codex profile to the remote host and restore the previous remote profile from backup.
- **Codex history rebucketing tools**: ATP can optionally migrate Codex history from one `model_provider` bucket to another, with backup and restore support.
- **Codex diagnostics and panel actions**: the ATP panel and diagnostic report now include Codex-specific checks and management commands.

## Design Approach

The main design choice was to stay close to ATP's existing model instead of turning this into a remote-global-proxy solution:

- **Prefer wrapping the target process instead of mutating the whole remote environment**. This keeps the setup less invasive and better aligned with ATP's existing ergonomics.
- **Treat login as a profile portability problem rather than forcing remote OAuth to succeed**. For Codex, the hard part is often remote token exchange and geo restrictions, not the CLI itself. Syncing the critical files from local `~/.codex` is usually more reliable.
- **Make history merging explicit and reversible**. Codex history is bucketed by provider, so automatic merging is risky. This fork keeps it as a backup-first opt-in operation.
- **Keep ATP's dual-install, dual-role model intact**. The local side owns SSH forwarding and the profile bridge, while the remote side owns wrapping and execution.

## Why This Exists

This fork is aimed at three recurring real-world cases:

- The remote server cannot directly reach OpenAI / ChatGPT / Google, but the local machine can.
- The user does not want `remote.SSH.remoteEnvironment`, remote shell profiles, or extension-host environments to permanently inherit proxy variables.
- The user wants to switch between official Codex, third-party gateways, and other remote AI plugins while keeping configuration changes predictable and history recoverable.

---

## ⚠️ Important: Dual Installation Required

This extension must be installed on **BOTH** your local machine and remote server:

| Location | Role |
|----------|------|
| **Local** | Manages SSH port forwarding (`~/.ssh/config.antigravity`) |
| **Remote** | Configures proxy wrappers for managed remote AI tools (mgraftcp) |

---

## Features

- **Automated Proxy Setup**: Deploys `mgraftcp` and configures proxies automatically.
- **SSH Reverse Tunnel**: Routes traffic through your local proxy via SSH port forwarding.
- **Process Redirection**: Automatically intercepts and redirects managed remote tool processes.
- **DNS Pollution Prevention**: Integrated FakeDNS to protect against DNS pollution, ensuring stable connections to Google APIs.
- **Multi-Target Support**: `targetApps` can currently manage `antigravity` and `codex`, with room to extend further.
- **Codex Profile Sync**: Sync local `~/.codex/auth.json`, `config.toml`, and optional `installation_id` to the remote host with automatic backup.

## Quick Start

### Prerequisites

Before you begin, ensure the following conditions are met:

- ✅ Your local proxy software (e.g., Clash, V2Ray) is running and properly configured
- ✅ AI features work correctly in your local Antigravity (this confirms your network environment is set up correctly)

---

### Setup Steps

**Step 1 — Local Installation & Configuration**

1. Search and install **Antigravity SSH Proxy** in your local Antigravity
2. Click the **ATP Panel** in the bottom-left corner, configure `localProxyPort` to match your local proxy port (e.g., `7890`)
3. Check the panel status to confirm local configuration is correct

**Step 2 — Remote Installation**

1. Connect to your remote Linux server using Antigravity SSH
2. Install this extension again under the **"SSH: [server-name]"** category in the Extensions view

**Step 3 — Activate & Verify**

1. Follow the prompt to execute **Reload Window** to restart the window
2. Open the **ATP Panel** in the bottom-right corner, run **Connection Diagnostics** to check proxy status
3. Once everything shows normal, remote AI features are ready to use 🎉

---

### Troubleshooting

If issues persist after configuration, check the following logs:

| Log Channel | Location |
|-------------|----------|
| `Antigravity` | Output Panel → Antigravity |
| `Antigravity SSH Proxy` | Output Panel → Antigravity SSH Proxy |

## Extension Settings

| Setting | Description |
|---------|-------------|
| `enableLocalForwarding` | Enable SSH reverse tunnel forwarding. |
| `localProxyPort` | Local proxy port on your computer. |
| `remoteProxyHost` | Proxy host address on the remote server. |
| `remoteProxyPort` | Proxy port on the remote server. |
| `showStatusOnStartup` | Show status notification when connecting to remote server. |
| `targetApps` | Remote applications ATP should wrap. Currently supports `antigravity` and `codex`. |

## Codex Support and Testing

This build is intended to achieve one concrete goal: route **remote Codex CLI/agent traffic** through ATP's SSH reverse tunnel so the remote server can reuse your local proxy.

Current scope:

- Covered: the bundled `codex` executable inside the `openai.chatgpt` extension is wrapped by ATP and routed through `mgraftcp`.
- Possible gap: a small portion of HTTP requests made directly by the `openai.chatgpt` extension host may still bypass the `codex` subprocess and might need separate proxy handling.

If your main blocker is that the official Codex login flow is hard to complete on the remote server, prefer these commands before reaching for remote-wide proxy env vars:

- **Antigravity SSH Proxy: Sync Local Codex Profile To Remote**
- **Antigravity SSH Proxy: Restore Remote Codex Profile Backup**

ATP syncs and manages:

- `~/.codex/auth.json`
- `~/.codex/config.toml`
- `~/.codex/installation_id` (when present locally)

ATP always backs up the current remote profile first, and the restore command rolls the remote host back to the latest pre-sync state.

### Codex History Notes

Codex history is grouped by `model_provider` / provider bucket. In practice this means:

- Syncing `auth.json` and `config.toml` does **not** delete your existing `sessions/` or `state_5.sqlite`.
- But if the active `model_provider` string changes, the Codex UI will only show the history bucket that matches the current provider.
- For long-term coexistence, keep a stable dedicated provider name for third-party gateways, such as `custom`, instead of reusing the official `OpenAI` / `openai` bucket.

If you want both histories to appear under one provider, you need a separate history migration step that rewrites the provider field inside session metadata and the Codex state database. Treat that as an explicit opt-in operation and back up first.

ATP now includes matching commands:

- **Antigravity SSH Proxy: Rebucket Codex History**
- **Antigravity SSH Proxy: Restore Codex History Backup**

These commands:

- scan the provider buckets currently present under `~/.codex`
- let you choose a source provider and enter a target provider
- back up affected `sessions/*.jsonl` files plus the current `state_*.sqlite` / `-wal` / `-shm` files first
- then rewrite `session_meta.model_provider` and `threads.model_provider`

Notes:

- This is an explicit opt-in operation for merged history views, not a required step for normal profile switching.
- History rebucketing requires the `sqlite3` command on the remote machine.
- If you only want to switch between third-party and official Codex without losing data, profile sync/restore is usually enough.

Recommended validation flow:

1. Install ATP on both the local and remote side, and keep `targetApps` as `["antigravity", "codex"]`.
2. Connect to the remote SSH window and follow every `Reload Window` prompt until ATP reports the environment is stable.
3. Run ATP diagnostics and confirm local forwarding plus remote proxy status are both healthy.
4. Verify that Codex was wrapped on the remote host:
   ```bash
   find ~/.antigravity-server/extensions -path '*openai.chatgpt-*/bin/linux-*/codex' -type f
   find ~/.antigravity-server/extensions -path '*openai.chatgpt-*/bin/linux-*/codex.bak' -type f
   ```
   If both `codex` and `codex.bak` exist, the wrapper is usually in place.
5. Open the ChatGPT/Codex extension in the remote window and trigger an agent request that requires network access.
6. Watch these logs and confirm they no longer show the original network failure:
   - Output panel → `Antigravity SSH Proxy`
   - Output panel → `ChatGPT` / `Codex`
7. If needed, inspect the remote Codex log and check whether errors such as `ENOTFOUND`, `fetch failed`, TLS failures, or DNS failures are gone.

The strongest acceptance test is a before/after comparison:

- With ATP disabled, or with `targetApps` set to only `["antigravity"]`, remote Codex fails again.
- After re-enabling `codex` wrapping, the remote Codex agent works again.

## Current Boundaries

This fork is still scoped as "Codex support on top of ATP", not a universal proxy framework for every remote AI extension:

- It primarily targets the remote Codex CLI/agent traffic path.
- It includes profile sync, restore, and history rebucketing helpers around that path.
- It does not guarantee coverage for every network request made directly by the `openai.chatgpt` extension host.
- It keeps `targetApps` extensible for future plugins, but does not yet generalize the whole flow to every remote AI tool.

## Uninstall

Before uninstalling, run the **Antigravity SSH Proxy: Rollback Remote Environment** command to restore the original Language Server.

## Requirements

- SSH access to the remote server.
- Linux remote server (supports x86_64/amd64, ARM64 is experimentally supported, requires v0.0.15+).
- A local proxy running on your computer (e.g., Clash, V2Ray).

## Acknowledgements

Special thanks to the following projects:

- [graftcp](https://github.com/hmgle/graftcp): For the core proxy functionality.
- [antigravity-interface](https://github.com/wang-muhan/antigravity-interface): For the original extension implementation.
