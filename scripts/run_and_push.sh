#!/bin/bash
set -e

cd /Users/juanbarake/pulso-digital

export PATH="/usr/local/bin:/usr/bin:/bin"
export GIT_TERMINAL_PROMPT=0

echo "[$(date)] Iniciando fetch..."
/usr/local/bin/node scripts/fetch.js

echo "[$(date)] Subiendo a GitHub..."
/usr/bin/git add docs/data.json docs/history.json
/usr/bin/git diff --staged --quiet || /usr/bin/git commit -m "Datos actualizados $(date -u '+%Y-%m-%d %H:%M UTC')"
/usr/bin/git push origin main

echo "[$(date)] Listo."
