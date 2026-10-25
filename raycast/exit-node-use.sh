#!/bin/bash
# Raycast Script Command: move fly-exit to the chosen region and route this Mac through it.
# @raycast.schemaVersion 1
# @raycast.title Exit Node: Move to Region
# @raycast.mode compact
# @raycast.packageName Fly Exit
# @raycast.icon 🌐
# @raycast.argument1 { "type": "dropdown", "placeholder": "Region", "data": [{"title": "Tokyo", "value": "nrt"}, {"title": "Singapore", "value": "sin"}, {"title": "Sydney", "value": "syd"}, {"title": "London", "value": "lhr"}, {"title": "Frankfurt", "value": "fra"}, {"title": "Amsterdam", "value": "ams"}, {"title": "Virginia", "value": "iad"}, {"title": "San Jose", "value": "sjc"}] }
# @raycast.argument2 { "type": "text", "placeholder": "hours (optional)", "optional": true }
export PATH=/usr/local/bin:/opt/homebrew/bin:$PATH
"$(dirname "$(readlink -f "$0")")/../exit-node" use "$1" "${2:-}" | paste -sd ' ' -
