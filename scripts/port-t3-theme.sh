#!/usr/bin/env bash
set -euo pipefail
checkout=${1:?usage: scripts/port-t3-theme.sh <t3code-checkout>}
commit=$(git -C "$checkout" describe --tags --always)
{
  echo "/* Copied verbatim from pingdotgg/t3code $commit apps/web/src/index.css (MIT). */"
  cat "$checkout/apps/web/src/index.css"
} > src/t3-theme.css
