#!/usr/bin/env bash

set -euo pipefail

counts_file="${1:-node_modules/download-counts/counts.json}"

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required but not installed." >&2
  exit 1
fi

if [[ ! -f "$counts_file" ]]; then
  echo "Error: counts file not found: $counts_file" >&2
  exit 1
fi

jq -r '
  to_entries[]
  | [.key, (.value | tostring)]
  | @tsv
' "$counts_file" | sort -t $'\t' -k2,2nr -k1,1 | awk -F '\t' '{ print $1, $2 }'
