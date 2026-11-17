#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
#  Jinx Harness — CGI entry point (must stay executable: 755)
#
#  Finds a usable Node.js, then hands over to gateway.cjs which boots the
#  daemon if needed and proxies the request.
#
#  Node lookup order:
#    1. bin/node (auto-extracted from node.tar.xz if present)
#    2. $HOME/bin/node
#    3. node in PATH
#    4. CloudLinux alt-nodejs (/opt/alt/alt-nodejs*/v*/bin/node)
#    5. nvm installs
#    6. common system paths
# ═══════════════════════════════════════════════════════════════════════════
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LOG="$DIR/portable/data/logs"
mkdir -p "$LOG" "$DIR/bin" 2>/dev/null

# bundled node binary? (upload node.tar.xz next to this file — see README)
if [ ! -x "$DIR/bin/node" ] && [ -f "$DIR/node.tar.xz" ]; then
  tar -xf "$DIR/node.tar.xz" -C "$DIR/bin" --strip-components=2 >>"$LOG/extract.log" 2>&1
fi
if [ -f "$DIR/bin/node" ]; then
  chmod 755 "$DIR/bin/node" 2>>"$LOG/extract.log"
fi

NODE_BIN=""
for c in \
  "$DIR/bin/node" \
  "$HOME/bin/node" \
  "$(command -v node 2>/dev/null)" \
  /opt/alt/alt-nodejs*/v*/bin/node \
  "$HOME"/.nvm/versions/node/*/bin/node \
  /usr/local/bin/node \
  /usr/bin/node
do
  if [ -n "$c" ] && [ -x "$c" ]; then
    NODE_BIN="$c"
    break
  fi
done

if [ -z "$NODE_BIN" ]; then
  echo "Content-Type: text/html; charset=utf-8"
  echo ""
  if [ -f "$DIR/no-node.html" ]; then
    cat "$DIR/no-node.html"
  else
    echo "<h3>Node.js not found</h3><p>Upload node.tar.xz next to index.cgi (see README.md) or ask your host to enable Node.js.</p>"
  fi
  exit 0
fi

exec "$NODE_BIN" "$DIR/gateway.cjs"
