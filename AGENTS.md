# Agent notes

Webhook -> storage -> retrieval on Cloudflare Workers + D1. Keep it small and readable.

## Layout
- `src/index.ts`: routing and one handler per endpoint
- `src/auth.ts`: bearer, shared-secret and Twilio signature checks
- `src/events.ts`: the only code that touches D1
- `migrations/`: D1 schema, applied with wrangler
- `src/.later.ts`: parked Durable Object push idea, not wired in

## Conventions
- Prefer plain, descriptive names and short functions over abstractions.
- New source = one handler in `index.ts` that verifies auth, then calls `appendEvent`. Store the raw payload untouched.
- Schema changes go in a new numbered file in `migrations/`; never edit an applied one.
- Secrets are read from `env`, never hardcoded. Locally they live in `.dev.vars` (gitignored).

## Cloudflare
- This project has a Wrangler config (`wrangler.toml`), so use `wrangler` (via `npm run ...`), not the `cf` CLI.
- Workers/D1 APIs change quickly. Check current docs (https://developers.cloudflare.com/workers/, https://developers.cloudflare.com/d1/) before changing bindings or config. Docs are also available as markdown by appending `/index.md`.
- Cloudflare skills/MCP for agents (optional, user-level install, see https://developers.cloudflare.com/agent-setup/prompt.md):
  - Claude Code: `claude plugin marketplace add cloudflare/skills` then `claude plugin install cloudflare@cloudflare`
  - Others: `npx -y skills add cloudflare/skills --skill '*' --yes --global`, or MCP server `https://mcp.cloudflare.com/mcp`
- After changing `wrangler.toml` bindings, run `npm run types` then `npm run typecheck`.
