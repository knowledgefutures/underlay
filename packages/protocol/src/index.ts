/**
 * @underlay/protocol: Underlay data lives in a bucket; this package reads and
 * writes it. The format (JCS, hashing, input rules, validation, trees, roots),
 * the repository layout and signed version log, and the stores.
 */
export * from './format.js'
export * from './repo/types.js'
export * from './repo/repo.js'
// Record layouts: today's (leaf bodies) and F (packs per collection and set), record-storage-layout.md.
export {
  headConfig,
  HomeStore,
  type Inherited,
  type HeldRun,
  KeyedLayout,
  LAYOUTS,
  type LayerInfo,
  type LayoutName,
  layoutConfig,
  type LiveSet,
  type MergePlan,
  type PackInfo,
  MissingRecordError,
  RECLAIM_MAX_RUNS,
  type ReclaimPlan,
  recordIdKey,
  recordKey,
  type RecordSet,
  type RecordSets,
  setHome,
  TooManyRunsError,
  type TypedLeaf,
} from './repo/layouts/index.js'
export { LiveHashes, markRange, recordRoots, type TypedRoot } from './repo/layouts/reclaim.js'
export {
  fsck,
  type FsckCursor,
  type FsckOptions,
  type FsckReport,
  fsckStep,
  type FsckStepOptions,
} from './repo/fsck.js'
export * from './repo/log.js'
export { schemaRelaxes } from './schema-relax.js'
export {
  chunkLines,
  gunzip,
  gunzipChunks,
  gunzipMembers,
  gunzipStream,
  gunzipText,
  gzip,
  isGzip,
  splitLines,
} from './repo/gzip.js'
export { Lru } from './repo/lru.js'
export {
  type BuildInput,
  type BuildResult,
  type BuildTypeInput,
  buildVersion,
  type ChangeSource,
  isPrivateSchema,
} from './repo/build.js'
export {
  applyFileSet,
  declaredFiles,
  referenceCounts,
  FileRefDelta,
  type FileSetResult,
  type FileSizes,
  MissingFilesError,
  rebuildFileRefs,
  type SetName,
  tracksTypes,
  typeFileRefs,
} from './repo/file-sets.js'
export {
  type PackObject,
  type PackOptions,
  packVersion,
  type ReceiveOptions,
  type ReceiveResult,
  receiveVersion,
  type SyncSets,
  type SyncTree,
  treeObjects,
  type VersionWork,
  versionWork,
} from './repo/sync.js'
export { type TarEntry, tarChunks, type TarFile, tarStream, untar } from './repo/tar.js'
export { blobObject, MemoryStore, memoryStore } from './stores/memory.js'
export {
  type LifecycleRule,
  type S3Config,
  s3CopyLimits,
  S3Error,
  S3Store,
  s3Store,
} from './stores/s3.js'
export { FileStore, fileStore, type FileStoreOptions, serveSignedBlob } from './stores/fs.js'
export { type R2BucketLike, r2Store } from './stores/r2.js'
