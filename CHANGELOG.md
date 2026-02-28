# Change Log

All notable changes to the "Antigravity SSH Proxy" extension will be documented in this file.

## [0.0.15] - 2026-02-27

### Added

- **ARM64 Support with FakeDNS**: Added `mgraftcp-fakedns-linux-arm64` and `libdnsredir-linux-arm64.so` binaries for ARM64 Linux servers.
  - ARM64 servers now have full FakeDNS support for DNS pollution prevention
  - Binaries are compiled with glibc 2.31 for maximum compatibility (Ubuntu 20.04+)

### Fixed

- **ARM64 Binary Replacement**: Replaced old non-functional `mgraftcp-linux-arm64` with working `mgraftcp-fakedns-linux-arm64` that includes FakeDNS support.

## [0.0.14] - 2026-02-26

### Fixed

- **Antigravity 1.19+ Compatibility**: Fixed proxy not working when Language Server runs in `persistent_mode`. 
  - Antigravity 1.19+ introduced `--persistent_mode` which keeps the LS running across window reloads
  - If LS started before wrapper was configured, it would not use proxy even after reload
  - Now automatically detects this scenario and kills the LS process to force restart through wrapper
- **Plugin Update in Persistent Mode**: Fixed new plugin features not taking effect after update when LS is in persistent mode
  - Previously, updating the plugin would update the wrapper but LS wouldn't restart
  - Now automatically kills LS when a new configuration is applied, ensuring new features take effect

### Added

- **Language Server Process Diagnostic**: New diagnostic check "Language Server Process" that shows:
  - Whether LS is running
  - Whether it's in persistent mode
  - Whether it's actually using proxy
  - Provides specific fix instructions when the bug scenario is detected
- **Startup Log Enhancement**: Added `[Test 2.5]` in startup status check to display LS process status with persistent_mode detection

### Improved

- **Smarter Proxy Detection**: Now uses `getLanguageServerProcess().isUsingProxy` as the authoritative check instead of just `isMgraftcpRunning()`, which could be fooled by stale processes
- **Auto-fix for Persistent Mode Bug**: When detecting LS in persistent_mode but not using proxy, automatically kills LS and prompts reload

## [0.0.13] - 2026-02-23

### Improved

- **Port Configuration Tips**: Added inline tips below port input fields in the ATP Status Panel to help users configure ports correctly:
  - **Local Panel — Local Port**: Tip clarifies this must match the listening port of local proxy software (e.g., Clash, V2Ray), typically `7890`.
  - **Local Panel — Remote Port**: Tip clarifies this is the SSH tunnel's listening port on the remote side, and must match the "Proxy Port" in the Remote ATP panel.
  - **Remote Panel — Proxy Port**: Tip clarifies this is the SSH tunnel's listening port on the remote side, and must match the "Remote Port" in the Local ATP panel.
- Both Chinese and English tip strings are supported via the existing i18n system.

## [0.0.9] - 2026-02-05

### Added

- **Status Panel Proxy Type Selector**: Added proxy type dropdown (HTTP/SOCKS5) to the Status & Config section in Status Panel for easy configuration.
- **Protocol Availability Testing**: Diagnostics now tests both HTTP and SOCKS5 protocols and displays availability of each in a list format.

### Fixed

- **MGraftcp Diagnostics**: Fixed diagnostic check to accurately detect `mgraftcp-fakedns` binary and display both wrapper and extension versions in the diagnostic report.

### Improved

- **Smart Protocol Warning**: If the currently selected proxy protocol is not working but another is available, the diagnostic shows a warning with suggestion to switch.

## [0.0.8] - 2026-02-04

### Added

- **Proxy Type Selection**: Added ability to select proxy type (HTTP or SOCKS5) through VS Code settings UI.
- **Configurable Proxy Protocol**: New `antigravity-ssh-proxy.proxyType` setting allows users to choose between HTTP (recommended for Clash, V2Ray) and SOCKS5 protocols.

### Improved

- **Setup Script**: Enhanced `setup-proxy.sh` to support both HTTP and SOCKS5 proxy protocols based on user configuration.

## [0.0.7] - 2026-02-04

### Fixed

- **FakeDNS Library Detection**: Fixed `libdnsredir-linux-amd64.so` not being found (was looking for `libdnsredir.so`).
- **Proxy Fallback Logic**: Fixed AutoSelectMode fallback - now tries HTTP proxy before falling back to direct connection when SOCKS5 fails.
- **HTTP Proxy Support**: Changed default from SOCKS5 to HTTP proxy for better compatibility with common proxy tools (Clash, etc.).

### Improved

- **Connection Reliability**: More robust proxy connection handling with proper fallback chain (SOCKS5 → HTTP Proxy → Direct).

## [0.0.6] - 2026-02-03

### Added

- **DNS Pollution Prevention**: Integrated FakeDNS and DNS hijacking mechanism to resolve connection issues in DNS-polluted environments.
- **Enhanced mgraftcp**: Upgraded to `mgraftcp-fakedns` which includes built-in FakeDNS server and `libdnsredir.so` for intercepting DNS calls.
- **Go Application Support**: Added `GODEBUG=netdns=cgo` to force Go applications (like the Antigravity Language Server) to use the cgo resolver, enabling DNS redirection.

### Improved

- **Connection Stability**: Significantly improved connection success rate for Google APIs by bypassing polluted DNS results.

## [0.0.2] - 2026-01-30

### Fixed

- Fixed mgraftcp binary permission issue on first install.
- Fixed proxy not working after Antigravity updates (now configures all Language Server versions).
- Fixed external connectivity diagnostic failing due to DNS resolution issues (now tries socks5h/http/socks5).
- Fixed rollback command only restoring one Language Server version (now restores all).

### Improved

- Smart reload prompt: only prompts when Language Server is not using proxy.
- Better compatibility with Clash/V2Ray mixed proxy ports.

## [0.0.1] - 2025-12-26

### Added

- Initial release.
- Automated proxy setup for Linux remote servers.
- SSH reverse tunnel forwarding via `~/.ssh/config.antigravity`.
- `mgraftcp` integration for process-level traffic redirection.
- Support for x86_64 and arm64 architectures.
