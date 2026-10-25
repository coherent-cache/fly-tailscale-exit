# flyscale-control

A Cloudflare Worker that moves the Tailscale exit node **fly-exit** between Fly regions. Pick
`fly-exit-…` once as the exit node on each device; after that every region switch is
server-side and those devices follow automatically. Switch from the status page (iPhone and
Mac), the `exit-node` CLI, Raycast, or an optional Apple Shortcut.

## Model

- **One stable Tailscale identity.** `../start.sh` restores tailscaled's state from this Worker
  on every boot and saves it again at startup and shutdown. Whichever region's Machine runs is the
  same device: same IP and same selection on every client. Its name carries the region
  (`fly-exit-ams`, `fly-exit-nrt`, …), so the Tailscale app shows where it is.
- **One Machine per region, at most one running.** Unused Machines stay stopped, which bills only
  their rootfs. A move stops the running Machine, starts (or on first use creates) the target and
  waits for the device to rejoin the tailnet. It takes 15–30 s warm and about a minute on a
  region's first use. Devices using fly-exit lose connectivity during the move.
- **One coordinator, latest click wins.** A Durable Object (`Switcher`) serializes every request
  and also stores the node's identity and last egress. A click records only the wanted target, and
  `/use` answers 202 at once with the request's progress. An alarm loop advances one step per
  invocation (stop → start/create → join) and re-reads the wanted target between steps. A
  different click mid-move re-targets it: the step in flight finishes, a node started for the
  superseded target is stopped, and only one Machine ever runs. Repeating the current choice is a
  no-op and returns the same request. A failed step stops the loop and is reported; the next click
  retries.
- **Off** stops the exit. Devices still set to use it lose internet until they choose "None" in
  Tailscale. Off is the one step that needs the device itself.
- Legacy Hobby: the $7.00/month machine allowance covers this node always on in any region
  alongside `homelab-kuma`.
- Optional `hours` sets Machine metadata `ttl_until`. The `*/10` cron sends an Off through the
  Switcher when it passes.

## Status page

Built with the impeccable design skill (Operate mode): system type, tinted neutrals that follow
the system light/dark setting, and one colour per meaning (green = live, blue = moving, red =
failed).

- The click shows at once: the button spins, and a from → to track opens with a checklist (✓ done,
  spinner current) and an elapsed timer.
- During a move the headline shows the **destination, out of focus**. It sharpens when the node
  actually joins (the one deliberate motion), then the track turns green with "Arrived".
- Re-targeting mid-move says "Changed to X. The current step finishes first."
- Updates: during a move the page polls `/status?live=1` (the coordinator only, about 0.4 s from
  Vietnam) every 0.7 s. When idle it refreshes the full `/status` (Fly and Tailscale, 1–4 s) every
  30 s and right after a move. Every request has a timeout, and an error never replaces the last
  good data or stops the loop: it shows "reconnecting" and retries with backoff (0.7 s up to 4 s).
  Measured on 2026-10-22 over 4 moves: the server takes 7.3–9.2 s (median 8.3) and the page shows
  the result 0.8–1.6 s later. That held through a 6-second network cut.
- Off asks for a second tap. `prefers-reduced-motion` swaps movement for fades.

## Where is it exiting?

- **Tailscale app:** the exit node name, e.g. `fly-exit-ams`.
- **Status page:** the region, the node's public IP and country (reported by the node itself),
  and whether *this device* uses it. A request from Fly's network (AS40509) came through it.
- `exit-node status` or the Raycast "Exit Node" inline item.

**India:** Fly has Mumbai (`bom`), but it refuses Machines from legacy or non-paid plans (checked
2026-10-23), so it is not in `REGIONS`. Use the homelab's **r2** exit node instead (Bangalore home
broadband; see homelab `specs/003-qol-services/runbook.md`). Pick it in Tailscale directly; it is
not part of fly-exit.

## API

| Route | Auth | Effect |
|---|---|---|
| `GET /` | cookie (sign-in form) | Status page; switches directly |
| `GET /status` | Bearer or cookie | Exit region, device, move progress (`progress`: target, phase, from, requested_at, error), this client, usage |
| `GET /status?live=1` | Bearer or cookie | Fast subset from the coordinator: `progress`, `you`, and `exit`/`device` once a move has finished |
| `POST /use?region=ams[&hours=6]` | Bearer, or cookie with same-origin `Origin` | 202; moves fly-exit. The body may be empty, JSON or a form |
| `POST /off` | as `/use` | 202; stops fly-exit |
| `GET`/`POST /node/state?region=` | Bearer `NODE_TOKEN` | Used by the node: fetch or save its identity |

## Secrets

`wrangler.toml` lists them. The macOS keychain holds the operator copies under service
`flyscale-control`: `fly_deploy_token` (app-scoped; it gets 403 on other apps),
`fly_metrics_token` (read-only org), `control_token` and `node_token`. The node gets
`CONTROL_NODE_TOKEN` as a Fly app secret and `CONTROL_URL` from `fly.toml`. Anyone holding
`NODE_TOKEN` can impersonate fly-exit, so treat it like the deploy token.

```sh
cd control && npx wrangler deploy
printf %s "$(security find-generic-password -s flyscale-control -a control_token -w)" | npx wrangler secret put CONTROL_TOKEN
```

## Mac

- `../exit-node use [region] [hours]` (fzf picker without a region), `off`, `status`. `use` also
  points this Mac's exit node at fly-exit.
- Raycast: Settings → Extensions → **+** → Add Script Directory → `fly-tailscale-exit/raycast`.
  This adds *Exit Node: Move to Region*, *Exit Node: Off*, and *Exit Node*, an inline status you
  can add to Favorites.

## iPhone

1. **Once:** in the Tailscale app → Exit Node → choose **fly-exit-…**.
2. Status page: open `https://flyscale-control.crashtestdummy7.workers.dev/` → Share → Add to Home
   Screen. Open the icon and sign in with the token. A Home Screen app keeps its own cookies,
   separate from Safari's. Its buttons move fly-exit, and the phone follows.
3. Optional Shortcut, for Siri, Control Center and the Action button:
   - **Dictionary**: Tokyo `nrt`, Singapore `sin`, Sydney `syd`, London `lhr`, Frankfurt `fra`,
     Amsterdam `ams`, Virginia `iad`, San Jose `sjc` → **Choose from List** → **Get Dictionary
     Value** for *Chosen Item*.
   - **Get Contents of URL**: `https://flyscale-control.crashtestdummy7.workers.dev/use?region=` +
     *Dictionary Value*, method POST, header `Authorization` = `Bearer <token>`.
   - **Show Notification**: "Moving fly-exit to " + *Chosen Item*.

   For Off: **Tailscale → Stop Using Exit Node**, then the same URL action with `/off`.

To get the token onto the iPhone, run
`security find-generic-password -s flyscale-control -a control_token -w | pbcopy` on the Mac and
paste it (Universal Clipboard), or save it in Passwords at sign-in.
