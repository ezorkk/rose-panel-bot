// Storage factory for Stage 1 (v2.0):
//   - When `env.DB` is bound -> Cloudflare D1 implementation ( added in d1Store.js )
//   - Otherwise              -> Workers KV implementation (100% identical to v1.11.0)

import { createKvStore } from './kvStore.js';

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
  return createKvStore(env);
}
