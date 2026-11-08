export interface IncomingEvent {
  source: string;
  externalId: string;
  contentType: string;
  payload: string;
}

export interface StoredEvent extends IncomingEvent {
  seq: number;
  receivedAt: number; // epoch ms
}

/**
 * Appends an event unless one with the same (source, externalId) already exists.
 * Returns the new sequence number, or null for a duplicate delivery.
 */
export async function appendEvent(db: D1Database, event: IncomingEvent): Promise<number | null> {
  const row = await db
    .prepare(
      `INSERT INTO events (source, external_id, received_at, content_type, payload)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (source, external_id) DO NOTHING
       RETURNING seq`,
    )
    .bind(event.source, event.externalId, Date.now(), event.contentType, event.payload)
    .first<{ seq: number }>();

  return row?.seq ?? null;
}

/** Events with a sequence number greater than `afterSeq`, oldest first. */
export async function readEventsAfter(
  db: D1Database,
  afterSeq: number,
  limit: number,
): Promise<StoredEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT seq,
              source,
              external_id  AS externalId,
              received_at  AS receivedAt,
              content_type AS contentType,
              payload
       FROM events
       WHERE seq > ?
       ORDER BY seq
       LIMIT ?`,
    )
    .bind(afterSeq, limit)
    .all<StoredEvent>();

  return results;
}
