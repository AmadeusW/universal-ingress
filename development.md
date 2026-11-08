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
Create `.dev.vars` (gitignored) with the secrets:
```
TWILIO_AUTH_TOKEN=...
PEBBLE_SECRET=...
READ_TOKEN=...
PUBLIC_BASE_URL=http://localhost:8787
```
Then:
```sh
npm run db:migrate:local
npm run dev
```
Try it:
```sh
curl -X POST localhost:8787/hooks/pebble -H 'X-Ingest-Secret: ...' -H 'X-Event-Id: 1' -d 'hello'
curl localhost:8787/pull?after=0 -H 'Authorization: Bearer <READ_TOKEN>'
```

## Deploy
```sh
npx wrangler secret put TWILIO_AUTH_TOKEN   # repeat for PEBBLE_SECRET, READ_TOKEN, PUBLIC_BASE_URL
npm run db:migrate:remote
npm run deploy
```
Point Twilio at `<PUBLIC_BASE_URL>/hooks/twilio` (must match exactly).

## Everyday
- `npm run typecheck`: type check
- `npx wrangler tail`: live logs from the deployed Worker
- Schema change: add `migrations/000N_name.sql`, then run both migrate scripts
