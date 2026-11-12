/**
 * Writes test/vectors/v3-files.json: rows, and the file id and footer content
 * they must produce (docs/protocol-v3.md, Section 3); and v3-commits.json: commits
 * with their bytes, version ids, and signatures (Section 4). A second implementation
 * checks itself against these. Run with `pnpm --filter @underlay/protocol vectors:v3`
 * only when the format changes, and say so in the commit.
 */
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ed25519Signer, hashRecord, sha256Hex, v3 } from '../src/index.js'

const rec = (type: string, id: string, data: unknown, commit?: number) => ({
  kind: 'r' as const,
  type,
  id,
  line: hashRecord(id, type, data).canonical,
  ...(commit === undefined ? {} : { commit }),
})
const rem = (type: string, id: string, commit?: number) => ({
  kind: 'x' as const,
  type,
  id,
  line: v3.removalLine(id, type),
  ...(commit === undefined ? {} : { commit }),
})

/** Rows too many to list: `count` records of type `t`, ids 0000 up, made by `generated()`. */
interface Generated {
  count: number
  /** 0: data is the number i. Otherwise data is {"text": "abcdefghij" repeated, "n": i}. */
  repeat: number
}
const generated = (g: Generated): v3.WriteRow[] =>
  Array.from({ length: g.count }, (_, i) =>
    rec(
      't',
      String(i).padStart(4, '0'),
      g.repeat ? { text: 'abcdefghij'.repeat(g.repeat), n: i } : i,
    ),
  )

const cases: { name: string; labeled: boolean; rows?: v3.WriteRow[]; generated?: Generated }[] = [
  { name: 'empty', labeled: false, rows: [] },
  {
    name: 'one record',
    labeled: false,
    rows: [rec('work', '10.1000/abc', { title: 'On Sorting', year: 2024 })],
  },
  {
    name: 'records, a removal, reserved types, and non-ASCII keys',
    labeled: false,
    rows: [
      rec('$meta', 'collection', { name: 'Vectors' }),
      rec('$schema', 'work', { type: 'object' }),
      rec('author', 'é', { name: 'É' }),
      rec('author', '\uffff', 1),
      rec('author', '\u{10000}', 2),
      rem('work', '10.1000/gone'),
      rec('work', '10.1000/kept', { '10': 1, '9': 2, a: [null, true, 1.5, 'x'] }),
    ],
  },
  { name: 'two record blocks', labeled: false, generated: { count: 300, repeat: 100 } },
  { name: 'two key blocks', labeled: false, generated: { count: 1030, repeat: 0 } },
  {
    name: 'labeled, with a shared line, removals, and a withheld row',
    labeled: true,
    rows: [
      rec('t', 'a', { v: 1 }, 1),
      rec('t', 'a', { v: 1 }, 4),
      rec('t', 'a', { v: 2 }, 6),
      rec('t', 'b', { v: 1 }, 2),
      rem('t', 'b', 3),
      rem('t', 'b', 5),
      {
        kind: 'w',
        type: 't',
        id: 'c',
        hash: sha256Hex('{"id":"c","type":"t","data":0}'),
        size: 30,
        commit: 2,
      },
      rec('t', 'c', { v: 3 }, 8),
    ],
  },
]

const out = []
for (const c of cases) {
  const f = await v3.writeFileBytes(c.rows ?? generated(c.generated!), { labeled: c.labeled })
  out.push({
    name: c.name,
    labeled: c.labeled,
    ...(c.rows ? { rows: c.rows } : { generated: c.generated }),
    id: f.id,
    content: f.content,
  })
}
if (import.meta.url !== `file://${process.argv[1]}`) throw new Error('run as a script')
const path = resolve(dirname(fileURLToPath(import.meta.url)), '../test/vectors/v3-files.json')
writeFileSync(path, JSON.stringify({ underlay: 3, cases: out }, null, 1) + '\n')
console.log(`wrote ${out.length} cases to ${path}`)

// --- Commits: the bytes, the version id, and both signatures, from fixed keys ---

const seed = (n: number) => Buffer.from(new Uint8Array(32).fill(n)).toString('base64url')
const author = await ed25519Signer(seed(1))
const server = await ed25519Signer(seed(2))
const file = out[1]!
const ref = v3.fileRef(file.id, file.content as v3.FileContent)
const unsignedCommit: v3.Commit = {
  underlay: 3,
  collection: 'vectors',
  number: 1,
  previous: null,
  semver: 'v1.0.0',
  createdAt: '2026-11-10T00:00:00.000Z',
  changes: [await v3.makeChange('vectors', { files: [ref], message: 'first' })],
  keyId: null,
  sig: null,
}
const firstId = v3.versionId(v3.commitBytes(unsignedCommit))
const signedChange = await v3.makeChange(
  'vectors',
  { files: [], base: firstId, message: null },
  author,
)
const signedCommit = await v3.signObject(
  {
    underlay: 3,
    collection: 'vectors',
    number: 2,
    previous: firstId,
    semver: 'v1.0.1',
    createdAt: '2026-11-10T00:00:01.000Z',
    changes: [signedChange],
    keyId: null,
    sig: null,
  } as v3.Commit,
  server,
)
const commits = [unsignedCommit, signedCommit].map((commit) => ({
  commit,
  id: v3.versionId(v3.commitBytes(commit)),
}))
const commitsPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../test/vectors/v3-commits.json',
)
writeFileSync(
  commitsPath,
  JSON.stringify(
    {
      underlay: 3,
      note: 'A commit is the JCS of `commit`; its version id is ulv3: and the SHA-256 of those bytes. Signatures are Ed25519 over the JCS of the signed object without `sig`; the private keys are 32 bytes of 0x01 (author) and 0x02 (server).',
      keys: { author: author.publicKey, server: server.publicKey },
      commits,
    },
    null,
    1,
  ) + '\n',
)
console.log(`wrote ${commits.length} commits to ${commitsPath}`)
