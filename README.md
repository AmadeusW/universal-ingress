# Universal ingress

## Secrets
Secrets, set with wrangler secret put <NAME>:
- TWILIO_AUTH_TOKEN: your Twilio auth token
- PEBBLE_SECRET: shared secret your Pebble integration sends in X-Ingest-Secret
- READ_TOKEN: bearer token for the local agent. Keep it separate from the ingest secrets so a leaked webhook secret can't read your notes.
- PUBLIC_BASE_URL: the exact public URL Twilio calls, for example https://ingest.example.com. Twilio signs the full URL, so this must match what you configured in the Twilio console.

## Caveats
- Cursor, not acks. The agent stores the last seq it wrote to disk and asks for after=<seq>. A crash mid-write replays from the last cursor, so make vault writes idempotent, for example by naming files with the source and external ID.
- Draining. /pull returns at most 500 events. The agent should loop until a response has fewer events than it asked for.
- Twilio URL must match exactly. Signature verification uses the URL as configured in the Twilio console, including any query string. If it fails in testing, check this first.
- Raw payloads. Twilio bodies are stored as the form-encoded string Twilio sent. The agent parses each payload using its contentType.
- Verify against current docs. D1 and Durable Object APIs change quickly. Check binding syntax and types against the Cloudflare docs before deploying.
- Not yet written: the local agent that turns events into markdown files in the vault.