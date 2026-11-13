#!/usr/bin/env bash
# Syntax-checks every application module. The app runs directly from source
# on Node.js (npm start); there is no bundle or hosting artifact to produce.
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$project_root"

for file in worker/*.js scripts/*.mjs test/*.js; do
  node --check "$file"
done

echo "Build check passed: all modules parse."
