#!/bin/bash
# Corre el fetch completo y sube los datos a GitHub
set -e

cd /Users/juanbarake/pulso-digital

export PATH="/usr/local/bin:/usr/bin:/bin"

echo "[$(date)] Iniciando fetch..."
/usr/local/bin/node scripts/fetch.js

echo "[$(date)] Subiendo a GitHub..."
/usr/bin/git add docs/data.json
/usr/bin/git diff --staged --quiet || /usr/bin/git commit -m "Datos actualizados $(date '+%Y-%m-%d %H:%M')"
/usr/bin/git push origin main

echo "[$(date)] Listo."
