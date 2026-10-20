/** The record layouts, by name (record-storage-layout.md). */
import type { Lru } from '../lru.js'
import type { Store } from '../types.js'
import { HomeStore, KeyedLayout } from './keyed.js'
import type { LayoutName, RecordSet, RecordSets } from './types.js'

export {
  HomeStore,
  type Inherited,
  KeyedLayout,
  layoutConfig,
  type MergePlan,
  MissingRecordError,
  packIdsFor,
  type ReclaimPlan,
  UPLOAD_PACK_FINAL_RAW,
} from './keyed.js'
export { headConfig, type LayerInfo, type PackInfo, pendingConfig } from './kit.js'
export * from './types.js'

/** A set's home under the collection's: `runs/<collection>/<set>/` holds its files. */
export const setHome = (collection: string, set: RecordSet) => `${collection}/${set}`

/** The record stores for `name`, a set each (null for today's leaf bodies). */
export function recordStore(
  name: LayoutName,
  lru: Lru<unknown>,
  scope: string,
  /** The location's store and the collection whose prefix (`runs/<collection>/`) holds its files. */
  own?: { root: Store; home: string },
): RecordSets | null {
  switch (name) {
    case 'today':
      return null
    case 'f': {
      if (!own) throw new Error('Layout f keeps records per collection: it needs the collection')
      const set = (s: RecordSet) =>
        new KeyedLayout(new HomeStore(own.root, setHome(own.home, s)), lru, `${scope}/${s}`)
      return { public: set('public'), private: set('private') }
    }
  }
}
