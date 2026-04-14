#!/bin/bash
set -e

# ============================================================================
# Antigravity SSH Proxy - Setup Script
# ============================================================================
# This script creates wrapper scripts for remote AI tool binaries to route
# their traffic through a proxy using mgraftcp-fakedns.
#
# Environment Variables:
#   PROXY_HOST       - Proxy server host (default: __PROXY_HOST__)
#   PROXY_PORT       - Proxy server port (default: __PROXY_PORT__)
#   PROXY_TYPE       - Proxy type: http or socks5 (default: __PROXY_TYPE__)
#   EXTENSION_PATH   - Current extension's exact path (optional)
#   TARGET_APPS      - Comma-separated managed targets: antigravity,codex
#   EXTENSION_VERSION - Current extension version for update detection
#   DEBUG            - Set to 1 for verbose output
# ============================================================================

# Use environment variables with defaults
PROXY_HOST="${PROXY_HOST:-__PROXY_HOST__}"
PROXY_PORT="${PROXY_PORT:-__PROXY_PORT__}"
PROXY_TYPE="${PROXY_TYPE:-__PROXY_TYPE__}"
EXTENSION_PATH="${EXTENSION_PATH:-__EXTENSION_PATH__}"
TARGET_APPS="${TARGET_APPS:-__TARGET_APPS__}"
EXTENSION_VERSION="${EXTENSION_VERSION:-__EXTENSION_VERSION__}"
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
info_log "Managed Targets: $TARGET_APPS"
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
# Scan for extension directories (for debugging)
# ============================================================================
if [ "$DEBUG" = "1" ]; then
    echo ""
    echo "[SCAN] Searching for extension directories..."
    EXT_DIRS=$(ls -d "$HOME/.antigravity-server/extensions/"*antigravity-ssh-proxy* 2>/dev/null | sort -t'-' -k3 -V -r || echo "")
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

# Check if target is a wrapper script (bash script)
is_wrapper_script() {
    local target="$1"
    head -1 "$target" 2>/dev/null | grep -q "^#!/bin/bash"
}

is_target_enabled() {
    local target="$1"
    [[ ",$TARGET_APPS," == *",$target,"* ]]
}

describe_target() {
    local target="$1"
    case "$target" in
        antigravity) echo "Antigravity Language Server" ;;
        codex) echo "OpenAI Codex CLI" ;;
        *) echo "$target" ;;
    esac
}

collect_targets() {
    if is_target_enabled "antigravity"; then
        find "$HOME/.antigravity-server/bin" \
            -path "*/extensions/antigravity/bin/language_server_linux_*" \
            -type f 2>/dev/null | grep -v ".bak$" | while IFS= read -r target; do
            [ -n "$target" ] && printf 'antigravity\t%s\n' "$target"
        done
    fi

    if is_target_enabled "codex"; then
        find "$HOME/.antigravity-server/extensions" \
            -path "*/openai.chatgpt-*/bin/linux-*/codex" \
            -type f 2>/dev/null | grep -v ".bak$" | while IFS= read -r target; do
            [ -n "$target" ] && printf 'codex\t%s\n' "$target"
        done
    fi
}

# Determine if wrapper needs to be updated
# Returns: 0 = needs update (with reason in stdout), 1 = up-to-date
check_needs_update() {
    local target="$1"
    
    # Check 1: Not a wrapper script (original binary) → needs wrapper creation
    if ! is_wrapper_script "$target"; then
        echo "new_install"
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
# Find Managed Targets
# ============================================================================
echo "[SEARCH] Looking for managed targets..."
TARGETS=$(collect_targets)

if [ -z "$TARGETS" ]; then
    error_log "No managed targets found!"
    exit 1
fi

TARGET_COUNT=$(echo "$TARGETS" | wc -l)
info_log "Found $TARGET_COUNT managed target(s)"
echo ""

# ============================================================================
# Process Each Managed Target
# ============================================================================
CONFIGURED_COUNT=0
SKIPPED_COUNT=0

echo "[PROCESS] Configuring managed targets..."
echo ""

while IFS= read -r TARGET; do
    [ -z "$TARGET" ] && continue

    TARGET_KIND=$(printf '%s' "$TARGET" | cut -f1)
    TARGET_PATH=$(printf '%s' "$TARGET" | cut -f2-)
    TARGET_LABEL=$(describe_target "$TARGET_KIND")
    
    echo "----------------------------------------"
    echo "Target: $TARGET_LABEL"
    echo "Path: $TARGET_PATH"
    BAK="${TARGET_PATH}.bak"
    
    # Check if update is needed
    if UPDATE_REASON=$(check_needs_update "$TARGET_PATH"); then
        info_log "Update needed: $UPDATE_REASON"
        
        # Log current wrapper state for debugging
        if is_wrapper_script "$TARGET_PATH"; then
            debug_log "Current wrapper state:"
            debug_log "  Version: $(get_wrapper_version "$TARGET_PATH")"
            debug_log "  Proxy: $(get_wrapper_proxy_addr "$TARGET_PATH")"
            debug_log "  Type: $(get_wrapper_proxy_type "$TARGET_PATH")"
        fi
    else
        # Already up-to-date
        info_log "Already up-to-date (v$EXTENSION_VERSION, $PROXY_ADDR, $PROXY_TYPE)"
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        continue
    fi

    # Create backup if needed
    if [ ! -f "$BAK" ]; then
        if is_wrapper_script "$TARGET_PATH"; then
            error_log "Target is a wrapper script but no backup exists!"
            error_log "Cannot proceed without original binary backup"
            continue
        fi
        mv "$TARGET_PATH" "$BAK"
        info_log "Backup created: $BAK"
    else
        debug_log "Backup already exists: $BAK"
    fi

    # ========================================================================
    # Create Wrapper Script
    # ========================================================================
    # The wrapper script dynamically finds mgraftcp-fakedns at runtime,
    # allowing version upgrades without breaking existing wrappers.
    # ========================================================================
cat > "$TARGET_PATH" << 'WRAPPER_EOF'
#!/bin/bash
# ============================================================================
# Antigravity SSH Proxy - Managed Tool Wrapper
# ============================================================================
# WRAPPER_VERSION="__EXTENSION_VERSION_PLACEHOLDER__"
# WRAPPED_TARGET="__WRAPPED_TARGET_PLACEHOLDER__"
# GENERATED="__TIMESTAMP_PLACEHOLDER__"
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"

# Proxy configuration - can be updated without replacing the wrapper
PROXY_ADDR="__PROXY_ADDR_PLACEHOLDER__"
PROXY_TYPE="__PROXY_TYPE_PLACEHOLDER__"
EXTENSION_BIN_PATH="__EXTENSION_BIN_PATH_PLACEHOLDER__"

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
    
    # Method 2: Fallback - search in all versions (sorted by version, newest first)
    for dir in $(ls -d "$HOME/.antigravity-server/extensions/"*antigravity-ssh-proxy*/resources/bin 2>/dev/null | sort -t'-' -k3 -V -r); do
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

    # Replace placeholders with actual values
    sed -i "s|__PROXY_ADDR_PLACEHOLDER__|$PROXY_ADDR|g" "$TARGET_PATH"
    sed -i "s|__PROXY_TYPE_PLACEHOLDER__|$PROXY_TYPE|g" "$TARGET_PATH"
    sed -i "s|__EXTENSION_VERSION_PLACEHOLDER__|$EXTENSION_VERSION|g" "$TARGET_PATH"
    sed -i "s|__WRAPPED_TARGET_PLACEHOLDER__|$TARGET_KIND|g" "$TARGET_PATH"
    sed -i "s|__TIMESTAMP_PLACEHOLDER__|$(date -Iseconds)|g" "$TARGET_PATH"
    
    # Set extension bin path if provided
    if [ -n "$EXTENSION_PATH" ]; then
        EXTENSION_BIN_DIR="$EXTENSION_PATH/resources/bin"
        sed -i "s|__EXTENSION_BIN_PATH_PLACEHOLDER__|$EXTENSION_BIN_DIR|g" "$TARGET_PATH"
    else
        sed -i "s|__EXTENSION_BIN_PATH_PLACEHOLDER__||g" "$TARGET_PATH"
    fi

    chmod +x "$TARGET_PATH"
    info_log "Wrapper created successfully"
    info_log "  Target: $TARGET_LABEL"
    info_log "  Version: $EXTENSION_VERSION"
    info_log "  Proxy: $PROXY_ADDR ($PROXY_TYPE)"
    CONFIGURED_COUNT=$((CONFIGURED_COUNT + 1))

done <<< "$TARGETS"

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
    echo "Note: Reload window to apply changes to managed tools."
elif [ $SKIPPED_COUNT -gt 0 ]; then
    echo ""
    echo "Already configured with $PROXY_ADDR (v$EXTENSION_VERSION)"
else
    echo ""
    error_log "No managed targets were configured!"
    exit 1
fi
