// Storage factory for Stage 1 (v2.0):
//   - When `env.DB` is bound -> Cloudflare D1 implementation (`d1Store.js` + lazy KV migration)
//   - Otherwise              -> Workers KV implementation (`kvStore.js`, 100% identical to v1.11.0)

import { SCHEMA_VERSION, ensureSchema } from './d1Schema.js';
import { cleanupExpiredMaps, createD1Store, shouldRunDailyCleanup } from './d1Store.js';
import { createKvStore } from './kvStore.js';
import {
  DEFAULT_MIGRATE_BATCH_SIZE,
  MIGRATE_QUERY_BUDGET,
  ensureVisitorMigrated,
  getStorageStatus,
  markVisitorMigratedInCache,
  migrateVisitor,
  migrateVisitorsBatch,
} from './migrate.js';

export {
  DEFAULT_MIGRATE_BATCH_SIZE,
  MIGRATE_QUERY_BUDGET,
  SCHEMA_VERSION,
  cleanupExpiredMaps,
  ensureSchema,
  ensureVisitorMigrated,
  getStorageStatus,
  migrateVisitor,
  migrateVisitorsBatch,
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
