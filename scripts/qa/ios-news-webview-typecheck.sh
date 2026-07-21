#!/bin/zsh
set -euo pipefail

qa_tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/kbo-news-webview-swift.XXXXXX")
trap 'rm -rf "$qa_tmp_dir"' EXIT

swiftc=(xcrun --sdk iphonesimulator swiftc -target arm64-apple-ios15.0-simulator)
"${swiftc[@]}" \
  -emit-module \
  -module-name Capacitor \
  -emit-module-path "$qa_tmp_dir/Capacitor.swiftmodule" \
  scripts/qa/fixtures/CapacitorStub.swift
"${swiftc[@]}" \
  -typecheck \
  -I "$qa_tmp_dir" \
  ios/App/App/NewsArticleBrowserPlugin.swift

echo "iOS news WebView Swift typecheck: PASS"

