#!/usr/bin/env bash
set -euo pipefail

APP="flyscale-exit"
MAX_NODES=3
KEYCHAIN_SERVICE="flyscale-exit"

usage() {
    cat <<EOF
Usage: ./launch.sh [command]

Commands:
  (default)  Launch a new exit node in a region you pick via fzf.
             If MAX_NODES (=$MAX_NODES) are already running, you'll pick which to evict.
  list       Show currently running exit nodes
  stop       Pick a node to stop (destroys the machine)
  stop-all   Destroy all running machines
  purge      Delete offline fly- entries from your Tailscale admin
             (requires Tailscale OAuth credentials in macOS keychain under
              service '$KEYCHAIN_SERVICE', accounts: client_id, client_secret)

EOF
    exit 1
}

# Read Tailscale OAuth credentials from macOS keychain.
# Falls back to env vars TS_CLIENT_ID / TS_CLIENT_SECRET if keychain is unavailable.
get_ts_token() {
    local cid csecret
    if command -v security &>/dev/null; then
        cid=$(security find-generic-password -a "client_id" -s "$KEYCHAIN_SERVICE" -w 2>/dev/null || true)
        csecret=$(security find-generic-password -a "client_secret" -s "$KEYCHAIN_SERVICE" -w 2>/dev/null || true)
    fi
    : "${cid:=${TS_CLIENT_ID:-}}"
    : "${csecret:=${TS_CLIENT_SECRET:-}}"
    if [ -z "$cid" ] || [ -z "$csecret" ]; then
        echo "Tailscale OAuth credentials not found." >&2
        echo "Store them with:" >&2
        echo "  security add-generic-password -a client_id -s $KEYCHAIN_SERVICE -w <id>" >&2
        echo "  security add-generic-password -a client_secret -s $KEYCHAIN_SERVICE -w <secret>" >&2
        return 1
    fi
    curl -sS -d "client_id=$cid&client_secret=$csecret" \
        https://api.tailscale.com/api/v2/oauth/token \
        | python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))"
}

require_cmds() {
    for cmd in fly fzf python3; do
        if ! command -v "$cmd" &>/dev/null; then
            echo "Error: '$cmd' is required but not installed."
            exit 1
        fi
    done
}

# Returns lines of: "<id>\t<region>\t<created_at>" sorted oldest-first, only started/stopped machines.
list_machines() {
    fly machines list -a "$APP" --json 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
machines = [m for m in data if m.get('state') in ('started', 'stopped')]
machines.sort(key=lambda m: m.get('created_at', ''))
for m in machines:
    print(f\"{m['id']}\t{m['region']}\t{m.get('created_at','')}\t{m.get('state','')}\")
"
}

# Pick a region using fzf
pick_region() {
    fly platform regions 2>/dev/null \
        | grep -E '│ [a-z]{3}' \
        | sed 's/^ *//' \
        | fzf --height=~30 --reverse --prompt="Region: " \
        | awk -F'│' '{gsub(/[ \t]+/,"",$2); print $2}'
}

# Pick a machine to evict using fzf (input piped in)
pick_machine() {
    fzf --height=~30 --reverse --prompt="Evict: " --header="$1" \
        | awk '{print $1}'
}

destroy_machine() {
    local id="$1"
    echo "Stopping $id (sends SIGINT, allowing tailscale logout to run)..."
    fly machine stop "$id" -a "$APP" 2>&1 | sed 's/^/  /' || true
    # Give the cleanup trap time to run before we destroy
    sleep 3
    echo "Destroying $id..."
    fly machine destroy "$id" -a "$APP" --force 2>&1 | sed 's/^/  /'
}

cmd_list() {
    machines=$(list_machines)
    if [ -z "$machines" ]; then
        echo "No exit nodes are currently running."
        return 0
    fi
    printf "%-16s %-8s %-12s %s\n" "ID" "REGION" "STATE" "CREATED"
    echo "$machines" | while IFS=$'\t' read -r id region created state; do
        printf "%-16s %-8s %-12s %s\n" "$id" "$region" "$state" "$created"
    done
}

cmd_stop() {
    machines=$(list_machines)
    if [ -z "$machines" ]; then
        echo "No exit nodes are running."
        return 0
    fi
    fmt=$(echo "$machines" | awk -F'\t' '{printf "%s\t%s\t%s\n", $1, $2, $3}' | column -t)
    target=$(echo "$fmt" | pick_machine "Pick a node to stop")
    if [ -z "$target" ]; then
        echo "No node selected."
        return 1
    fi
    destroy_machine "$target"
}

cmd_purge() {
    local token
    token=$(get_ts_token) || return 1
    if [ -z "$token" ]; then
        echo "Failed to get Tailscale OAuth token." >&2
        return 1
    fi
    echo "Listing offline fly- devices..."
    curl -sS -H "Authorization: Bearer $token" \
        https://api.tailscale.com/api/v2/tailnet/-/devices \
        | python3 -c "
import json, sys
data = json.load(sys.stdin)
for d in data.get('devices', []):
    if d.get('hostname','').startswith('fly-') and not d.get('online'):
        print(d['id'], d.get('hostname'))
" | while read -r id name; do
        echo "Deleting $name ($id)..."
        status=$(curl -sS -o /dev/null -w "%{http_code}" -X DELETE \
            -H "Authorization: Bearer $token" \
            "https://api.tailscale.com/api/v2/device/$id")
        echo "  HTTP $status"
    done
    echo "Purge complete."
}

cmd_stop_all() {
    machines=$(list_machines)
    if [ -z "$machines" ]; then
        echo "No exit nodes are running."
        return 0
    fi
    echo "$machines" | awk -F'\t' '{print $1}' | while read -r id; do
        destroy_machine "$id"
    done
}

cmd_launch() {
    region=$(pick_region)
    if [ -z "$region" ]; then
        echo "No region selected."
        exit 1
    fi
    echo "Selected region: $region"

    machines=$(list_machines)
    machine_count=0
    [ -n "$machines" ] && machine_count=$(echo "$machines" | wc -l | tr -d ' ')

    # Already have a node in this region?
    if [ -n "$machines" ] && echo "$machines" | awk -F'\t' '{print $2}' | grep -qx "$region"; then
        existing=$(echo "$machines" | awk -F'\t' -v r="$region" '$2==r {print $1; exit}')
        echo "A node already exists in $region ($existing). Nothing to do."
        exit 0
    fi

    # Need to evict?
    if [ "$machine_count" -ge "$MAX_NODES" ]; then
        echo "Already running $machine_count nodes (limit: $MAX_NODES). Need to evict one."
        echo ""
        # Default to oldest (first row, since sorted by created_at ascending)
        oldest=$(echo "$machines" | head -1 | awk -F'\t' '{printf "%s (%s, oldest)\n", $1, $2}')
        # Build picker with oldest as the default-highlighted line
        fmt=$(echo "$machines" | awk -F'\t' 'NR==1 {printf "%s  %s  %s  (oldest, default)\n", $1, $2, $3; next} {printf "%s  %s  %s\n", $1, $2, $3}')
        target=$(echo "$fmt" | pick_machine "Pick a node to evict (Enter on top = oldest)")
        if [ -z "$target" ]; then
            echo "No selection. Aborting."
            exit 1
        fi
        destroy_machine "$target"
        # Wait a bit so fly's machine count is correct before we add a new one
        sleep 2
    fi

    # Either deploy fresh, or clone an existing machine into the new region
    machines=$(list_machines)
    if [ -z "$machines" ]; then
        echo "No existing machines — deploying fresh to $region..."
        fly deploy --strategy immediate -y -a "$APP" --primary-region "$region"
        # Fly defaults to 2 machines for HA; force down to 1
        echo "Scaling to exactly 1 machine..."
        fly scale count 1 -a "$APP" -y 2>&1 | sed 's/^/  /'
    else
        # Clone the most-recent existing machine into the new region
        source_id=$(echo "$machines" | tail -1 | awk -F'\t' '{print $1}')
        echo "Cloning $source_id into $region..."
        fly machine clone "$source_id" -a "$APP" --region "$region" 2>&1 | sed 's/^/  /'
    fi

    echo ""
    echo "Done. Current nodes:"
    cmd_list
}

# --- main ---
require_cmds

case "${1:-launch}" in
    launch)   cmd_launch ;;
    list)     cmd_list ;;
    stop)     cmd_stop ;;
    stop-all) cmd_stop_all ;;
    purge)    cmd_purge ;;
    -h|--help|help) usage ;;
    *)        echo "Unknown command: $1"; usage ;;
esac
