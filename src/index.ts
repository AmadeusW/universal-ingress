import { hasValidBearerToken, isValidTwilioSignature } from "./auth";
import { appendEvent, readEventsAfter } from "./events";

export { Watchers } from "./watchers";

export interface Env {
  DB: D1Database;
  WATCHERS: DurableObjectNamespace<import("./watchers").Watchers>;
  TWILIO_AUTH_TOKEN: string;
  PEBBLE_SECRET: string;
  READ_TOKEN: string;
  /** Exact public URL Twilio is configured to call. Twilio signs it, so it must match character for character. */
  PUBLIC_BASE_URL: string;
}

const DEFAULT_PULL_LIMIT = 100;
const MAX_PULL_LIMIT = 500;

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    switch (`${request.method} ${pathname}`) {
      case "POST /hooks/twilio": return handleTwilioWebhook(request, env, ctx);
      case "POST /hooks/pebble": return handlePebbleWebhook(request, env, ctx);
      case "GET /pull":          return handlePull(request, env);
      case "GET /watch":         return handleWatch(request, env);
      default:                   return new Response("not found", { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;

async function handleTwilioWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

  const seq = await appendEvent(env.DB, {
    source: "twilio",
    // Stable across Twilio's retries, so redelivery is a no-op. Assumes this endpoint only
    // receives incoming-message webhooks: status callbacks reuse MessageSid and would be dropped as duplicates.
    externalId: formFields.get("MessageSid") ?? crypto.randomUUID(),
    contentType: request.headers.get("Content-Type") ?? "application/x-www-form-urlencoded",
    payload,
  });

  if (seq !== null) announceNewEvent(env, ctx);

  // Empty TwiML acknowledges the message without auto-replying to the sender.
  return new Response("<Response/>", { headers: { "Content-Type": "text/xml" } });
}

/**
 * Index ring webhook (multipart/form-data). Auth is `Authorization: Bearer <PEBBLE_SECRET>`,
 * configured as a custom header in the app. Only the text fields are stored: audio is dropped.
 */
async function handlePebbleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!hasValidBearerToken(request, env.PEBBLE_SECRET)) return unauthorized();

  // formData() throws on any other content type, e.g. a bare curl with no body.
  const form = await request.formData().catch(() => null);
  if (!form) return new Response("expected multipart/form-data", { status: 400 });

  const audio = form.get("audio");

  const seq = await appendEvent(env.DB, {
    source: "pebble",
    // Stable across the app's retries, so redelivery is a no-op.
    externalId: request.headers.get("X-Index-Delivery") ?? crypto.randomUUID(),
    contentType: "application/json",
    payload: JSON.stringify({
      trigger: request.headers.get("X-Index-Trigger"),
      isTest: request.headers.get("X-Index-Test") === "true",
      recordedAt: Number(form.get("recordedAt")) || null, // epoch ms
      transcription: form.get("transcription"),
      audioBytes: audio instanceof File ? audio.size : null,
    }),
  });

  if (seq !== null) announceNewEvent(env, ctx);

  // 200 even for a duplicate: the app only needs to know the delivery succeeded.
  return new Response(null, { status: 200 });
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

/**
 * GET /watch?after=<seq> with `Upgrade: websocket`: the same events as /pull, pushed as they arrive.
 * Each message is `{"events": [...]}`. Send "ping" to get "pong" as a keepalive.
 */
function handleWatch(request: Request, env: Env): Promise<Response> | Response {
  if (!hasValidBearerToken(request, env.READ_TOKEN)) return unauthorized();
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("expected a websocket upgrade", { status: 426 });
  }
  return env.WATCHERS.getByName("all").fetch(request);
}

/** Tells connected watchers to fetch what's new. Runs after the response so webhooks stay fast. */
function announceNewEvent(env: Env, ctx: ExecutionContext): void {
  ctx.waitUntil(env.WATCHERS.getByName("all").notify().catch((error) => console.error("notify failed", error)));
}

function unauthorized(): Response {
  return new Response("unauthorized", { status: 401 });
}

function parseNonNegativeInt(text: string | null, fallback: number): number {
  const parsed = Number.parseInt(text ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
