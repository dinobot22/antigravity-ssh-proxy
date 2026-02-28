<div align="center">
<img src="https://raw.githubusercontent.com/dinobot22/antigravity-ssh-proxy/main/ATP.jpg" width="128" />

# Antigravity SSH Proxy (ATP)

**English** · [简体中文](README.md)

[![Version](https://img.shields.io/open-vsx/v/dinobot22/antigravity-ssh-proxy)](https://open-vsx.org/extension/dinobot22/antigravity-ssh-proxy)
[![GitHub stars](https://img.shields.io/github/stars/dinobot22/antigravity-ssh-proxy)](https://github.com/dinobot22/antigravity-ssh-proxy)
[![GitHub issues](https://img.shields.io/github/issues/dinobot22/antigravity-ssh-proxy)](https://github.com/dinobot22/antigravity-ssh-proxy/issues)
[![License](https://img.shields.io/github/license/dinobot22/antigravity-ssh-proxy)](https://github.com/dinobot22/antigravity-ssh-proxy/blob/main/LICENSE)

</div>

This is an extension for **Antigravity** ([Open VSX Link](https://open-vsx.org/extension/dinobot22/antigravity-ssh-proxy)) designed to simplify SSH remote proxy configuration. ATP bypasses server firewalls by securely routing remote traffic through local or designated gateways.

> ✨ **No Root Permission Required** - All operations run in user space for security and convenience!

> **Note:** **Current version** only supports **Linux remote servers (x86_64)**. ARM based servers are **NOT** yet supported.

> This project is a fork of [wang-muhan/antigravity-interface](https://github.com/wang-muhan/antigravity-interface). Thanks to the original author for the excellent work!

---

## ⚠️ Important: Dual Installation Required

This extension must be installed on **BOTH** your local machine and remote server:

| Location   | Role                                                      |
| ---------- | --------------------------------------------------------- |
| **Local**  | Manages SSH port forwarding (`~/.ssh/config.antigravity`) |
| **Remote** | Configures Language Server proxy wrapper (mgraftcp)       |

---

## Features

- **Automated Proxy Setup**: Deploys `mgraftcp` and configures proxies automatically.
- **SSH Reverse Tunnel**: Routes traffic through your local proxy via SSH port forwarding.
- **Process Redirection**: Automatically intercepts and redirects language server processes.
- **DNS Pollution Prevention**: Integrated FakeDNS to protect against DNS pollution, ensuring stable connections to Google APIs.

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

### Persistent Configuration (Optional)

By default, ATP automatically writes `~/.ssh/config.antigravity` on startup and cleans it up when the extension deactivates. If you want the SSH config to **persist** (not change with the extension lifecycle), you can disable automatic writing.

**Recommended (One-Click Persistence):**

Since auto-write is enabled by default, the SSH config is already written when the extension starts. So you simply:

1. Start the extension normally, configure **Local Port** and **Remote Port** in the ATP Panel, and click Save
2. Once the config is working, turn off **"Auto Write SSH Config"** and Save again

The SSH config that was already written will be preserved and won't be overwritten or cleaned up by the extension anymore.

**Manual Method:**

Alternatively, after disabling auto-write, you can manually add the config to `~/.ssh/config`:

```ssh-config
Match all
    RemoteForward 7890 127.0.0.1:7890
    ExitOnForwardFailure no
```

> Replace `7890` with your actual port numbers (local proxy port and remote port)

**Benefits:**

- SSH config persists across IDE restarts
- You can configure per-Host rules instead of a global `Match all`
- Ideal for advanced users managing multiple servers with different configurations

> ⚠️ With auto-write disabled, you must manually update `~/.ssh/config` when changing ports

---

### Troubleshooting

If issues persist after configuration, check the following logs:

| Log Channel             | Location                             |
| ----------------------- | ------------------------------------ |
| `Antigravity`           | Output Panel → Antigravity           |
| `Antigravity SSH Proxy` | Output Panel → Antigravity SSH Proxy |

## Extension Settings

| Setting                 | Description                                                                 |
| ----------------------- | --------------------------------------------------------------------------- |
| `enableLocalForwarding` | Enable SSH reverse tunnel forwarding.                                       |
| `autoWriteSSHConfig`    | Automatically write SSH config. Disable to manage `~/.ssh/config` manually. |
| `localProxyPort`        | Local proxy port on your computer.                                          |
| `remoteProxyHost`       | Proxy host address on the remote server.                                    |
| `remoteProxyPort`       | Proxy port on the remote server.                                            |
| `proxyType`             | Proxy protocol type (HTTP or SOCKS5).                                       |
| `showStatusOnStartup`   | Show status notification when connecting to remote server.                  |

## Uninstall

Before uninstalling, run the **Antigravity SSH Proxy: Rollback Remote Environment** command to restore the original Language Server.

## Requirements

- SSH access to the remote server.
- Linux remote server (Currently x86_64 only).
- A local proxy running on your computer (e.g., Clash, V2Ray).

## Acknowledgements

Special thanks to the following projects:

- [graftcp](https://github.com/hmgle/graftcp): For the core proxy functionality.
- [antigravity-interface](https://github.com/wang-muhan/antigravity-interface): For the original extension implementation.
