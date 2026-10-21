# WakeSys bridge and closure overrides Worker

This Cloudflare Worker does two jobs:

- `GET /` proxies today's WakeSys events as plain JSON (the original bridge).
- `/overrides` stores staff closure and delay notices that the kiosk shows.

## Overrides API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/overrides` | none | Current notices, keyed by activity. The kiosk polls this every 15s. |
| POST | `/overrides` | `X-Staff-Pin` header | Set or clear a notice. |
| POST | `/overrides/check` | `X-Staff-Pin` header | Checks the PIN (used by the staff sign in). |

POST body:

```json
{ "activity": "AQUA PARK", "status": "closed", "reason": "wind",
  "note": "Gusts over 30mph", "until": "2026-10-22T14:00:00Z", "setBy": "Jack" }
```

- `activity`: one of the kiosk columns, or `ALL` for the whole park.
- `status`: `closed`, `delayed`, or `open` (clears the notice).
- `reason`: `wind`, `lightning`, `water-quality`, or `other`.
- `note` (max 140 chars), `until` and `setBy` are optional.

Notices drop off automatically 18 hours after they were set.

## One-time setup

```sh
cd worker
npx wrangler kv namespace create OVERRIDES   # paste the printed id into wrangler.toml
npx wrangler secret put STAFF_PIN            # choose the staff PIN
npx wrangler deploy
```

If your existing Worker has a different name, change `name` in `wrangler.toml`
to match so the deploy updates it rather than creating a new one.

Then point the pages at the Worker, either by setting `WORKER_URL` near the
top of the script in `index.html`, or by opening
`index.html?worker=https://<your-worker>.workers.dev`. Staff open
`staff.html` and enter the same address with the PIN (it is remembered on
that device).
