# Development

## First time
```sh
npm install
npx wrangler login                 # authorize your Cloudflare account
npx wrangler d1 create universal-ingress-db
# paste the printed database_id into wrangler.toml
npm run types                      # generates worker-configuration.d.ts
```

## Run locally
Create `.dev.vars` with the secrets:
```
TWILIO_AUTH_TOKEN=...
PEBBLE_SECRET=...
READ_TOKEN=...
PUBLIC_BASE_URL=...
```
Then:
```sh
npm run db:migrate:local
npm run dev
```
Try it:
```sh
curl -X POST localhost:8787/hooks/pebble -H 'Authorization: Bearer <PEBBLE_SECRET>' \
  -H 'X-Index-Delivery: 1' -H 'X-Index-Trigger: test-event' -F transcription=hello -F recordedAt=1700000000000
curl localhost:8787/pull?after=0 -H 'Authorization: Bearer <READ_TOKEN>'
```

Instead of polling, a watcher can hold a websocket open (same `READ_TOKEN`):
```
GET /watch?after=<last_seq>   Authorization: Bearer <READ_TOKEN>   Upgrade: websocket
```
It first receives the backlog after `after`, then new events as they arrive, each as `{"events": [...]}`
(same shape as `/pull`). Delivery is at-least-once, so the watcher keeps its own `last_seq` and dedupes by `seq`.
Send the text `ping` every ~30s and expect `pong`; on disconnect, reconnect with the latest `last_seq`.

`watch.py` is that watcher for the Obsidian vault: `./watch.py` (needs `UNIVERSAL_INGRESS_READ_TOKEN`).
It reads `watch_endpoint` (default `wss://universal-ingress.operator-notes.workers.dev/watch`) and `last_seq` from
`~/Documents/Deus/Setup/universal-ingress.json`.
`./watch.py --once` skips the websocket: it calls `GET /pull` (the `endpoint` key) once, handles new events and exits, so it's safe to run from cron.

## Deploy
```sh
npx wrangler secret put TWILIO_AUTH_TOKEN   # repeat for PEBBLE_SECRET, READ_TOKEN, PUBLIC_BASE_URL
npm run db:migrate:remote                   # D1 schema only: "no migrations to apply" is normal if migrations/ didn't change
npm run deploy                              # also applies the Durable Object migration in wrangler.toml (needed for /watch)
```
In the Index app, add a custom header `Authorization: Bearer <PEBBLE_SECRET>` and set the URL to `<PUBLIC_BASE_URL>/hooks/pebble`.
Point Twilio at `<PUBLIC_BASE_URL>/hooks/twilio`.

## Everyday
- `npm run typecheck`: type check
- `npx wrangler tail`: live logs from the deployed Worker
- Durable Object class changes (add/rename/delete) need a new `[[migrations]]` entry in `wrangler.toml` with a new `tag`; `npm run deploy` applies it
- Schema change: add `migrations/000N_name.sql`, then run both migrate scripts `npm run db:migrate:local && npm run db:migrate:remote`

## Secrets
Set with `npx wrangler secret put <NAME>` (locally, in `.dev.vars`):
- `TWILIO_AUTH_TOKEN`: your Twilio auth token
- `PEBBLE_SECRET`: bearer token the Index app sends to `/hooks/pebble`
- `READ_TOKEN`: bearer token for the local watcher (`/pull` and `/watch`). Keep it separate from the ingest secrets so a leaked webhook secret can't read your notes.
- `PUBLIC_BASE_URL`: the exact public URL Twilio calls, for example `https://ingest.example.com`. Twilio signs the full URL, so this must match what you configured in the Twilio console.

## Caveats
- Cursor, not acks. The watcher stores the last `seq` it wrote and asks for `after=<seq>`. A crash mid-write replays from the last cursor, so vault writes should be idempotent (`watch.py` names attachments with the source and external ID).
- Delivery is at-least-once. Watchers must skip any `seq` they have already handled.
- Draining. `/pull` returns at most 500 events (100 by default) per call. `watch.py --once` makes a single call, so a backlog larger than 100 takes several runs. `/watch` drains everything on connect.
- Twilio URL must match exactly. Signature verification uses the URL as configured in the Twilio console, including any query string. If it fails in testing, check this first.
- Raw payloads. Twilio bodies are stored as the form-encoded string Twilio sent. The watcher parses each payload using its `contentType`. Pebble audio is dropped; only the text fields are stored.
- Verify against current docs. D1 and Durable Object APIs change quickly. Check binding syntax and types against the Cloudflare docs before deploying.
