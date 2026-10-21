const WAKE_SYS_API = "https://northdevonwakepark.wakesys.com/api/events.php";

// Closure overrides live under one KV key so the kiosk needs a single read.
const OVERRIDES_KEY = "overrides";

// Activity names must match the kiosk's DISPLAY list. "ALL" closes the park.
const ACTIVITIES = [
  "ALL",
  "FULL SIZE CABLE",
  "TOP LAKE",
  "AQUA PARK",
  "JUNIOR AQUA PARK",
  "PADDLEBOARDING",
  "SAUNA & DIP"
];
const STATUSES = ["closed", "delayed"];
const REASONS = ["wind", "lightning", "water-quality", "other"];

// A forgotten override should not carry into the next day.
const MAX_AGE_MS = 18 * 60 * 60 * 1000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-Staff-Pin",
  "Cache-Control": "no-store"
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname === "/overrides") {
      if (request.method === "GET") return getOverrides(env);
      if (request.method === "POST") return postOverride(request, env);
      return json({ ok: false, error: "GET or POST only" }, 405);
    }

    if (url.pathname === "/overrides/check") {
      if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
      if (!checkPin(request, env)) return json({ ok: false, error: "Wrong PIN" }, 401);
      return json({ ok: true });
    }

    if (request.method !== "GET") {
      return json({ error: "GET only" }, 405);
    }

    return getWakeSys(url);
  }
};

async function readOverrides(env) {
  if (!env.OVERRIDES) throw new Error("OVERRIDES KV namespace is not bound");
  const stored = (await env.OVERRIDES.get(OVERRIDES_KEY, { type: "json" })) || {};
  const now = Date.now();
  const active = {};
  for (const [activity, o] of Object.entries(stored)) {
    if (o && now - Date.parse(o.setAt) < MAX_AGE_MS) active[activity] = o;
  }
  return active;
}

async function getOverrides(env) {
  try {
    return json({ ok: true, fetchedAt: new Date().toISOString(), overrides: await readOverrides(env) });
  } catch (error) {
    return json({ ok: false, error: String(error.message || error) }, 500);
  }
}

function checkPin(request, env) {
  const expected = env.STAFF_PIN;
  const given = request.headers.get("X-Staff-Pin") || "";
  if (!expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

// Body: { activity, status: "closed"|"delayed"|"open", reason, note?, until?, setBy? }
// status "open" clears the override for that activity.
async function postOverride(request, env) {
  if (!checkPin(request, env)) return json({ ok: false, error: "Wrong PIN" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Body must be JSON" }, 400);
  }

  const activity = String(body.activity || "");
  if (!ACTIVITIES.includes(activity)) return json({ ok: false, error: "Unknown activity" }, 400);

  try {
    const overrides = await readOverrides(env);

    if (body.status === "open") {
      delete overrides[activity];
    } else {
      if (!STATUSES.includes(body.status)) return json({ ok: false, error: "Unknown status" }, 400);
      if (!REASONS.includes(body.reason)) return json({ ok: false, error: "Unknown reason" }, 400);
      const until = body.until ? new Date(body.until) : null;
      if (until && isNaN(until)) return json({ ok: false, error: "Bad until time" }, 400);
      overrides[activity] = {
        status: body.status,
        reason: body.reason,
        note: String(body.note || "").slice(0, 140),
        until: until ? until.toISOString() : null,
        setBy: String(body.setBy || "").slice(0, 40),
        setAt: new Date().toISOString()
      };
    }

    await env.OVERRIDES.put(OVERRIDES_KEY, JSON.stringify(overrides));
    return json({ ok: true, overrides });
  } catch (error) {
    return json({ ok: false, error: String(error.message || error) }, 500);
  }
}

async function getWakeSys(incoming) {
  try {
    const today = new Date();
    const tomorrow = new Date(today.getTime() + 86400000);

    const start = incoming.searchParams.get("start") ||
      today.toISOString().slice(0, 10);
    const stop = incoming.searchParams.get("stop") ||
      tomorrow.toISOString().slice(0, 10);

    // WakeSys returns JSONP, so ask it for a known callback name.
    const apiUrl = new URL(WAKE_SYS_API);
    apiUrl.searchParams.set("callback", "displayEventList");
    apiUrl.searchParams.set("start", start);
    apiUrl.searchParams.set("stop", stop);

    const upstream = await fetch(apiUrl.toString(), {
      method: "GET",
      headers: {
        "Accept": "application/javascript,text/javascript,*/*"
      },
      cf: {
        cacheTtl: 30,
        cacheEverything: true
      }
    });

    if (!upstream.ok) {
      return json({ error: "WakeSys returned HTTP " + upstream.status }, 502);
    }

    const body = await upstream.text();

    // Expected format:
    // displayEventList([...events...])
    const firstParen = body.indexOf("(");
    const lastParen = body.lastIndexOf(")");

    if (firstParen === -1 || lastParen <= firstParen) {
      return json({
        error: "WakeSys response was not valid JSONP",
        preview: body.slice(0, 300)
      }, 502);
    }

    const jsonText = body.slice(firstParen + 1, lastParen);
    const data = JSON.parse(jsonText);

    return json({
      ok: true,
      source: "WakeSys",
      fetchedAt: new Date().toISOString(),
      start,
      stop,
      eventCount: Array.isArray(data) ? data.length : 0,
      events: Array.isArray(data) ? data : []
    });

  } catch (error) {
    return json({
      ok: false,
      error: String(error && error.message ? error.message : error)
    }, 502);
  }
}
