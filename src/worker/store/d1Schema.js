// Cloudflare D1 schema definition & per-isolate automatic DDL initializer for Stage 1 (v2.0).
// Deployers never need to run manual SQL migrations: `ensureSchema(env)` runs idempotently
// via `env.DB.batch([...])` and caches the resolved Promise per `env.DB` binding instance.

export const SCHEMA_VERSION = 1;

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
];

const schemaInitCache = new WeakMap();

async function runSchemaInit(db) {
  const statements = SCHEMA_DDL_STATEMENTS.map((sql) => db.prepare(sql));
  statements.push(
    db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)`).bind(String(SCHEMA_VERSION))
  );
  statements.push(db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`));

  const results = await db.batch(statements);
  const versionRow = results[results.length - 1]?.results?.[0] || null;
  const currentVersion = Number(versionRow?.value || 0);

  // Future schema versions (> 1) apply incremental ALTER TABLE upgrades here without dropping tables.
  if (currentVersion < SCHEMA_VERSION) {
    await db
      .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`)
      .bind(String(SCHEMA_VERSION))
      .run();
  }

  return SCHEMA_VERSION;
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
