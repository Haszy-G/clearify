#!/usr/bin/env bash
# Wrap distributions/safari in a native macOS app + Safari web extension via Xcode's
# safari-web-extension-converter. Requires macOS with Xcode 12+ installed.
# The output Xcode project lands in distributions/safari-xcode/.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "error: this script must run on macOS (Xcode's converter is not available elsewhere)" >&2
  exit 1
fi

node "$ROOT/scripts/build.js"

xcrun safari-web-extension-converter "$ROOT/distributions/safari" \
  --project-location "$ROOT/distributions/safari-xcode" \
  --app-name "News Credibility" \
  --bundle-identifier "io.clearify.newscredibility" \
  --swift \
  --macos-only \
  --copy-resources \
  --force \
  --no-open

echo ""
echo "Done. Open distributions/safari-xcode/News Credibility.xcodeproj in Xcode,"
echo "set your development team under Signing & Capabilities, then run."
