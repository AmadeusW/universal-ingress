import { hasValidBearerToken, hasValidSharedSecret, isValidTwilioSignature } from "./auth";
import { appendEvent, readEventsAfter } from "./events";

export interface Env {
  DB: D1Database;
  TWILIO_AUTH_TOKEN: string;
  PEBBLE_SECRET: string;
  READ_TOKEN: string;
  /** Exact public URL Twilio is configured to call. Twilio signs it, so it must match character for character. */
  PUBLIC_BASE_URL: string;
}

const DEFAULT_PULL_LIMIT = 100;
const MAX_PULL_LIMIT = 500;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    switch (`${request.method} ${pathname}`) {
      case "POST /hooks/twilio": return handleTwilioWebhook(request, env);
      case "POST /hooks/pebble": return handlePebbleWebhook(request, env);
      case "GET /pull":          return handlePull(request, env);
      default:                   return new Response("not found", { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;

async function handleTwilioWebhook(request: Request, env: Env): Promise<Response> {
  const payload = await request.text();
  const formFields = new URLSearchParams(payload);
  const { pathname, search } = new URL(request.url);

  const signatureIsValid = await isValidTwilioSignature({
    authToken: env.TWILIO_AUTH_TOKEN,
    url: env.PUBLIC_BASE_URL + pathname + search,
    formFields,
    receivedSignature: request.headers.get("X-Twilio-Signature"),
  });
  if (!signatureIsValid) return unauthorized();

  await appendEvent(env.DB, {
    source: "twilio",
    // Stable across Twilio's retries, so redelivery is a no-op. Assumes this endpoint only
    // receives incoming-message webhooks: status callbacks reuse MessageSid and would be dropped as duplicates.
    externalId: formFields.get("MessageSid") ?? crypto.randomUUID(),
    contentType: request.headers.get("Content-Type") ?? "application/x-www-form-urlencoded",
    payload,
  });

  // Empty TwiML acknowledges the message without auto-replying to the sender.
  return new Response("<Response/>", { headers: { "Content-Type": "text/xml" } });
}

async function handlePebbleWebhook(request: Request, env: Env): Promise<Response> {
  if (!hasValidSharedSecret(request, "X-Ingest-Secret", env.PEBBLE_SECRET)) return unauthorized();

  await appendEvent(env.DB, {
    source: "pebble",
    // Assumes Pebble can send a stable X-Event-Id. Without one, a retry is stored as a new event.
    externalId: request.headers.get("X-Event-Id") ?? crypto.randomUUID(),
    contentType: request.headers.get("Content-Type") ?? "application/octet-stream",
    payload: await request.text(),
  });

  return new Response(null, { status: 204 });
}

/** GET /pull?after=<seq>&limit=<n>: events newer than the agent's cursor, oldest first. */
async function handlePull(request: Request, env: Env): Promise<Response> {
  if (!hasValidBearerToken(request, env.READ_TOKEN)) return unauthorized();

  const query = new URL(request.url).searchParams;
  const afterSeq = parseNonNegativeInt(query.get("after"), 0);
  const requestedLimit = parseNonNegativeInt(query.get("limit"), DEFAULT_PULL_LIMIT);

  const events = await readEventsAfter(env.DB, afterSeq, Math.min(requestedLimit, MAX_PULL_LIMIT));
  return Response.json({ events });
}

function unauthorized(): Response {
  return new Response("unauthorized", { status: 401 });
}

function parseNonNegativeInt(text: string | null, fallback: number): number {
  const parsed = Number.parseInt(text ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
