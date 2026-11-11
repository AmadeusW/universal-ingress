# Universal Ingress

Everything you say, text, or record, lands in your notes.

Universal Ingress is a tiny Cloudflare Worker that 
- catches webhooks from the 
([Pebble Index ring](https://github.com/coredevices/mobileapp/blob/6361b3310bd6cf42e528cc60fac38d4cd1c21aec/experimental/src/commonMain/kotlin/coredevices/ring/external/indexwebhook/INDEX_WEBHOOK_API.md)
voice notes) and Twilio (SMS), 
- stores the data verbatim in D1, and 
- pushes it over a websocket to a local watcher 

The local watcher files the notes into filesystem,
such as your Obsidian vault, where AI agent can act on it.

Setup, deployment and gotchas are in [development.md](development.md).
