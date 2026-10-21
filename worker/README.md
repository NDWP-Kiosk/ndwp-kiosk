# WakeSys bridge worker

A Cloudflare Worker that fetches today's sessions from WakeSys, turns the JSONP
reply into plain JSON with CORS headers, and keeps a copy of the last good
response. If WakeSys is down or slow (8s timeout), the worker serves that copy
with `"stale": true` so the kiosk keeps showing sessions.

## Deploy

By hand:

```sh
cd worker
npx wrangler deploy
```

From GitHub: add `CLOUDFLARE_API_TOKEN` (with "Edit Cloudflare Workers"
permission) and `CLOUDFLARE_ACCOUNT_ID` as repository secrets. Pushes to `main`
that touch `worker/` then deploy automatically, and you can run the
"Deploy WakeSys bridge worker" workflow manually.

After the first deploy, put the worker's URL in `WORKER_URL` near the top of
the script in `index.html`. You can also test a URL without editing by opening
`index.html?api=https://your-worker.workers.dev/`.

## Optional: KV for the last good copy

Without KV the copy lives in Cloudflare's per-location cache, which can be
evicted. For a sturdier copy, create a namespace and uncomment the
`[[kv_namespaces]]` block in `wrangler.toml`:

```sh
npx wrangler kv namespace create LAST_GOOD
```
