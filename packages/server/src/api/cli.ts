/**
 * Installing the Underlay CLI: `curl -fsSL <origin>/cli/install.sh | sh`.
 *
 * The CLI is one JavaScript file (`packages/cli`, bundled), served as a static asset at
 * `/cli/underlay.js` with its SHA-256 at `/cli/underlay.js.sha256` (the web build copies
 * both: packages/web/scripts/cli-assets.ts). This route gives the script that fetches it,
 * with this deployment's origin written in, so staging's script installs staging's build.
 * Running it again updates the CLI.
 */
import { Hono } from 'hono'

import type { AppEnv } from '../app.js'

export function installScript(origin: string): string {
  return `#!/bin/sh
# Installs the Underlay CLI from ${origin}: one JavaScript file, run by Node.js 22.6 or later.
# Run it again to update. Read it first if you like: curl -fsSL ${origin}/cli/install.sh
set -eu

ORIGIN="${origin}"
DIR="\${UNDERLAY_CLI_DIR:-$HOME/.local/share/underlay-cli}"
BIN="\${UNDERLAY_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\\n' "$*"; }
fail() { say "underlay: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "the CLI runs on Node.js 22.6 or later, and node is not on your PATH. Get it from https://nodejs.org"
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 6) ? 0 : 1)' \\
  || fail "the CLI needs Node.js 22.6 or later; this is $(node --version)"
command -v curl >/dev/null 2>&1 || fail "curl is needed to download the CLI"

mkdir -p "$DIR" "$BIN"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "Downloading the Underlay CLI from $ORIGIN"
curl -fsSL "$ORIGIN/cli/underlay.js" -o "$TMP/underlay.js" || fail "could not download $ORIGIN/cli/underlay.js"
curl -fsSL "$ORIGIN/cli/underlay.js.sha256" -o "$TMP/underlay.js.sha256" || fail "could not download its checksum"

WANT="$(cut -d' ' -f1 < "$TMP/underlay.js.sha256")"
if command -v shasum >/dev/null 2>&1; then
  HAVE="$(shasum -a 256 "$TMP/underlay.js" | cut -d' ' -f1)"
else
  HAVE="$(sha256sum "$TMP/underlay.js" | cut -d' ' -f1)"
fi
[ "$WANT" = "$HAVE" ] || fail "the download does not match its checksum; nothing was installed"

mv "$TMP/underlay.js" "$DIR/underlay.js"
cat > "$BIN/underlay" <<EOF
#!/bin/sh
exec node "$DIR/underlay.js" "\\$@"
EOF
chmod +x "$BIN/underlay"

say "Installed underlay $(node "$DIR/underlay.js" --version) at $BIN/underlay"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    say ""
    say "$BIN is not on your PATH. Add it, then open a new terminal:"
    say "  echo 'export PATH=\\"$BIN:\\$PATH\\"' >> ~/.zshrc"
    ;;
esac
say ""
say "Next:"
say "  underlay login ${hostOf(origin)}"
say "  underlay init ~/Underlay && cd ~/Underlay"
say "  underlay"
say ""
say "Docs: $ORIGIN/docs/cli"
`
}

/** The address \`underlay login\` takes: the host, without a leading \`www.\`. */
const hostOf = (origin: string) => new URL(origin).host.replace(/^www\./, '')

export function cliRoutes() {
  const app = new Hono<AppEnv>()
  app.get('/cli/install.sh', (c) => {
    const origin = new URL(c.var.config.appUrl).origin
    return c.body(installScript(origin), 200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=300',
    })
  })
  return app
}
