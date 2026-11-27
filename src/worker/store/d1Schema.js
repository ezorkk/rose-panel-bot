// Cloudflare D1 schema definition & per-isolate automatic DDL initializer (Stage 1–3, v2.0–v2.2).
// Deployers never need to run manual SQL migrations: `ensureSchema(env)` runs idempotently
// via `env.DB.batch([...])` and caches the resolved Promise per `env.DB` binding instance.

export const SCHEMA_VERSION = 3;

const SCHEMA_DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id               TEXT NOT NULL,
    uid              TEXT NOT NULL,
    sender           TEXT NOT NULL,
    pm_message_id    INTEGER,
    topic_msg_id     INTEGER,
    topic_copy_id    INTEGER,
    topic_thread_id  INTEGER,
    topic_chat_id    TEXT,
    dm_msg_id        INTEGER,
    dm_copy_id       INTEGER,
    text             TEXT,
    media_tag        TEXT,
    photo_file_id    TEXT,
    thumb_file_id    TEXT,
    sticker_file_id  TEXT,
    sticker_format   TEXT,
    visitor_reaction TEXT,
    owner_reaction   TEXT,
    created_at       INTEGER NOT NULL,
    PRIMARY KEY (uid, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_uid_time ON messages(uid, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_uid_pm ON messages(uid, pm_message_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(created_at)`,
  `CREATE TABLE IF NOT EXISTS message_links (
    message_id TEXT NOT NULL,
    uid        TEXT NOT NULL,
    url        TEXT NOT NULL,
    snippet    TEXT,
    sender     TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_links_uid_time ON message_links(uid, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_links_time ON message_links(created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_links_uniq ON message_links(uid, message_id, url)`,
  `CREATE TABLE IF NOT EXISTS topic_map (
    group_id      TEXT NOT NULL,
    topic_msg_id  INTEGER NOT NULL,
    uid           TEXT NOT NULL,
    pm_message_id INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (group_id, topic_msg_id)
  )`,
  `CREATE TABLE IF NOT EXISTS dm_map (
    owner_msg_id  INTEGER PRIMARY KEY,
    uid           TEXT NOT NULL,
    pm_message_id INTEGER,
    created_at    INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS migrated_visitors (
    uid         TEXT PRIMARY KEY,
    migrated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS visitors (
    uid          TEXT PRIMARY KEY,
    data         TEXT NOT NULL,
    last_seen_at INTEGER,
    source       TEXT,
    updated_at   INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_visitors_last_seen ON visitors(last_seen_at)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key        TEXT PRIMARY KEY,
    count      INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expires_at)`,
  `CREATE TABLE IF NOT EXISTS visit_seen (
    month TEXT NOT NULL,
    uid   TEXT NOT NULL,
    in_kv INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (month, uid)
  )`,
  `CREATE TABLE IF NOT EXISTS music_tracks (
    id             TEXT PRIMARY KEY,
    file_id        TEXT NOT NULL,
    file_unique_id TEXT NOT NULL DEFAULT '',
    title          TEXT NOT NULL,
    performer      TEXT NOT NULL DEFAULT '',
    duration       INTEGER NOT NULL DEFAULT 0,
    source_url     TEXT NOT NULL DEFAULT '',
    source_title   TEXT NOT NULL DEFAULT '',
    sort_order     INTEGER NOT NULL DEFAULT 0,
    added_at       INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_music_tracks_order ON music_tracks(sort_order, added_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_music_tracks_uniq_nonempty ON music_tracks(file_unique_id) WHERE file_unique_id != ''`,
];

const schemaInitCache = new WeakMap();
const d1SinceCache = new WeakMap();

async function runSchemaInit(db) {
  const nowStr = String(Date.now());
  const statements = SCHEMA_DDL_STATEMENTS.map((sql) => db.prepare(sql));
  statements.push(
    db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)`).bind(String(SCHEMA_VERSION)),
    db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('d1_since', ?)`).bind(nowStr),
    db.prepare(`SELECT key, value FROM meta WHERE key IN ('schema_version', 'd1_since')`)
  );

  const results = await db.batch(statements);
  const metaRows = results[results.length - 1]?.results || [];
  let currentVersion = 0;
  let d1SinceMs = Number(nowStr);
  for (const row of metaRows) {
    if (row?.key === 'schema_version') {
      currentVersion = Number(row.value || 0);
    } else if (row?.key === 'd1_since') {
      const parsed = Number(row.value);
      if (Number.isFinite(parsed) && parsed > 0) d1SinceMs = Math.trunc(parsed);
    }
  }
  d1SinceCache.set(db, d1SinceMs);

  // Future schema versions (> 1) apply incremental upgrades here without dropping tables.
  if (currentVersion < SCHEMA_VERSION) {
    await db
      .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`)
      .bind(String(SCHEMA_VERSION))
      .run();
  }

  return SCHEMA_VERSION;
}

export async function getD1SinceMs(env) {
  const db = env?.DB;
  if (!db) return 0;
  if (d1SinceCache.has(db)) {
    return d1SinceCache.get(db);
  }
  await ensureSchema(env);
  if (d1SinceCache.has(db)) {
    return d1SinceCache.get(db);
  }
  const row = await db.prepare(`SELECT value FROM meta WHERE key = 'd1_since'`).first();
  const parsed = Number(row?.value);
  const ts = Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : Date.now();
  d1SinceCache.set(db, ts);
  return ts;
}

export function isSchemaInitialized(env) {
  return Boolean(env?.DB && schemaInitCache.has(env.DB));
}

export async function ensureSchema(env, options = {}) {
  const db = env?.DB;
  if (!db) return 0;

  const force = Boolean(options?.force);
  if (!force && schemaInitCache.has(db)) {
    return schemaInitCache.get(db);
  }

  const initPromise = runSchemaInit(db).catch((err) => {
    if (schemaInitCache.get(db) === initPromise) {
      schemaInitCache.delete(db);
    }
    throw err;
  });

  schemaInitCache.set(db, initPromise);
  return initPromise;
}
