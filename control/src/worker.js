// flyscale-control: move the Fly-hosted Tailscale exit node ("fly-exit") between regions.
//
// One stable tailnet identity. start.sh restores tailscaled's state from this Worker on every
// boot, so whichever region's Machine runs is the same Tailscale device: same IP, same selection
// on every client. Its name carries the region (fly-exit-<region>). Devices pick fly-exit once;
// after that a region switch is entirely server-side.
//
// Switching is owned by one Durable Object (Switcher), which serializes every request. A click
// only records the wanted target ("latest wins"); an alarm-driven loop advances one step per
// invocation (stop the old Machine, start or create the target, wait for the tailnet) and
// re-reads the wanted target between steps. Each step gets a fresh subrequest budget, and the
// state is strongly consistent wherever the client connects from. The DO also stores the node's
// identity and last reported egress.
//
// Credentials: FLY_API_TOKEN (app-scoped deploy token); TS_CLIENT_ID/SECRET (the node's own
// OAuth client, which the deploy token can already reach through app secrets); NODE_TOKEN
// (shared with the node; guards the stored identity); CONTROL_TOKEN (clients: move and stop).

import { DurableObject } from "cloudflare:workers";

const API = "https://api.machines.dev/v1";
const RUNNING = new Set(["started", "starting", "replacing"]);
const FLY_ASN = 40509; // a request arriving from Fly's network came through the exit node
const GIVE_UP_MS = 180_000;
// Legacy Hobby egress allowance per region group, GB/month (docs.fly.io/about/discontinued-plans).
const EGRESS_ALLOWANCE_GB = { "na-eu": 100, "apac-sa": 30, "africa-india": 30 };

// ---- auth ----------------------------------------------------------------------------------
// Bearer CONTROL_TOKEN: everything. The `fc` cookie (set by the sign-in form, so the token never
// appears in a URL): the page and /status, plus /use and /off when the request's Origin is this
// Worker (a same-origin fetch from the page; SameSite=Lax also blocks cross-site POSTs).
function bearer(req) {
  const h = req.headers.get("authorization") || "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
}
function cookie(req) {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)fc=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}
function eq(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Fly Machines API ----------------------------------------------------------------------
async function fly(env, method, path, body) {
  const send = () => fetch(`${API}/apps/${env.FLY_APP}${path}`, {
    method,
    headers: { authorization: env.FLY_API_TOKEN, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let res = await send();
  // Fly's edge intermittently answers 520/502/503; GETs are safe to repeat once.
  if (method === "GET" && res.status >= 500) { await sleep(750); res = await send(); }
  const text = await res.text();
  if (!res.ok) throw new HttpError(502, `fly ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const regions = (env) => JSON.parse(env.REGIONS);
const listMachines = async (env) => (await fly(env, "GET", "/machines")).filter((m) => m.state !== "destroyed");

// ---- Tailscale API (the node's OAuth client: devices:core) --------------------------------
let tsToken = { value: "", exp: 0 }; // per-isolate cache: each invocation allows 50 subrequests
async function tailscale(env, method, path) {
  if (Date.now() > tsToken.exp) {
    const tok = await fetch("https://api.tailscale.com/api/v2/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.TS_CLIENT_ID, client_secret: env.TS_CLIENT_SECRET }),
    });
    if (!tok.ok) throw new HttpError(502, `tailscale oauth: ${tok.status}`);
    const j = await tok.json();
    tsToken = { value: j.access_token, exp: Date.now() + (j.expires_in - 300) * 1000 };
  }
  const res = await fetch(`https://api.tailscale.com/api/v2${path}`, { method, headers: { authorization: `Bearer ${tsToken.value}` } });
  if (!res.ok) throw new HttpError(502, `tailscale ${method} ${path}: ${res.status}`);
  return method === "GET" ? res.json() : null;
}
const flyDevices = async (env) =>
  (await tailscale(env, "GET", "/tailnet/-/devices?fields=all")).devices.filter((d) => (d.tags || []).includes("tag:fly-exit"));
// The stable identity is the one non-ephemeral fly-exit device.
const stableDevice = (devices) => devices.find((d) => !d.isEphemeral);

// Offline EPHEMERAL fly-exit devices are leftovers of the old per-region nodes or of crashes.
// Never delete the stable device: it is offline whenever the exit is off.
async function purgeOffline(env) {
  for (const d of await flyDevices(env)) {
    if (d.isEphemeral && !d.connectedToControl) await tailscale(env, "DELETE", `/device/${d.id}`);
  }
}

// ---- Switcher: the single coordinator ------------------------------------------------------
// Storage keys: want {target, hours, at}  (written only by requests)
//               progress {for, from, phase, phase_region, failed_phase, created, started_at,
//                         finished_at, error}  (written only by the alarm loop)
// Phases: queued → stopping → creating|starting → joining → done, or error.
export class Switcher extends DurableObject {
  async fetch(req) {
    const url = new URL(req.url);
    const st = this.ctx.storage;
    if (url.pathname === "/want") {
      const { target, hours = null } = await req.json();
      const want = await st.get("want");
      const progress = await st.get("progress");
      const failed = progress?.for === want?.at && progress?.phase === "error";
      // Same choice again (double click, repeated Siri run) while not failed: nothing to do.
      if (!want || want.target !== target || want.hours !== hours || failed) {
        await st.put("want", { target, hours, at: Date.now() });
        await st.setAlarm(Date.now());
      }
      return Response.json(await this.view());
    }
    if (url.pathname === "/progress") return Response.json(await this.view());
    // Everything the page needs while a move runs, from storage alone (no upstream calls).
    if (url.pathname === "/live") {
      return Response.json({ progress: await this.view(), exit: (await st.get("exit")) ?? null, seen: (await st.get("node:seen")) ?? null });
    }
    if (url.pathname === "/node/state") {
      if (req.method === "GET") {
        const s = await st.get("node:state");
        return s ? new Response(s, { headers: { "content-type": "application/json" } }) : new Response("no state\n", { status: 404 });
      }
      await st.put("node:state", await req.text());
      const seen = req.headers.get("x-seen");
      if (seen) await st.put("node:seen", JSON.parse(seen));
      return new Response("saved\n");
    }
    if (url.pathname === "/node/seen") return Response.json((await st.get("node:seen")) ?? null);
    return new Response("not found\n", { status: 404 });
  }

  async view() {
    const st = this.ctx.storage;
    const want = await st.get("want");
    if (!want) return { target: null, phase: "idle" };
    const p = await st.get("progress");
    const mine = p?.for === want.at;
    return {
      now: Date.now(), target: want.target, hours: want.hours, requested_at: want.at,
      phase: mine ? p.phase : "queued",
      from: mine ? p.from : null,
      phase_region: mine ? p.phase_region : null,
      failed_phase: mine ? p.failed_phase ?? null : null,
      created: mine ? Boolean(p.created) : false,
      started_at: mine ? p.started_at : null,
      finished_at: mine ? p.finished_at ?? null : null,
      error: mine ? p.error ?? null : null,
    };
  }

  // One step per invocation; a step that leaves work behind schedules the next one.
  async alarm() {
    const st = this.ctx.storage;
    const env = this.env;
    const want = await st.get("want");
    if (!want) return;
    let p = await st.get("progress");
    if (p?.for === want.at && (p.phase === "done" || p.phase === "error")) return;
    const set = async (patch) => { p = { ...p, ...patch }; await st.put("progress", p); };
    const next = () => st.setAlarm(Date.now());
    try {
      const machines = await listMachines(env);
      const running = machines.filter((m) => RUNNING.has(m.state));
      if (p?.for !== want.at) {
        const from = running.find((m) => m.region !== want.target)?.region ?? null;
        p = { for: want.at, from, phase: "queued", started_at: Date.now() };
        await st.put("progress", p);
      }
      if (Date.now() - p.started_at > GIVE_UP_MS) throw new Error("gave up after 3 minutes");

      const wrong = running.find((m) => m.region !== want.target);
      if (wrong) {
        await set({ phase: "stopping", phase_region: wrong.region });
        await fly(env, "POST", `/machines/${wrong.id}/stop`);
        await fly(env, "GET", `/machines/${wrong.id}/wait?state=stopped&timeout=60`);
        return void (await next());
      }
      if (want.target === "off") {
        await st.put("exit", { region: null, at: Date.now() });
        return void (await set({ phase: "done", phase_region: null, finished_at: Date.now() }));
      }

      let target = machines.find((m) => m.region === want.target);
      if (!target) {
        if (!machines[0]) throw new Error("no template Machine; run `fly deploy` once");
        await set({ phase: "creating", phase_region: want.target, created: true });
        const config = structuredClone(machines[0].config);
        delete config.metadata?.ttl_until;
        target = await fly(env, "POST", "/machines", { region: want.target, config });
        await fly(env, "GET", `/machines/${target.id}/wait?state=started&timeout=60`);
        return void (await next());
      }
      if (!RUNNING.has(target.state)) {
        await set({ phase: "starting", phase_region: want.target });
        await fly(env, "POST", `/machines/${target.id}/start`);
        await fly(env, "GET", `/machines/${target.id}/wait?state=started&timeout=60`);
        return void (await next());
      }

      if (p.phase !== "joining") await set({ phase: "joining", phase_region: want.target });
      for (let i = 0; i < 25; i++) {
        if ((await st.get("want")).at !== want.at) return void (await next()); // re-targeted
        const d = stableDevice(await flyDevices(env));
        if (d?.connectedToControl && d.hostname === `fly-exit-${want.target}`) {
          // Mark arrival first: the bookkeeping below must not delay what clients see.
          await st.put("exit", { region: want.target, device: { name: d.name.split(".")[0], ip: d.addresses.find((a) => a.includes(".")) }, at: Date.now() });
          await set({ phase: "done", finished_at: Date.now() });
          if (want.hours) await fly(env, "POST", `/machines/${target.id}/metadata/ttl_until`, { value: String(Math.floor(Date.now() / 1000 + want.hours * 3600)) });
          else if (target.config?.metadata?.ttl_until) await fly(env, "DELETE", `/machines/${target.id}/metadata/ttl_until`);
          await purgeOffline(env).catch(() => {});
          return;
        }
        await sleep(1200);
      }
      await next();
    } catch (e) {
      await set({ phase: "error", failed_phase: p?.phase ?? "queued", error: e.message, finished_at: Date.now() });
    }
  }
}

const switcher = (env) => env.SWITCHER.get(env.SWITCHER.idFromName("fly-exit"));
const ask = async (env, path, init) => (await switcher(env).fetch(`https://switcher${path}`, init)).json();

// ---- usage (read-only org token) ---------------------------------------------------------
// Fly's Prometheus keeps ~14 days, so month-to-date is measured over min(MTD, 14d) and projected
// to a 30-day month. Legacy Hobby allowances are per category: the dashboard shows the machine
// allowance ("3 shared-cpu-1x 256mb") as $7.00/month, consumed at each region's own price.
const METRICS_RETENTION_DAYS = 14;
const MACHINE_ALLOWANCE_USD = 7.0;
const SHARED_1X_256MB_USD_PER_HOUR = 0.0030474; // Ashburn; fly.io/pricing-update, 2026-10
// Region price multiplier and egress allowance bucket (fly.io/pricing-update, 2026-10).
const REGION = {
  ewr: [1, "na-eu"], iad: [1, "na-eu"], yyz: [1.115, "na-eu"], sjc: [1.192, "na-eu"], lax: [1.2, "na-eu"],
  dfw: [1.25, "na-eu"], ord: [1.25, "na-eu"], ams: [1.038, "na-eu"], arn: [1.038, "na-eu"], cdg: [1.135, "na-eu"],
  lhr: [1.135, "na-eu"], fra: [1.154, "na-eu"], sin: [1.269, "apac-sa"], nrt: [1.308, "apac-sa"],
  syd: [1.269, "apac-sa"], gru: [1.615, "apac-sa"], jnb: [1.303, "africa-india"],
};
// Usage changes slowly and costs two Prometheus queries; keep it per isolate for 5 minutes
// (the Cache API is a no-op on workers.dev).
let usageMemo = { at: 0, value: null };
async function usage(env) {
  if (!env.FLY_METRICS_TOKEN) return null;
  if (Date.now() - usageMemo.at < 300_000) return usageMemo.value;
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const minutes = Math.max(1, Math.min(Math.ceil((now - monthStart) / 60000), METRICS_RETENTION_DAYS * 1440 - 60));
  const scale = (30 * 1440) / minutes;
  const q = async (query) => {
    const u = new URL(`https://api.fly.io/prometheus/${env.FLY_ORG}/api/v1/query`);
    u.searchParams.set("query", query);
    const res = await fetch(u, { headers: { authorization: env.FLY_METRICS_TOKEN } });
    if (!res.ok) throw new HttpError(502, `metrics ${res.status}`);
    return (await res.json()).data.result;
  };
  const [egress, uptime] = await Promise.all([
    q(`sum by (app, region) (increase(fly_instance_net_sent_bytes{device="eth0"}[${minutes}m]))`),
    q(`sum by (app, region) (count_over_time(fly_instance_up[${minutes}m:1m]))`),
  ]);
  const groups = {};
  for (const r of egress) {
    const group = REGION[r.metric.region]?.[1] ?? "unknown";
    groups[group] ??= { used_gb: 0, projected_gb: 0, allowance_gb: EGRESS_ALLOWANCE_GB[group] ?? 0, by: {} };
    const gb = Number(r.value[1]) / 1e9;
    groups[group].used_gb += gb;
    groups[group].by[`${r.metric.app}/${r.metric.region}`] = +gb.toFixed(2);
  }
  for (const g of Object.values(groups)) { g.projected_gb = +(g.used_gb * scale).toFixed(1); g.used_gb = +g.used_gb.toFixed(2); }
  const machines = {};
  let usd = 0;
  for (const r of uptime) {
    const hours = Number(r.value[1]) / 60;
    // Unknown region: price it as the most expensive known one.
    const cost = hours * SHARED_1X_256MB_USD_PER_HOUR * (REGION[r.metric.region]?.[0] ?? 1.615);
    usd += cost;
    machines[`${r.metric.app}/${r.metric.region}`] = { hours: Math.round(hours), usd_month: +(cost * scale).toFixed(2) };
  }
  const value = {
    window_days: +(minutes / 1440).toFixed(1), egress: groups, machines,
    machine_usd_projected: +(usd * scale).toFixed(2), machine_allowance_usd: MACHINE_ALLOWANCE_USD,
  };
  usageMemo = { at: Date.now(), value };
  return value;
}

const viewExit = (env, region, extra) => ({ region, label: regions(env)[region] ?? region, ...extra });
const egressOf = (seen, region) => (seen?.region === region ? { ip: seen.ip, country: seen.country, colo: seen.colo } : null);
const youOf = (req) => { const cf = req.cf || {}; return { ip: req.headers.get("cf-connecting-ip"), country: cf.country, colo: cf.colo, via_exit: cf.asn === FLY_ASN }; };

// Full status: the truth from Fly and Tailscale (about 1–2 s).
async function status(env, req) {
  const [machines, devices, live] = await Promise.all([listMachines(env), flyDevices(env), ask(env, "/live")]);
  let use_ = null, usage_error = null;
  try { use_ = await usage(env); } catch (e) { usage_error = e.message; }
  const running = machines.find((m) => RUNNING.has(m.state));
  const d = stableDevice(devices);
  const ttl = Number(running?.config?.metadata?.ttl_until || 0);
  return {
    exit: running ? viewExit(env, running.region, {
      state: running.state,
      online: Boolean(d?.connectedToControl && d.hostname === `fly-exit-${running.region}`),
      ttl_until: ttl ? new Date(ttl * 1000).toISOString() : null,
      egress: egressOf(live.seen, running.region),
    }) : null,
    device: d ? { name: d.name.split(".")[0], ip: d.addresses.find((a) => a.includes(".")), online: Boolean(d.connectedToControl) } : null,
    progress: live.progress,
    you: youOf(req),
    machines: machines.map((m) => ({ region: m.region, state: m.state })).sort((a, b) => a.region.localeCompare(b.region)),
    regions: regions(env), usage: use_, usage_error,
  };
}

// Live status: the coordinator's view only (tens of ms), polled while a move runs. "exit" is
// where the last finished move left fly-exit; a full status refresh confirms it.
async function liveStatus(env, req) {
  const { progress, exit, seen } = await ask(env, "/live");
  const live = { progress, you: youOf(req) };
  if (progress.phase === "done" && exit) {
    live.exit = exit.region ? viewExit(env, exit.region, { online: true, egress: egressOf(seen, exit.region) }) : null;
    if (exit.device) live.device = { ...exit.device, online: true };
  }
  return live;
}

// ---- HTTP ---------------------------------------------------------------------------------
// Apple Shortcuts' "Get Contents of URL" may send no body, an empty JSON body, JSON, or a form;
// accept them all, with the query string as fallback.
async function bodyParams(req) {
  const type = req.headers.get("content-type") || "";
  if (type.includes("multipart/form-data")) return Object.fromEntries(await req.formData());
  const text = (await req.text()).trim();
  if (!text) return null;
  if (type.includes("x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
  try { return JSON.parse(text); } catch { throw new HttpError(400, "body must be JSON or a form"); }
}

async function want(env, target, hours) {
  const progress = await ask(env, "/want", { method: "POST", body: JSON.stringify({ target, hours }) });
  return Response.json({ progress }, { status: 202 });
}

const htmlHeaders = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'" };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      // The node fetches and saves its identity; saving also records its public egress.
      if (url.pathname === "/node/state") {
        if (!eq(bearer(req), env.NODE_TOKEN)) return Response.json({ error: "unauthorized" }, { status: 401 });
        if (req.method === "GET") return switcher(env).fetch("https://switcher/node/state");
        if (req.method === "POST") {
          const s = await req.text();
          if (s.length > 65536) throw new HttpError(413, "state too large");
          JSON.parse(s);
          const region = url.searchParams.get("region");
          const cf = req.cf || {};
          const headers = region
            ? { "x-seen": JSON.stringify({ region, ip: req.headers.get("cf-connecting-ip"), country: cf.country, colo: cf.colo, at: new Date().toISOString() }) }
            : {};
          return switcher(env).fetch("https://switcher/node/state", { method: "POST", body: s, headers });
        }
      }

      const operator = eq(bearer(req), env.CONTROL_TOKEN);
      const viewer = operator || eq(cookie(req), env.CONTROL_TOKEN);
      const pageAction = viewer && req.headers.get("origin") === url.origin;
      if (req.method === "POST" && url.pathname === "/login") {
        const token = String((await req.formData()).get("token") || "").trim();
        if (!eq(token, env.CONTROL_TOKEN)) return new Response(null, { status: 303, headers: { location: "/?e=1" } });
        return new Response(null, { status: 303, headers: { location: "/",
          "set-cookie": `fc=${encodeURIComponent(token)}; Max-Age=31536000; Path=/; Secure; HttpOnly; SameSite=Lax` } });
      }
      if (req.method === "GET" && url.pathname === "/") return new Response(viewer ? PAGE : login(url.searchParams.has("e")), { headers: htmlHeaders });
      if (req.method === "GET" && url.pathname === "/status" && viewer) {
        return Response.json(url.searchParams.has("live") ? await liveStatus(env, req) : await status(env, req), { headers: { "cache-control": "no-store" } });
      }
      if (!operator && !pageAction) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (req.method === "POST" && url.pathname === "/use") {
        const body = await bodyParams(req);
        const get = (k) => body?.[k] || url.searchParams.get(k);
        const region = String(get("region") || "").toLowerCase();
        const hours = get("hours") ? Number(get("hours")) : null;
        if (!regions(env)[region]) throw new HttpError(400, `Unknown region "${region}". Pick one of: ${Object.keys(regions(env)).join(", ")}.`);
        if (hours !== null && !(hours > 0 && hours <= 24 * 30)) throw new HttpError(400, "hours must be between 0 and 720");
        return await want(env, region, hours);
      }
      if (req.method === "POST" && url.pathname === "/off") return await want(env, "off", null);
      return new Response("not found\n", { status: 404 });
    } catch (e) {
      return Response.json({ error: e.message }, { status: e.status || 500 });
    }
  },

  // TTL enforcement: turn the exit off when its ttl_until passes (through the Switcher, so it
  // is serialized with every other request).
  async scheduled(_event, env) {
    const now = Date.now() / 1000;
    const expired = (await listMachines(env)).some((m) => RUNNING.has(m.state) && Number(m.config?.metadata?.ttl_until || 0) && Number(m.config.metadata.ttl_until) < now);
    if (expired) await ask(env, "/want", { method: "POST", body: JSON.stringify({ target: "off", hours: null }) });
  },
};

// ---- pages -----------------------------------------------------------------------------------
// Operate surface: system type, tinted neutrals that follow the system light/dark setting, one
// accent per meaning (green = live, blue = moving, red = failed). Motion explains state only.
const HEAD = `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name=apple-mobile-web-app-capable content=yes><meta name=apple-mobile-web-app-title content="Exit node">
<meta name=color-scheme content="light dark">
<title>Exit node</title><style>
:root{color-scheme:light dark;
 --bg:oklch(98.4% .004 255);--panel:oklch(95.8% .007 255);--line:oklch(89% .01 255);--text:oklch(23% .02 260);--muted:oklch(46% .018 260);
 --live:oklch(55% .15 155);--live-soft:oklch(55% .15 155 / .13);--move:oklch(55% .15 255);--move-soft:oklch(55% .15 255 / .14);
 --fail:oklch(53% .19 27);--fail-soft:oklch(53% .19 27 / .12);--ease:cubic-bezier(.16,1,.3,1)}
@media (prefers-color-scheme:dark){:root{
 --bg:oklch(17.5% .014 262);--panel:oklch(21.5% .016 262);--line:oklch(30% .016 262);--text:oklch(94% .007 255);--muted:oklch(72% .014 258);
 --live:oklch(76% .15 155);--live-soft:oklch(76% .15 155 / .15);--move:oklch(74% .12 255);--move-soft:oklch(74% .12 255 / .16);
 --fail:oklch(72% .16 27);--fail-soft:oklch(72% .16 27 / .14)}}
*{box-sizing:border-box}
html{background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,system-ui,sans-serif;-webkit-text-size-adjust:100%}
body{margin:0 auto;max-width:560px;padding:calc(env(safe-area-inset-top,0px) + 22px) 18px calc(env(safe-area-inset-bottom,0px) + 32px)}
::selection{background:var(--move-soft)}
:focus-visible{outline:2px solid var(--move);outline-offset:2px}
h1{font-size:22px;line-height:1.2;margin:0;font-weight:650;letter-spacing:-.01em}
h2{font-size:15px;font-weight:620;margin:30px 0 10px}
.num{font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}
button{font:inherit;color:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}
svg{flex:none}
@keyframes spin{to{transform:rotate(1turn)}}
@keyframes breathe{50%{opacity:.35}}
.spin{animation:spin .9s linear infinite}
@media (prefers-reduced-motion:reduce){.spin{animation:breathe 1.6s ease-in-out infinite}
 .fill,.marker,.fold,.rb{transition:none!important}#region{transition:opacity .2s}#region[data-s=move]{filter:none}.rb:active{transform:none}}
input[type=password]{width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--text);font:inherit;font-size:16px;margin:8px 0 12px}
.primary{padding:11px 18px;border-radius:10px;border:0;background:var(--move);color:var(--bg);font-weight:600}
.err{color:var(--fail)}
</style>`;

// Sign-in page: the password field lets iOS/macOS Passwords save and sync the control token.
const login = (failed) => `${HEAD}</head><body><h1>Exit node</h1>
<form method=post action=/login style="margin-top:20px">
<input type=text name=username value=flyscale-control autocomplete=username hidden>
<label class=muted for=t>Control token</label>
<input id=t type=password name=token autocomplete=current-password required autofocus>
${failed ? "<p class=err>That token is not valid. Copy it again from the Mac keychain (flyscale-control).</p>" : ""}
<button class=primary type=submit>Sign in</button></form></body></html>`;

const PAGE = `${HEAD}<style>
header{display:flex;align-items:center;justify-content:space-between;gap:12px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:99px;font-size:13px;font-weight:600;background:var(--panel);color:var(--muted);transition:background-color .2s,color .2s}
.pill i{width:7px;height:7px;border-radius:50%;background:currentColor}
.pill[data-s=live]{background:var(--live-soft);color:var(--live)}
.pill[data-s=move]{background:var(--move-soft);color:var(--move)}.pill[data-s=move] i{animation:breathe 1.2s ease-in-out infinite}
.pill[data-s=fail]{background:var(--fail-soft);color:var(--fail)}
#exit{margin-top:16px;padding:18px;border-radius:14px;background:var(--panel);border:1px solid var(--line)}
.where{display:flex;align-items:baseline;gap:10px}
#region{font-size:30px;line-height:1.1;font-weight:680;letter-spacing:-.02em;transition:opacity .5s var(--ease),filter .5s var(--ease)}
/* Focal moment: the destination waits out of focus and sharpens when fly-exit arrives. */
#region[data-s=move]{opacity:.45;filter:blur(1.5px)}
#region[data-s=fail]{opacity:.45}
#code{font-size:15px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
#detail{margin:6px 0 0;color:var(--muted);font-size:14px}
.fold{display:grid;grid-template-rows:0fr;transition:grid-template-rows .3s var(--ease)}
.fold.open{grid-template-rows:1fr}.fold>div{overflow:hidden}
.transit{padding-top:16px}
.track{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;font-size:14px;font-weight:600}
.line{position:relative;height:4px;border-radius:2px;background:var(--line);container-type:inline-size}
.fill{position:absolute;inset:0;border-radius:2px;background:var(--move);transform-origin:left;transform:scaleX(var(--p,0));transition:transform .5s var(--ease)}
.marker{position:absolute;top:50%;left:0;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:var(--move);box-shadow:0 0 0 4px var(--move-soft);
 transform:translateX(calc(var(--p,0) * 100cqw));transition:transform .5s var(--ease)}
.transit[data-s=done] .fill,.transit[data-s=done] .marker{background:var(--live)}.transit[data-s=done] .marker{box-shadow:0 0 0 4px var(--live-soft)}
.transit[data-s=fail] .fill,.transit[data-s=fail] .marker{background:var(--fail)}
.steps{list-style:none;margin:14px 0 0;padding:0;display:grid;gap:8px;font-size:14px}
.steps li{display:flex;align-items:center;gap:9px;color:var(--muted);transition:color .2s}
.steps li[data-s=active]{color:var(--text);font-weight:600}.steps li[data-s=done]{color:var(--text)}
.steps li[data-s=fail]{color:var(--fail);font-weight:600}
.steps .ic{width:16px;height:16px;display:grid;place-items:center}
.steps li[data-s=todo] .ic::before{content:"";width:8px;height:8px;border-radius:50%;border:1.5px solid var(--line)}
.meta{display:flex;justify-content:space-between;gap:12px;margin-top:12px;font-size:13px;color:var(--muted)}
#device{display:flex;align-items:flex-start;gap:8px;margin:14px 2px 0;font-size:14px;color:var(--muted)}
#device i{width:8px;height:8px;border-radius:50%;margin-top:6px;flex:none;background:var(--line)}
#device[data-s=on] i{background:var(--live)}#device[data-s=wait] i{background:var(--move);animation:breathe 1.2s ease-in-out infinite}
#device b{color:var(--text);font-weight:600}
.regions{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
@media (min-width:480px){.regions{grid-template-columns:repeat(4,1fr)}}
.rb{position:relative;display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:48px;padding:10px 12px;border-radius:11px;border:1px solid var(--line);background:var(--panel);text-align:left;
 transition:border-color .15s,background-color .15s,transform .1s}
.rb:hover{border-color:color-mix(in oklch,var(--text) 28%,var(--line))}
.rb:active{transform:scale(.97)}
.rb small{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.rb[aria-pressed=true]{border-color:var(--live);background:var(--live-soft)}
.rb[aria-pressed=true] small{color:var(--live)}
.rb[aria-busy=true]{border-color:var(--move);background:var(--move-soft)}
.rb[aria-busy=true] small{color:var(--move)}
.offrow{display:flex;align-items:center;gap:12px;margin-top:12px}
.off{padding:9px 14px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--fail);font-weight:600;transition:background-color .15s,border-color .15s}
.off[data-armed]{background:var(--fail);border-color:var(--fail);color:var(--bg)}
.off:disabled{opacity:.45;cursor:default}
.usage{display:grid;gap:12px;font-size:14px}
.usage .row{display:flex;justify-content:space-between;gap:12px}
.bar{height:6px;border-radius:3px;background:var(--line);overflow:hidden;margin-top:5px}
.bar i{display:block;height:100%;background:var(--move);transform-origin:left}
.bar.warn i{background:var(--fail)}
#toast{margin:10px 2px 0;font-size:14px;min-height:20px}
</style></head><body>
<header><h1>Exit node</h1><span id=pill class=pill data-s=idle><i></i><span>Loading</span></span></header>
<section id=exit aria-live=polite>
 <div class=where><span id=region>…</span><span id=code></span></div>
 <p id=detail class=num></p>
 <div id=fold class=fold><div><div id=transit class=transit>
  <div class=track><span id=from></span><div class=line><span class=fill></span><span class=marker></span></div><span id=to></span></div>
  <ol id=steps class=steps></ol>
  <div class=meta><span id=note></span><span id=elapsed class=num></span></div>
 </div></div></div>
</section>
<p id=device data-s=off><i></i><span></span></p>
<h2>Move to</h2>
<div id=regions class=regions role=group aria-label="Move fly-exit to region"></div>
<div class=offrow><button id=off class=off type=button>Turn off</button><span id=offhint class=muted style="font-size:13px"></span></div>
<p id=toast role=status></p>
<h2>This month</h2>
<div id=usage class=usage></div>
<script>
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ICON={
 check:'<svg width=16 height=16 viewBox="0 0 16 16" aria-hidden=true><path d="M3.5 8.5l3 3 6-7" fill=none stroke=currentColor stroke-width=2 stroke-linecap=round stroke-linejoin=round /></svg>',
 spin:'<svg class=spin width=16 height=16 viewBox="0 0 16 16" aria-hidden=true><circle cx=8 cy=8 r=6 fill=none stroke=currentColor stroke-opacity=.25 stroke-width=2 /><path d="M8 2a6 6 0 0 1 6 6" fill=none stroke=currentColor stroke-width=2 stroke-linecap=round /></svg>',
 fail:'<svg width=16 height=16 viewBox="0 0 16 16" aria-hidden=true><path d="M8 4.5v4M8 11.2v.1" stroke=currentColor stroke-width=2 stroke-linecap=round /><circle cx=8 cy=8 r=6.5 fill=none stroke=currentColor stroke-width=1.5 /></svg>'};
const ORDER={queued:0,stopping:1,creating:2,starting:2,joining:3,done:4};
const FILL={queued:.06,stopping:.28,creating:.55,starting:.55,joining:.82,done:1};
let S=null,opt=null,ack=null,pollT,tickT,lastDone=null,armed=0,offline=0;
const label=r=>r==='off'?'Off':(S?.regions?.[r]||r);
const busy=p=>p&&p.target&&!['done','error','idle'].includes(p.phase);

// What to show: the server's progress, or an optimistic one for a click it has not answered yet.
// Server timestamps are converted with skew (server clock minus this device's clock).
let skew=0;
const serverNow=()=>Date.now()+skew;
function progress(){
 const p=S?.progress;
 if(opt)return{target:opt.target,phase:'queued',from:S?.exit?.region!==opt.target?S?.exit?.region:null,requested_at:opt.at+skew};
 return p;
}
function adopt(p){if(p?.now)skew=p.now-Date.now();if(S)S.progress=p}
// Where a request is moving from: the server knows once it starts; before that, the current exit.
const origin=p=>p.from??(p.phase==='queued'&&S?.exit&&S.exit.region!==p.target?S.exit.region:null);
function steps(p){
 const n=p.phase==='error'?ORDER[p.failed_phase]??0:ORDER[p.phase]??0, out=[], from=origin(p);
 if(from)out.push(['Stop '+label(from),1]);
 if(p.target!=='off'){out.push([(p.created||p.phase==='creating'?'Create ':'Start ')+label(p.target)+(p.phase==='creating'?' (first use, about a minute)':''),2]);out.push(['Join the tailnet',3]);}
 return out.map(([t,at])=>({t,s:p.phase==='done'?'done':p.phase==='error'?(n===at?'fail':n>at?'done':'todo'):n>at?'done':n===at?'active':'todo'}));
}
function mmss(ms){const s=Math.max(0,Math.round(ms/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}

function render(){
 if(!S)return;
 const p=progress(), e=S.exit, moving=busy(p), failed=p?.phase==='error'&&p.finished_at&&Date.now()-p.finished_at<120000;
 // Header pill
 const pill=$('pill');
 pill.dataset.s=moving?'move':failed?'fail':e?.online?'live':'idle';
 pill.lastElementChild.textContent=moving?(p.target==='off'?'Turning off':'Moving'):failed?'Move failed':e?(e.online?'Online':'Connecting'):'Off';
 // Headline: the current exit when settled; during a move, the destination, out of focus.
 const dest=moving||failed?p.target:null;
 $('region').textContent=dest?label(dest):e?e.label:'Off';
 $('code').textContent=dest?(dest==='off'?'':dest):e?e.region:'';
 $('region').dataset.s=moving?'move':failed?'fail':'here';
 $('detail').innerHTML=moving?(p.target==='off'?'Stopping fly-exit.':(p.created||p.phase==='creating'?'First use of this region, about a minute.':'Usually 15–30 seconds.')+' Devices using fly-exit pause until it is back.')
  :failed?'Not moved. The exit stays '+(e?'in '+esc(e.label):'off')+'.'
  :e?esc(S.device?.name)+' · '+esc(S.device?.ip)+(e.egress?' · exits as '+esc(e.egress.country)+' '+esc(e.egress.ip):'')+(e.ttl_until?' · until '+new Date(e.ttl_until).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'')
  :'No exit node is running.';
 // Transit
 const show=moving||failed||(p&&lastDone===p.requested_at);
 $('fold').classList.toggle('open',Boolean(show));
 if(show){
  const t=$('transit');
  t.dataset.s=p.phase==='done'?'done':p.phase==='error'?'fail':'move';
  t.style.setProperty('--p',p.phase==='error'?FILL[p.failed_phase]??0:FILL[p.phase]??0);
  $('from').textContent=origin(p)?label(origin(p)):p.target==='off'?'Off':'Start';
  $('to').textContent=label(p.target);
  $('steps').innerHTML=steps(p).map(x=>'<li data-s='+x.s+'><span class=ic>'+(x.s==='done'?ICON.check:x.s==='active'?ICON.spin:x.s==='fail'?ICON.fail:'')+'</span>'+esc(x.t)+'</li>').join('');
  $('note').textContent=p.phase==='error'?p.error:p.phase==='done'?(p.target==='off'?'fly-exit is off.':'Arrived. Devices using fly-exit are back online.'):ack||'';
 }
 // Device line
 const dv=$('device');
 if(offline&&(moving||offline>1)){dv.dataset.s='wait';dv.lastElementChild.innerHTML=moving?'<b>This device is reconnecting.</b> Expected: its traffic goes through fly-exit, which is moving.':'<b>Cannot reach the server.</b> Retrying…'}
 else if(S.you.via_exit){dv.dataset.s='on';dv.lastElementChild.innerHTML='<b>This device uses fly-exit</b> and is seen from '+esc(S.you.country)+'.'}
 else{dv.dataset.s='off';dv.lastElementChild.innerHTML='<b>This device does not use fly-exit</b> (seen from '+esc(S.you.country)+'). In Tailscale, choose '+esc(S.device?.name||'fly-exit')+' as the exit node once.'}
 // Region buttons
 const here=e?.online&&!moving?e.region:null, pend=moving?p.target:null;
 if($('regions').childElementCount!==Object.keys(S.regions).length){
  $('regions').innerHTML=Object.entries(S.regions).map(([k,v])=>'<button type=button class=rb data-r="'+k+'"><span>'+esc(v)+'</span><small></small></button>').join('');
  $('regions').querySelectorAll('.rb').forEach(b=>b.onclick=()=>choose(b.dataset.r));
 }
 $('regions').querySelectorAll('.rb').forEach(b=>{
  const r=b.dataset.r, on=r===here, wait=r===pend;
  b.setAttribute('aria-pressed',on);b.setAttribute('aria-busy',wait);
  b.querySelector('small').innerHTML=wait?ICON.spin:on?ICON.check:esc(r);
 });
 $('off').disabled=!e&&!moving;
 // Usage
 const u=S.usage;
 $('usage').innerHTML=!u?'<span class=muted>'+esc(S.usage_error||'Usage needs FLY_METRICS_TOKEN.')+'</span>':
  [['Machines','$'+u.machine_usd_projected,'$'+u.machine_allowance_usd,u.machine_usd_projected/u.machine_allowance_usd]]
  .concat(Object.entries(u.egress).map(([g,v])=>[{'na-eu':'Data, Europe & N. America','apac-sa':'Data, Asia-Pacific','africa-india':'Data, Africa & India'}[g]||g,'~'+v.projected_gb+' GB',v.allowance_gb+' GB',v.projected_gb/(v.allowance_gb||1)]))
  .map(([n,a,b,f])=>'<div><div class=row><span>'+esc(n)+'</span><span class="muted num">'+esc(a)+' of '+esc(b)+'</span></div><div class="bar'+(f>.9?' warn':'')+'"><i style="transform:scaleX('+Math.min(1,f)+')"></i></div></div>').join('')
  +'<span class=muted style="font-size:13px">Projected to 30 days from the last '+u.window_days+' days.</span>';
}

async function choose(r){
 const p=progress();
 if(!busy(p)&&S?.exit?.online&&S.exit.region===r){toast('fly-exit is already in '+label(r)+'.');return}
 if(busy(p)&&p.target===r)return; // same choice again: nothing to do
 ack=busy(p)?'Changed to '+label(r)+'. The current step finishes first.':null;
 opt={target:r,at:Date.now()};lastDone=null;safe(render);tick();
 await send('/use',{region:r});
}
async function send(path,body){
 try{const j=await get(path,8000,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});
  adopt(j.progress);opt=null}
 catch(e){if(e.http){opt=null;ack=null;toast(e.message||'The request failed.',true)}
  /* no response at all: this device probably rides the moving node; polling catches up */}
 safe(render);tick();schedule(0);
}
$('off').onclick=()=>{
 if(Date.now()-armed>4000){armed=Date.now();$('off').dataset.armed='';$('off').textContent='Tap again to turn off';
  $('offhint').textContent='Devices still using fly-exit lose internet until they choose None in Tailscale.';
  setTimeout(()=>{if(Date.now()-armed>=4000)disarm()},4100);return}
 disarm();ack=null;opt={target:'off',at:Date.now()};lastDone=null;safe(render);tick();send('/off');
};
function disarm(){armed=0;delete $('off').dataset.armed;$('off').textContent='Turn off';$('offhint').textContent=''}
function toast(t,bad){const el=$('toast');el.className=bad?'err':'muted';el.textContent=t;clearTimeout(el._t);el._t=setTimeout(()=>el.textContent='',5000)}

function tick(){
 clearTimeout(tickT);
 const p=progress();
 if(busy(p)){$('elapsed').textContent=mmss(serverNow()-p.requested_at);tickT=setTimeout(tick,500)}
 else if(p&&p.finished_at&&p.requested_at)$('elapsed').textContent=mmss(p.finished_at-p.requested_at);
}
// One polling loop. Every request has a timeout; a failure never replaces good data and never
// stops the loop. During a move it polls the coordinator's live view (tens of ms) every 0.7 s;
// otherwise it refreshes the full status (Fly and Tailscale, 1–2 s) every 30 s.
let inflight=false,needFull=true,lastFull=0;
async function get(path,ms,init){
 const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);
 try{const r=await fetch(path,{cache:'no-store',...init,signal:c.signal});
  if(r.status===401){location.reload();throw new Error('signed out')}
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw Object.assign(new Error(j.error||'The request failed ('+r.status+').'),{http:r.status});
  return j}
 finally{clearTimeout(t)}
}
function merge(j,full){
 if(full||!S){S=j;return}
 const keep=S.exit&&j.exit&&S.exit.region===j.exit.region?S.exit:{};
 S={...S,...j,exit:'exit' in j?(j.exit&&{...keep,...j.exit}):S.exit};
}
async function refresh(){
 if(inflight)return;inflight=true;
 const was=busy(progress()), full=needFull||!S||(!was&&Date.now()-lastFull>25000);
 try{
  merge(await get(full?'/status':'/status?live=1',full?9000:4000),full);
  if(full){lastFull=Date.now();needFull=false}
  adopt(S.progress);offline=0;
  const p=S.progress;
  // A click whose response was lost is cleared once the server shows that target, or after 20 s.
  if(opt&&(p?.target===opt.target||Date.now()-opt.at>20000))opt=null;
  if(was&&!busy(progress())){needFull=true;ack=null;
   if(p?.phase==='done'){lastDone=p.requested_at;setTimeout(()=>{if(lastDone===p.requested_at){lastDone=null;safe(render)}},2600)}}
 }catch(_){offline++}
 finally{inflight=false;safe(render);tick();schedule()}
}
function schedule(ms){
 clearTimeout(pollT);
 if(document.hidden)return;
 if(ms===undefined)ms=offline?Math.min(4000,700*2**Math.min(offline,3)):needFull?50:busy(progress())?700:30000;
 pollT=setTimeout(refresh,ms);
}
function safe(f){try{f()}catch(e){console.error(e)}}
document.addEventListener('visibilitychange',()=>{if(!document.hidden){needFull=true;schedule(0)}});
addEventListener('pageshow',()=>schedule(0));
addEventListener('online',()=>schedule(0));
refresh();
</script></body></html>`;
