// Storage factory for Stage 1 (v2.0):
//   - When `env.DB` is bound -> Cloudflare D1 implementation (`d1Store.js` + lazy KV migration)
//   - Otherwise              -> Workers KV implementation (`kvStore.js`, 100% identical to v1.11.0)

import { SCHEMA_VERSION, ensureSchema } from './d1Schema.js';
import {
  ALLOWED_CHAT_RETENTION_DAYS,
  DEFAULT_SEARCH_LIMIT,
  MAX_HISTORY_PAGE_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_QUERY_LEN,
  RETENTION_DELETE_BATCH_SIZE,
  RETENTION_MAX_BATCHES_PER_RUN,
  cleanupExpiredMaps,
  createD1Store,
  escapeLikePattern,
  normalizeChatRetentionDays,
  shouldRunDailyCleanup,
} from './d1Store.js';
import { createKvStore } from './kvStore.js';
import {
  DEFAULT_MIGRATE_BATCH_SIZE,
  MIGRATE_QUERY_BUDGET,
  ensureVisitorMigrated,
  ensureVisitorsBackfilled,
  getStorageStatus,
  isVisitorsBackfilled,
  markVisitorMigratedInCache,
  migrateVisitor,
  migrateVisitorsBatch,
} from './migrate.js';

export {
  ALLOWED_CHAT_RETENTION_DAYS,
  DEFAULT_MIGRATE_BATCH_SIZE,
  DEFAULT_SEARCH_LIMIT,
  MAX_HISTORY_PAGE_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_QUERY_LEN,
  MIGRATE_QUERY_BUDGET,
  RETENTION_DELETE_BATCH_SIZE,
  RETENTION_MAX_BATCHES_PER_RUN,
  SCHEMA_VERSION,
  cleanupExpiredMaps,
  ensureSchema,
  ensureVisitorMigrated,
  ensureVisitorsBackfilled,
  escapeLikePattern,
  getStorageStatus,
  isVisitorsBackfilled,
  migrateVisitor,
  migrateVisitorsBatch,
  normalizeChatRetentionDays,
  shouldRunDailyCleanup,
};

export {
  DM_MAP_PREFIX,
  DM_MAP_TTL_SECONDS,
  HISTORY_CACHE_TTL_SECONDS,
  MAX_LINKS,
  MAX_MESSAGES,
  MAX_PHOTOS,
  MAX_PM_IDS,
  TOPIC_MSG_MAP_PREFIX,
  TOPIC_MSG_MAP_TTL_SECONDS,
  VISIT_COUNT_TTL_SECONDS,
  VISIT_SEEN_TTL_SECONDS,
} from './kvStore.js';

export function getStore(env) {
  if (env?.DB) {
    return createD1Store(env, {
      ensureMigrated: ensureVisitorMigrated,
      markMigrated: markVisitorMigratedInCache,
    });
  }
  return createKvStore(env);
}
