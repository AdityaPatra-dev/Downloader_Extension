#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "📦 Packaging Universal Media & File Downloader..."

# 1. Sync source files into dist/
mkdir -p dist
cp -r background content popup offscreen icons lib dist/
cp manifest.json LICENSE dist/

# 2. Package into zip archive
rm -f Universal-Media-Downloader.zip
cd dist
zip -r ../Universal-Media-Downloader.zip . -x ".*" -x "__MACOSX" > /dev/null
cd ..

echo "✅ Package created successfully: Universal-Media-Downloader.zip ($(du -h Universal-Media-Downloader.zip | cut -f1))"
echo "📂 Unpacked folder ready at: $DIR/dist"

