import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { hashSchema } from '../../lib/core/index.js'
import { setStagedSchema } from '../lib/staging.js'
import { requireRoot } from '../lib/store.js'
import { writeSchema } from '../lib/store.js'

export function schemaSet(file: string): void {
  const root = requireRoot()
  const content = readFileSync(resolve(file), 'utf-8')
  const schemas = JSON.parse(content) as Record<string, unknown>

  const typeSlugs = Object.keys(schemas)
  if (typeSlugs.length === 0) {
    console.error('Schema file must contain at least one type.')
    process.exit(1)
  }

  for (const slug of typeSlugs) {
    const body = schemas[slug]
    const hash = hashSchema(body)
    writeSchema(root, hash, JSON.stringify(body))
  }

  setStagedSchema(root, schemas)
  console.log(`Staged ${typeSlugs.length} type(s): ${typeSlugs.join(', ')}`)
}
