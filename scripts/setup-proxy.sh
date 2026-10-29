#!/bin/bash
set -e

# ============================================================================
# Antigravity SSH Proxy - Setup Script
# ============================================================================
# This script creates wrapper scripts for language servers to route their
# traffic through a proxy using mgraftcp-fakedns.
#
# Environment Variables:
#   PROXY_HOST       - Proxy server host (default: __PROXY_HOST__)
#   PROXY_PORT       - Proxy server port (default: __PROXY_PORT__)
#   PROXY_TYPE       - Proxy type: http or socks5 (default: __PROXY_TYPE__)
#   EXTENSION_PATH   - Current extension's exact path (optional)
#   EXTENSION_VERSION - Current extension version for update detection
#   DEBUG            - Set to 1 for verbose output
# ============================================================================

# Use environment variables with defaults
PROXY_HOST="${PROXY_HOST:-__PROXY_HOST__}"
PROXY_PORT="${PROXY_PORT:-__PROXY_PORT__}"
PROXY_TYPE="${PROXY_TYPE:-__PROXY_TYPE__}"
EXTENSION_PATH="${EXTENSION_PATH:-}"
EXTENSION_VERSION="${EXTENSION_VERSION:-unknown}"
PROXY_ADDR="${PROXY_HOST}:${PROXY_PORT}"

# ============================================================================
# Debug Logging
# ============================================================================
DEBUG="${DEBUG:-0}"

debug_log() {
    if [ "$DEBUG" = "1" ]; then
        echo "[DEBUG] $*"
    fi
}

info_log() {
    echo "[INFO] $*"
}

warn_log() {
    echo "[WARN] $*"
}

error_log() {
    echo "[ERROR] $*"
}

# ============================================================================
# Header
# ============================================================================
echo "========================================"
echo "Antigravity SSH Proxy - Setup"
echo "========================================"
echo ""

# System info
ARCH=$(uname -m)
info_log "System Architecture: $ARCH"
info_log "Proxy Config: $PROXY_ADDR ($PROXY_TYPE)"
info_log "Extension Version: $EXTENSION_VERSION"
if [ -n "$EXTENSION_PATH" ]; then
    info_log "Extension Path: $EXTENSION_PATH"
fi
echo ""

# Determine expected binary names based on architecture
case "$ARCH" in
    x86_64|amd64) 
        EXPECTED_BINARY="mgraftcp-fakedns-linux-amd64"
        EXPECTED_LIB="libdnsredir-linux-amd64.so"
        ;;
    aarch64|arm64) 
        EXPECTED_BINARY="mgraftcp-fakedns-linux-arm64"
        EXPECTED_LIB="libdnsredir-linux-arm64.so"
        ;;
    *) 
        EXPECTED_BINARY="mgraftcp-fakedns-linux-$ARCH"
        EXPECTED_LIB="libdnsredir-linux-$ARCH.so"
        ;;
esac

debug_log "Expected Binary: $EXPECTED_BINARY"
debug_log "Expected Library: $EXPECTED_LIB"

# ============================================================================
# Server Directory Discovery
# ============================================================================
# Antigravity IDE has used different directory names across versions:
#   - .antigravity-ide-server (new, 2.x+)
#   - .antigravity-server (legacy)
# We search for the actual directory in priority order.
# ============================================================================
POSSIBLE_SERVER_DIRS=(
    "$HOME/.antigravity-ide-server"
    "$HOME/.antigravity-server"
)

SERVER_DIR=""
for dir in "${POSSIBLE_SERVER_DIRS[@]}"; do
    if [ -d "$dir/bin" ]; then
        SERVER_DIR="$dir"
        break
    fi
done

if [ -z "$SERVER_DIR" ]; then
    for dir in "${POSSIBLE_SERVER_DIRS[@]}"; do
        if [ -d "$dir" ]; then
            SERVER_DIR="$dir"
            break
        fi
    done
fi

if [ -z "$SERVER_DIR" ]; then
    SERVER_DIR="$HOME/.antigravity-ide-server"
fi

info_log "Server Directory: $SERVER_DIR"

# Helper to place mgraftcp binary and library
place_mgraftcp() {
    local target_dir="$1"
    mkdir -p "$target_dir"
    
    local src_binary=""
    local src_lib=""
    
    # Method 1: Check EXTENSION_PATH first
    if [ -n "$EXTENSION_PATH" ] && [ -f "$EXTENSION_PATH/resources/bin/$EXPECTED_BINARY" ]; then
        src_binary="$EXTENSION_PATH/resources/bin/$EXPECTED_BINARY"
        [ -f "$EXTENSION_PATH/resources/bin/$EXPECTED_LIB" ] && src_lib="$EXTENSION_PATH/resources/bin/$EXPECTED_LIB"
    fi
    
    # Method 2: Search in extension directories
    if [ -z "$src_binary" ]; then
        for d in $(ls -d "$HOME/.antigravity-ide-server/extensions/"*antigravity-ssh-proxy*/resources/bin "$HOME/.antigravity-server/extensions/"*antigravity-ssh-proxy*/resources/bin 2>/dev/null | sort -t'-' -k3 -V -r); do
            if [ -f "$d/$EXPECTED_BINARY" ]; then
                src_binary="$d/$EXPECTED_BINARY"
                [ -f "$d/$EXPECTED_LIB" ] && src_lib="$d/$EXPECTED_LIB"
                break
            fi
        done
    fi
    
    if [ -n "$src_binary" ] && [ -f "$src_binary" ]; then
        cp -f "$src_binary" "$target_dir/${EXPECTED_BINARY}.tmp.$$"
        chmod +x "$target_dir/${EXPECTED_BINARY}.tmp.$$"
        mv -f "$target_dir/${EXPECTED_BINARY}.tmp.$$" "$target_dir/$EXPECTED_BINARY"
        if [ -n "$src_lib" ] && [ -f "$src_lib" ]; then
            cp -f "$src_lib" "$target_dir/${EXPECTED_LIB}.tmp.$$"
            mv -f "$target_dir/${EXPECTED_LIB}.tmp.$$" "$target_dir/$EXPECTED_LIB"
        fi
        debug_log "Placed mgraftcp in $target_dir"
    fi
}

# ============================================================================
# Scan for extension directories (for debugging)
# ============================================================================
if [ "$DEBUG" = "1" ]; then
    echo ""
    echo "[SCAN] Searching for extension directories..."
    EXT_DIRS=$(ls -d "$SERVER_DIR/extensions/"*antigravity-ssh-proxy* 2>/dev/null | sort -t'-' -k3 -V -r || echo "")
    if [ -n "$EXT_DIRS" ]; then
        echo "$EXT_DIRS" | while read -r dir; do
            echo "  📦 $dir"
            BIN_DIR="$dir/resources/bin"
            if [ -d "$BIN_DIR" ]; then
                for f in "$BIN_DIR"/*; do
                    [ -e "$f" ] || continue
                    fname=$(basename "$f")
                    if [ -x "$f" ]; then
                        echo "    ├── $fname ✅"
                    else
                        echo "    ├── $fname"
                    fi
                done
            fi
        done
    else
        echo "  ⚠️  No extension directories found!"
    fi
    echo ""
fi

# ============================================================================
# Helper Functions
# ============================================================================

# Extract wrapper version from a wrapper script
get_wrapper_version() {
    local wrapper="$1"
    grep -oP 'WRAPPER_VERSION="\K[^"]+' "$wrapper" 2>/dev/null || echo "none"
}

# Extract proxy address from a wrapper script
get_wrapper_proxy_addr() {
    local wrapper="$1"
    grep -oP 'PROXY_ADDR="\K[^"]+' "$wrapper" 2>/dev/null || echo "none"
}

# Extract proxy type from a wrapper script
get_wrapper_proxy_type() {
    local wrapper="$1"
    grep -oP 'PROXY_TYPE="\K[^"]+' "$wrapper" 2>/dev/null || echo "none"
}

# Check if target is a wrapper script (current or legacy format)
is_wrapper_script() {
    local target="$1"
    grep -qE "(ANTIGRAVITY_SSH_PROXY_WRAPPER|WRAPPER_VERSION=|mgraftcp-fakedns)" "$target" 2>/dev/null
}

# Sync ~/.gemini/bin/agy.version.json sidecar stats (size, mtimeMs, ino) with the wrapper script
# so Antigravity IDE v2.6.0+ sidecar validation (doesSidecarMatchStats) succeeds without rewriting it
sync_agy_version_sidecar() {
    local target="$1"
    local sidecar="${target}.version.json"
    [ -f "$sidecar" ] || return 0

    local size mtime_sec ino mtime_ms
    read -r size mtime_sec ino <<< "$(stat -c '%s %Y %i' "$target" 2>/dev/null || true)"
    if [ -z "$size" ] || [ -z "$mtime_sec" ] || [ -z "$ino" ]; then
        return 0
    fi
    mtime_ms="${mtime_sec}000"

    # Skip write if size and ino in sidecar already match the target file
    if grep -qE "\"size\"[[:space:]]*:[[:space:]]*${size}(,|$)" "$sidecar" 2>/dev/null && \
       grep -qE "\"ino\"[[:space:]]*:[[:space:]]*${ino}(,|$)" "$sidecar" 2>/dev/null; then
        return 0
    fi

    local sidecar_tmp="${sidecar}.tmp.$$"
    if sed -E \
        -e "s/(\"size\"[[:space:]]*:[[:space:]]*)[0-9]+/\1${size}/" \
        -e "s/(\"mtimeMs\"[[:space:]]*:[[:space:]]*)[0-9]+(\.[0-9]+)?/\1${mtime_ms}/" \
        -e "s/(\"ino\"[[:space:]]*:[[:space:]]*)[0-9]+/\1${ino}/" \
        "$sidecar" > "$sidecar_tmp" 2>/dev/null; then
        mv -f "$sidecar_tmp" "$sidecar"
        debug_log "Synced sidecar metadata: $sidecar (size=$size, mtimeMs=$mtime_ms, ino=$ino)"
    else
        rm -f "$sidecar_tmp" 2>/dev/null || true
    fi
}

# Determine if wrapper needs to be updated
# Returns: 0 = needs update (with reason in stdout), 1 = up-to-date
check_needs_update() {
    local target="$1"
    
    # Check 1: Not a wrapper script (original binary or updated binary) → needs wrapper creation
    if ! is_wrapper_script "$target"; then
        echo "new_install"
        return 0
    fi

    # Check 1.5: Legacy wrapper without ANTIGRAVITY_SSH_PROXY_WRAPPER marker → needs upgrade
    if ! grep -q "ANTIGRAVITY_SSH_PROXY_WRAPPER" "$target" 2>/dev/null; then
        echo "upgrade_wrapper_format"
        return 0
    fi
    
    # Check 2: Version mismatch → needs update (covers upgrade, downgrade, legacy)
    local wrapper_version=$(get_wrapper_version "$target")
    if [ "$EXTENSION_VERSION" != "$wrapper_version" ]; then
        echo "version:$wrapper_version->$EXTENSION_VERSION"
        return 0
    fi
    
    # Check 3: Proxy address mismatch → needs update
    local wrapper_proxy_addr=$(get_wrapper_proxy_addr "$target")
    if [ "$PROXY_ADDR" != "$wrapper_proxy_addr" ]; then
        echo "proxy_addr:$wrapper_proxy_addr->$PROXY_ADDR"
        return 0
    fi
    
    # Check 4: Proxy type mismatch → needs update
    local wrapper_proxy_type=$(get_wrapper_proxy_type "$target")
    if [ "$PROXY_TYPE" != "$wrapper_proxy_type" ]; then
        echo "proxy_type:$wrapper_proxy_type->$PROXY_TYPE"
        return 0
    fi
    
    # All checks passed → up-to-date
    return 1
}

# ============================================================================
# Find Targets (Language Servers and agy Binary)
# ============================================================================
echo "[SEARCH] Looking for targets (language servers and agy binary)..."
TARGETS=""

# 1. Check for Antigravity IDE v2.6.0+ binary (~/.gemini/bin/agy)
AGY_BIN="$HOME/.gemini/bin/agy"
if [ -f "$AGY_BIN" ]; then
    info_log "Found Antigravity IDE v2.6.0+ target: $AGY_BIN"
    TARGETS="$AGY_BIN"
    place_mgraftcp "$SERVER_DIR/mgraftcp"
elif [ -f "$AGY_BIN.bak" ] && grep -q "ANTIGRAVITY_SSH_PROXY_WRAPPER" "$AGY_BIN" 2>/dev/null; then
    info_log "Found Antigravity IDE v2.6.0+ wrapped target: $AGY_BIN"
    TARGETS="$AGY_BIN"
    place_mgraftcp "$SERVER_DIR/mgraftcp"
fi

# 2. Check for legacy language servers (pre-v2.6.0)
LEGACY_TARGETS=""
for dir in "${POSSIBLE_SERVER_DIRS[@]}"; do
    if [ -d "$dir/bin" ]; then
        found=$(find "$dir/bin" -path "*/extensions/antigravity/bin/language_server_[l]inux_*" -type f 2>/dev/null | grep -v "\.bak$" || true)
        if [ -n "$found" ]; then
            LEGACY_TARGETS="${LEGACY_TARGETS:+$LEGACY_TARGETS"$'\n'"}$found"
        fi
    fi
done

if [ -n "$LEGACY_TARGETS" ]; then
    info_log "Found legacy language server target(s)"
    if [ -n "$TARGETS" ]; then
        TARGETS="$TARGETS"$'\n'"$LEGACY_TARGETS"
    else
        TARGETS="$LEGACY_TARGETS"
    fi
fi

# Filter empty lines and duplicates
TARGETS=$(echo "$TARGETS" | sed '/^$/d' | sort -u)

if [ -z "$TARGETS" ]; then
    error_log "No Antigravity language server or agy binary found!"
    error_log "Searched ~/.gemini/bin/agy and ${POSSIBLE_SERVER_DIRS[*]}/bin"
    error_log "For Antigravity IDE v2.6.0+, ~/.gemini/bin/agy was not found. Please configure VS Code 'http.proxy' first so the IDE completes the initial agy binary download before running proxy setup."
    exit 1
fi

TARGET_COUNT=$(echo "$TARGETS" | wc -l)
info_log "Found $TARGET_COUNT target(s)"
echo ""

# ============================================================================
# Process Each Target
# ============================================================================
CONFIGURED_COUNT=0
SKIPPED_COUNT=0

echo "[PROCESS] Configuring targets..."
echo ""

while IFS= read -r TARGET; do
    [ -z "$TARGET" ] && continue
    
    echo "----------------------------------------"
    echo "Target: $TARGET"
    BAK="${TARGET}.bak"
    
    # Check if update is needed
    if UPDATE_REASON=$(check_needs_update "$TARGET"); then
        info_log "Update needed: $UPDATE_REASON"
        
        # Log current wrapper state for debugging
        if is_wrapper_script "$TARGET"; then
            debug_log "Current wrapper state:"
            debug_log "  Version: $(get_wrapper_version "$TARGET")"
            debug_log "  Proxy: $(get_wrapper_proxy_addr "$TARGET")"
            debug_log "  Type: $(get_wrapper_proxy_type "$TARGET")"
        fi
    else
        # Already up-to-date
        sync_agy_version_sidecar "$TARGET"
        info_log "Already up-to-date (v$EXTENSION_VERSION, $PROXY_ADDR, $PROXY_TYPE)"
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        continue
    fi

    # Safe Backup Across IDE Self-Updates (using atomic rename to avoid ETXTBSY "Text file busy")
    if is_wrapper_script "$TARGET"; then
        # Target is already a wrapper script: keep existing backup intact
        if [ ! -f "$BAK" ]; then
            error_log "Target $TARGET is already a wrapper script but backup $BAK is missing!"
            error_log "Cannot proceed without original binary backup to avoid clobbering"
            continue
        fi
        debug_log "Backup already exists: $BAK"
    else
        # Target is an ELF binary (original or newly updated from IDE self-update)
        # Copy to temp file and atomically mv to $BAK so even a running $BAK never causes Text file busy
        BAK_TMP="${BAK}.tmp.$$"
        cp -f "$TARGET" "$BAK_TMP"
        chmod +x "$BAK_TMP"
        mv -f "$BAK_TMP" "$BAK"
        info_log "Backup created: $BAK"
    fi

    # ========================================================================
    # Create Wrapper Script (write to temp file and mv -f to avoid Text file busy)
    # ========================================================================
    # The wrapper script dynamically finds mgraftcp-fakedns at runtime,
    # allowing version upgrades without breaking existing wrappers.
    # ========================================================================
    WRAPPER_TMP="${TARGET}.tmp.$$"
cat > "$WRAPPER_TMP" << 'WRAPPER_EOF'
#!/bin/bash
# ANTIGRAVITY_SSH_PROXY_WRAPPER
# ============================================================================
# Antigravity SSH Proxy - Language Server Wrapper
# ============================================================================
# WRAPPER_VERSION="__EXTENSION_VERSION_PLACEHOLDER__"
# GENERATED="__TIMESTAMP_PLACEHOLDER__"
# ============================================================================

# Bypass proxy wrapper for version checks (used by Antigravity IDE v2.6.0+ startup verification)
if [ "$1" = "--version" ] || [ "$1" = "-v" ]; then
    exec "$0.bak" "$@"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"

# Proxy configuration - can be updated without replacing the wrapper
PROXY_ADDR="__PROXY_ADDR_PLACEHOLDER__"
PROXY_PORT="__PROXY_PORT_PLACEHOLDER__"
PROXY_TYPE="__PROXY_TYPE_PLACEHOLDER__"
EXTENSION_BIN_PATH="__EXTENSION_BIN_PATH_PLACEHOLDER__"

# Export standard proxy environment variables alongside mgraftcp --fakedns
export NO_PROXY="localhost,127.0.0.1,::1${NO_PROXY:+,$NO_PROXY}"
export no_proxy="localhost,127.0.0.1,::1${no_proxy:+,$no_proxy}"

if [ "$PROXY_TYPE" = "http" ]; then
    export HTTP_PROXY="http://$PROXY_ADDR"
    export HTTPS_PROXY="http://$PROXY_ADDR"
    export ALL_PROXY="http://$PROXY_ADDR"
    export http_proxy="http://$PROXY_ADDR"
    export https_proxy="http://$PROXY_ADDR"
    export all_proxy="http://$PROXY_ADDR"
elif [ "$PROXY_TYPE" = "socks5" ]; then
    export ALL_PROXY="socks5://$PROXY_ADDR"
    export all_proxy="socks5://$PROXY_ADDR"
fi

# Dynamically find mgraftcp-fakedns and libdnsredir at runtime
find_binaries() {
    local arch=$(uname -m)
    local binary_name=""
    local lib_name=""
    case "$arch" in
        x86_64|amd64) 
            binary_name="mgraftcp-fakedns-linux-amd64"
            lib_name="libdnsredir-linux-amd64.so"
            ;;
        aarch64|arm64) 
            binary_name="mgraftcp-fakedns-linux-arm64"
            lib_name="libdnsredir-linux-arm64.so"
            ;;
        *) return 1 ;;
    esac
    
    # Method 1: Use exact extension path if provided (preferred)
    if [ -n "$EXTENSION_BIN_PATH" ] && [ -d "$EXTENSION_BIN_PATH" ]; then
        if [ -f "$EXTENSION_BIN_PATH/$binary_name" ]; then
            echo "$EXTENSION_BIN_PATH/$binary_name"
            if [ -f "$EXTENSION_BIN_PATH/$lib_name" ]; then
                echo "$EXTENSION_BIN_PATH/$lib_name"
            fi
            return 0
        fi
    fi
    
    # Method 1.5: Check server mgraftcp directory
    for mdir in "$HOME/.antigravity-ide-server/mgraftcp" "$HOME/.antigravity-server/mgraftcp"; do
        if [ -f "$mdir/$binary_name" ]; then
            echo "$mdir/$binary_name"
            if [ -f "$mdir/$lib_name" ]; then
                echo "$mdir/$lib_name"
            fi
            return 0
        fi
    done

    # Method 2: Fallback - search in all versions (sorted by version, newest first)
    # Search in all possible server directories (new name first, then legacy)
    for dir in $(ls -d "$HOME/.antigravity-ide-server/extensions/"*antigravity-ssh-proxy*/resources/bin "$HOME/.antigravity-server/extensions/"*antigravity-ssh-proxy*/resources/bin 2>/dev/null | sort -t'-' -k3 -V -r); do
        if [ -f "$dir/$binary_name" ]; then
            echo "$dir/$binary_name"
            if [ -f "$dir/$lib_name" ]; then
                echo "$dir/$lib_name"
            fi
            return 0
        fi
    done
    return 1
}

# Get both paths
BINARIES=$(find_binaries)
MGRAFTCP_PATH=$(echo "$BINARIES" | head -1)
DNSREDIR_PATH=$(echo "$BINARIES" | tail -1)

if [ -z "$MGRAFTCP_PATH" ] || [ ! -f "$MGRAFTCP_PATH" ]; then
    # Fallback: run without proxy if mgraftcp not found
    exec "$SCRIPT_DIR/$SCRIPT_NAME.bak" "$@"
fi

chmod +x "$MGRAFTCP_PATH" 2>/dev/null || true

# Force Go programs to use cgo DNS resolver (required for LD_PRELOAD to work)
export GODEBUG="${GODEBUG:+$GODEBUG,}netdns=cgo"

# Select proxy argument based on proxy type
if [ "$PROXY_TYPE" = "socks5" ]; then
    exec "$MGRAFTCP_PATH" --socks5 "$PROXY_ADDR" "$SCRIPT_DIR/$SCRIPT_NAME.bak" "$@"
else
    # Default to http proxy
    exec "$MGRAFTCP_PATH" --http_proxy "$PROXY_ADDR" "$SCRIPT_DIR/$SCRIPT_NAME.bak" "$@"
fi
WRAPPER_EOF

    # Replace placeholders with actual values on temp file, then atomically replace target
    sed -i "s|__PROXY_ADDR_PLACEHOLDER__|$PROXY_ADDR|g" "$WRAPPER_TMP"
    sed -i "s|__PROXY_PORT_PLACEHOLDER__|$PROXY_PORT|g" "$WRAPPER_TMP"
    sed -i "s|__PROXY_TYPE_PLACEHOLDER__|$PROXY_TYPE|g" "$WRAPPER_TMP"
    sed -i "s|__EXTENSION_VERSION_PLACEHOLDER__|$EXTENSION_VERSION|g" "$WRAPPER_TMP"
    sed -i "s|__TIMESTAMP_PLACEHOLDER__|$(date -Iseconds)|g" "$WRAPPER_TMP"
    
    # Set extension bin path if provided
    if [ -n "$EXTENSION_PATH" ]; then
        EXTENSION_BIN_DIR="$EXTENSION_PATH/resources/bin"
        sed -i "s|__EXTENSION_BIN_PATH_PLACEHOLDER__|$EXTENSION_BIN_DIR|g" "$WRAPPER_TMP"
    else
        sed -i "s|__EXTENSION_BIN_PATH_PLACEHOLDER__||g" "$WRAPPER_TMP"
    fi

    chmod +x "$WRAPPER_TMP"
    mv -f "$WRAPPER_TMP" "$TARGET"
    sync_agy_version_sidecar "$TARGET"
    info_log "Wrapper created successfully"
    info_log "  Version: $EXTENSION_VERSION"
    info_log "  Proxy: $PROXY_ADDR ($PROXY_TYPE)"
    CONFIGURED_COUNT=$((CONFIGURED_COUNT + 1))

done <<< "$TARGETS"

# ============================================================================
# Step 7: Process Termination (only when wrappers were newly created/updated)
# ============================================================================
if [ $CONFIGURED_COUNT -gt 0 ]; then
    info_log "Terminating running language server and agy processes to apply new wrapper..."
    pkill -f "[l]anguage_server_linux.*\.bak" 2>/dev/null || true
    pkill -f "[l]anguage_server_linux" 2>/dev/null || true
    if [ "${SKIP_AGY_KILL:-0}" != "1" ]; then
        pkill -f "[.]gemini/bin/agy(\.bak)?.*--hub" 2>/dev/null || true
    else
        debug_log "Skipping immediate agy kill (managed by extension host for safe auto-recovery)"
    fi
fi

# ============================================================================
# Summary
# ============================================================================
echo ""
echo "========================================"
echo "Setup Summary"
echo "========================================"
echo "  Extension Version: $EXTENSION_VERSION"
echo "  Proxy Address: $PROXY_ADDR"
echo "  Proxy Type: $PROXY_TYPE"
echo "----------------------------------------"
if [ $CONFIGURED_COUNT -gt 0 ]; then
    echo "  ✅ Configured: $CONFIGURED_COUNT wrapper(s) created/updated"
fi
if [ $SKIPPED_COUNT -gt 0 ]; then
    echo "  ⏭️  Skipped: $SKIPPED_COUNT wrapper(s) already up-to-date"
fi
echo "========================================"

if [ $CONFIGURED_COUNT -gt 0 ]; then
    echo ""
    echo "Setup complete: proxy=$PROXY_ADDR"
    echo "Note: Reload window to apply changes to language server."
elif [ $SKIPPED_COUNT -gt 0 ]; then
    echo ""
    echo "Already configured with $PROXY_ADDR (v$EXTENSION_VERSION)"
else
    echo ""
    error_log "No language servers were configured!"
    exit 1
fi
