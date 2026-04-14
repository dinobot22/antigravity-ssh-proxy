import * as fs from 'fs';
import * as path from 'path';
import { ManagedTargetId, formatTargetAppsEnv } from './targets';

export function generateSetupScript(
    proxyHost: string,
    proxyPort: number,
    proxyType: string,
    extensionPath: string,
    targetApps: readonly ManagedTargetId[],
    extensionVersion: string
): string {
    const scriptPath = path.join(extensionPath, 'scripts', 'setup-proxy.sh');
    let script = fs.readFileSync(scriptPath, 'utf-8');

    // Replace placeholders
    script = script.replace(/__PROXY_HOST__/g, proxyHost);
    script = script.replace(/__PROXY_PORT__/g, String(proxyPort));
    script = script.replace(/__PROXY_TYPE__/g, proxyType);
    script = script.replace(/__EXTENSION_PATH__/g, extensionPath);
    script = script.replace(/__EXTENSION_VERSION__/g, extensionVersion);
    script = script.replace(/__TARGET_APPS__/g, formatTargetAppsEnv(targetApps));

    return script;
}

export function generateRollbackScript(): string {
    return `#!/bin/bash
set -e

# Find all backup files and restore them
BAKS=$(
  {
    find "$HOME/.antigravity-server" -path "*/extensions/antigravity/bin/language_server_linux_*.bak" -type f 2>/dev/null
    find "$HOME/.antigravity-server/extensions" -path "*/openai.chatgpt-*/bin/linux-*/codex.bak" -type f 2>/dev/null
  } | sort -u
)
[ -z "$BAKS" ] && echo "Nothing to rollback" && exit 0

RESTORED=0
while IFS= read -r BAK; do
    [ -z "$BAK" ] && continue
TARGET="\${BAK%.bak}"
    echo "Restoring: $TARGET"
[ -f "$TARGET" ] && rm -f "$TARGET"
mv "$BAK" "$TARGET"
    RESTORED=$((RESTORED + 1))
done <<< "$BAKS"

echo "Rollback complete: $RESTORED file(s) restored"
`;
}
