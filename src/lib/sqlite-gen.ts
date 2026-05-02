/**
 * SQLite generation for collection versions.
 *
 * Converts a version's schemas + records into a SQLite database.
 * Used server-side (better-sqlite3) to generate .sqlite files on demand.
 */
import Database from "better-sqlite3";

interface SchemaProperty {
  type?: string;
  format?: string;
  "x-ref-type"?: string;
  items?: { type?: string };
}

interface TypeSchema {
  type?: string;
  properties?: Record<string, SchemaProperty>;
}

interface Record {
  recordId: string;
  type: string;
  data: unknown;
}

/**
 * Map a JSON Schema property type to a SQLite column type.
 */
function sqliteType(prop: SchemaProperty): string {
  switch (prop.type) {
    case "integer":
      return "INTEGER";
    case "number":
      return "REAL";
    case "boolean":
      return "INTEGER"; // 0/1
    case "array":
    case "object":
      return "TEXT"; // JSON-serialized
    default:
      return "TEXT";
  }
}

/**
 * Sanitize a name for use as a SQL identifier.
 */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Generate CREATE TABLE DDL for a type schema.
 */
export function generateDDL(typeName: string, typeSchema: TypeSchema): string {
  const cols: string[] = [`"_record_id" TEXT PRIMARY KEY`];

  if (typeSchema.properties) {
    for (const [fieldName, fieldDef] of Object.entries(typeSchema.properties)) {
      cols.push(`${ident(fieldName)} ${sqliteType(fieldDef)}`);
    }
  }

  return `CREATE TABLE ${ident(typeName)} (\n  ${cols.join(",\n  ")}\n);`;
}

/**
 * Generate DDL for all types in a schema set.
 */
export function generateAllDDL(schemas: Record<string, TypeSchema>): string {
  return Object.entries(schemas)
    .map(([name, schema]) => generateDDL(name, schema))
    .join("\n\n");
}

/**
 * Build a SQLite database (in-memory) from schemas and records, return as Buffer.
 */
export function buildSqliteBuffer(
  schemas: Record<string, TypeSchema>,
  records: Record[],
): Buffer {
  const db = new Database(":memory:");

  // Create tables
  for (const [typeName, typeSchema] of Object.entries(schemas)) {
    const ddl = generateDDL(typeName, typeSchema);
    db.exec(ddl);
  }

  // Insert records grouped by type
  const byType = new Map<string, Record[]>();
  for (const rec of records) {
    const arr = byType.get(rec.type) ?? [];
    arr.push(rec);
    byType.set(rec.type, arr);
  }

  for (const [typeName, typeRecords] of byType) {
    const typeSchema = schemas[typeName];
    if (!typeSchema?.properties) continue;

    const fields = Object.keys(typeSchema.properties);
    const colNames = ["_record_id", ...fields].map(ident).join(", ");
    const placeholders = ["?", ...fields.map(() => "?")].join(", ");
    const insertStmt = db.prepare(
      `INSERT OR IGNORE INTO ${ident(typeName)} (${colNames}) VALUES (${placeholders})`,
    );

    const insertMany = db.transaction((recs: Record[]) => {
      for (const rec of recs) {
        const data = rec.data as any;
        const values = [
          rec.recordId,
          ...fields.map((f) => {
            const val = data?.[f];
            if (val === undefined || val === null) return null;
            if (typeof val === "object") return JSON.stringify(val);
            if (typeof val === "boolean") return val ? 1 : 0;
            return val;
          }),
        ];
        insertStmt.run(...values);
      }
    });

    insertMany(typeRecords);
  }

  // Export as buffer
  const buffer = db.serialize();
  db.close();
  return Buffer.from(buffer);
}
