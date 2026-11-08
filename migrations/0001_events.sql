-- seq is the cursor the local agent pulls by. AUTOINCREMENT keeps it from being reused after pruning.
CREATE TABLE events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT    NOT NULL,
  external_id  TEXT    NOT NULL,
  received_at  INTEGER NOT NULL, -- epoch ms
  content_type TEXT    NOT NULL,
  payload      TEXT    NOT NULL, -- raw request body, untouched
  UNIQUE (source, external_id)
);
