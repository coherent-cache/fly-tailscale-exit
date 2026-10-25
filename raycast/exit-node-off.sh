#!/bin/bash
# Raycast Script Command: stop routing through Fly and stop every exit node.
# @raycast.schemaVersion 1
# @raycast.title Exit Node: Off
# @raycast.mode compact
# @raycast.packageName Fly Exit
# @raycast.icon ⏹️
export PATH=/usr/local/bin:/opt/homebrew/bin:$PATH
"$(dirname "$(readlink -f "$0")")/../exit-node" off | paste -sd ' ' -
