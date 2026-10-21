const WAKE_SYS_API = "https://northdevonwakepark.wakesys.com/api/events.php";
const UPSTREAM_TIMEOUT_MS = 8000;
// Keep the last good copy for 2 days; the kiosk decides what is too old to show.
const LAST_GOOD_TTL_SECONDS = 2 * 86400;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store"
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
  });
}

// Date in Europe/London, so the day doesn't flip an hour early during BST.
function londonDate(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(d);
}

function lastGoodKey(start, stop) {
  return "last-good:" + start + ":" + stop;
}

async function readLastGood(env, key) {
  try {
    if (env && env.LAST_GOOD) {
      const text = await env.LAST_GOOD.get(key);
      return text ? JSON.parse(text) : null;
    }
    const hit = await caches.default.match("https://last-good.internal/" + key);
    return hit ? await hit.json() : null;
  } catch (_) {
    return null;
  }
}

async function writeLastGood(env, key, payload) {
  const text = JSON.stringify(payload);
  if (env && env.LAST_GOOD) {
    await env.LAST_GOOD.put(key, text, { expirationTtl: LAST_GOOD_TTL_SECONDS });
    return;
  }
  await caches.default.put("https://last-good.internal/" + key, new Response(text, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "max-age=" + LAST_GOOD_TTL_SECONDS
    }
  }));
}

async function fetchWakeSys(start, stop) {
  // WakeSys returns JSONP, so ask it for a known callback name.
  const apiUrl = new URL(WAKE_SYS_API);
  apiUrl.searchParams.set("callback", "displayEventList");
  apiUrl.searchParams.set("start", start);
  apiUrl.searchParams.set("stop", stop);

  const upstream = await fetch(apiUrl.toString(), {
    method: "GET",
    headers: { "Accept": "application/javascript,text/javascript,*/*" },
    cf: { cacheTtl: 30, cacheEverything: true },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  });

  if (!upstream.ok) {
    throw new Error("WakeSys returned HTTP " + upstream.status);
  }

  const body = await upstream.text();

  // Expected format:
  // displayEventList([...events...])
  const firstParen = body.indexOf("(");
  const lastParen = body.lastIndexOf(")");
  if (firstParen === -1 || lastParen <= firstParen) {
    throw new Error("WakeSys response was not valid JSONP");
  }

  const data = JSON.parse(body.slice(firstParen + 1, lastParen));
  const events = Array.isArray(data) ? data :
    (data && Array.isArray(data.events) ? data.events : null);
  if (!events) {
    throw new Error("WakeSys response had no event list");
  }
  return events;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "GET") {
      return json({ ok: false, error: "GET only" }, 405);
    }

    const incoming = new URL(request.url);
    const today = new Date();
    const tomorrow = new Date(today.getTime() + 86400000);
    const start = incoming.searchParams.get("start") || londonDate(today);
    const stop = incoming.searchParams.get("stop") || londonDate(tomorrow);
    const key = lastGoodKey(start, stop);

    try {
      const events = await fetchWakeSys(start, stop);
      const payload = {
        ok: true,
        source: "WakeSys",
        stale: false,
        fetchedAt: new Date().toISOString(),
        start,
        stop,
        eventCount: events.length,
        events
      };
      ctx.waitUntil(writeLastGood(env, key, payload).catch(() => {}));
      return json(payload, 200);
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      const lastGood = await readLastGood(env, key);
      if (lastGood) {
        // Serve the last good copy so the screen keeps working, but say so.
        return json({ ...lastGood, stale: true, error: message }, 200);
      }
      return json({ ok: false, error: message }, 502);
    }
  }
};
