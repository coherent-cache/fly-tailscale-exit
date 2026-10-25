#!/bin/bash
# Raycast Script Command: inline status; add it to Favorites to keep it refreshed in Raycast root.
# @raycast.schemaVersion 1
# @raycast.title Exit Node
# @raycast.mode inline
# @raycast.refreshTime 5m
# @raycast.packageName Fly Exit
# @raycast.icon 🛰️
export PATH=/usr/local/bin:/opt/homebrew/bin:$PATH
out=$("$(dirname "$(readlink -f "$0")")/../exit-node" status)
echo "$(head -1 <<<"$out" | sed -E 's/  +.*//') · $(grep '^This Mac:' <<<"$out" | sed 's/^This Mac: *//')"
