#!/usr/bin/env sh
# Tailscale exit node on Fly. One stable tailnet identity moves between regions: tailscaled's
# state lives in the flyscale-control Worker ($CONTROL_URL) and is restored on every boot, so
# clients keep the same exit node selected while the Worker moves it. The device name carries
# the region (fly-exit-<region>). Never `tailscale logout` here: that would destroy the identity.

echo 'Starting up...'

# error: adding [-i tailscale0 -j MARK --set-mark 0x40000] in v4/filter/ts-forward: running [/sbin/iptables -t filter -A ts-forward -i tailscale0 -j MARK --set-mark 0x40000 --wait]: exit status 2: iptables v1.8.6 (legacy): unknown option "--set-mark"
modprobe xt_mark

echo 'net.ipv4.ip_forward = 1' | tee -a /etc/sysctl.conf
echo 'net.ipv6.conf.all.forwarding = 1' | tee -a /etc/sysctl.conf
sysctl -p /etc/sysctl.conf

iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
ip6tables -t nat -A POSTROUTING -o eth0 -j MASQUERADE

STATE=/var/lib/tailscale/tailscaled.state
AUTH="Authorization: Bearer ${CONTROL_NODE_TOKEN}"

save_state() { # also reports this node's region and public egress to the Worker
  wget -q -O /dev/null --header "$AUTH" --header "Content-Type: application/json" \
    --post-file="$STATE" "${CONTROL_URL}/node/state?region=${FLY_REGION}"
}

# Decide before tailscaled starts: it creates the state file itself.
RESTORED=0
if wget -q -O "$STATE" --header "$AUTH" "${CONTROL_URL}/node/state"; then
  RESTORED=1
  echo "Restored stable identity"
else
  rm -f "$STATE"
  echo "No stored identity: registering a new one"
fi

/app/tailscaled --verbose=1 --port 41641 --state="$STATE" &
TAILSCALED_PID=$!
i=0
until /app/tailscale status --json >/dev/null 2>&1 || [ $i -ge 60 ]; do i=$((i + 1)); sleep 0.5; done

register() { # mint a single-use, preauthorized, NON-ephemeral key: ephemeral nodes vanish offline
  TOKEN=$(wget -q -O - --header="Content-Type: application/x-www-form-urlencoded" \
    --post-data="client_id=${TAILSCALE_OAUTH_CLIENT_ID}&client_secret=${TAILSCALE_OAUTH_SECRET}" \
    https://api.tailscale.com/api/v2/oauth/token | grep -o '"access_token":"[^"]*' | cut -d'"' -f4)
  [ -n "$TOKEN" ] || { echo "Failed to get access token from Tailscale API"; exit 1; }
  AUTH_KEY=$(wget -q -O - --header="Content-Type: application/json" --header="Authorization: Bearer ${TOKEN}" \
    --post-data='{"capabilities":{"devices":{"create":{"reusable":false,"ephemeral":false,"preauthorized":true,"tags":["tag:fly-exit"]}}}}' \
    https://api.tailscale.com/api/v2/tailnet/-/keys | grep -o '"key":"[^"]*' | cut -d'"' -f4)
  [ -n "$AUTH_KEY" ] || { echo "Failed to generate auth key from Tailscale API"; exit 1; }
  /app/tailscale up --auth-key="$AUTH_KEY" --force-reauth "$@" || exit 1
}

set -- --reset --hostname="fly-exit-${FLY_REGION}" --advertise-exit-node --advertise-tags=tag:fly-exit
# A restored identity that cannot come up (e.g. deleted in the admin console) is replaced.
if [ "$RESTORED" = 1 ] && /app/tailscale up --timeout=30s "$@"; then
  echo "Stable identity is up"
else
  register "$@"
fi
save_state && echo "Stable identity saved" || echo "WARNING: could not save identity to ${CONTROL_URL}"

cleanup() {
  echo "Shutting down: saving identity, leaving it registered..."
  save_state
  kill "$TAILSCALED_PID" 2>/dev/null
}
trap cleanup INT TERM

echo "Tailscale started. Let's go!"
sleep infinity &
wait $!
