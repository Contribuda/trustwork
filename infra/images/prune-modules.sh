#!/bin/sh
# Image build helper (OPS-002): removes documentation, tests, TypeScript sources and declarations, source maps and
# build configuration from a production node_modules tree. Node never loads .ts files from node_modules, so removing
# them cannot change behaviour. Licence and notice files are kept (the images redistribute these packages).
#   sh prune-modules.sh <node_modules directory>
set -eu
dir="$1"
find "$dir" -type d \( -name test -o -name tests -o -name __tests__ -o -name spec -o -name .github -o -name example -o -name examples \) -prune -exec rm -rf {} +
find "$dir" -type f \( -iname 'README*' -o -iname 'CHANGELOG*' -o -iname 'HISTORY*' -o -iname '*.md' -o -iname '*.markdown' \
  -o -name '*.test.*' -o -name '*.spec.*' -o -name '*.map' -o -name '*.ts' -o -name '*.mts' -o -name '*.cts' -o -name '*.tsx' \
  -o -name '*.tsbuildinfo' -o -name 'tsconfig*.json' \) \
  ! -iname 'LICEN[CS]E*' ! -iname 'NOTICE*' -delete
