import pg from 'pg';

// Generates the Kysely `DB` interface from the migrated database, so there is no second
// hand-written schema that can drift (01_HLD section 9). It replaces kysely-codegen, whose files
// this workspace is not allowed to read (organization content policy); the output follows the
// same conventions. `pnpm --filter @vmgs/db codegen` rewrites src/types.generated.ts; a test
// fails when the committed file is out of date.

interface ColumnRow {
  table_name: string;
  column_name: string;
  udt: string;
  nullable: boolean;
  identity: string;
  generated: string;
  has_default: boolean;
}

/** Postgres type name -> TypeScript type as the `pg` driver returns it. */
const TYPE_MAP: Readonly<Record<string, string>> = {
  uuid: 'string',
  text: 'string',
  name: 'string',
  varchar: 'string',
  bpchar: 'string',
  // The driver returns `date` as a string here: createPool turns off its local-time Date parsing.
  date: 'string',
  bool: 'boolean',
  int2: 'number',
  int4: 'number',
  float4: 'number',
  float8: 'number',
  int8: 'Int8',
  numeric: 'Numeric',
  timestamptz: 'Timestamp',
  timestamp: 'Timestamp',
  json: 'Json',
  jsonb: 'Json',
  bytea: 'Buffer',
  _text: 'string[]',
  _varchar: 'string[]',
  _int4: 'number[]',
};

const HEADER = `// Generated from the migrated database by \`pnpm --filter @vmgs/db codegen\`. Do not edit by hand.
import type { ColumnType, Generated, GeneratedAlways } from 'kysely';

export type Int8 = ColumnType<string, bigint | number | string, bigint | number | string>;

export type Numeric = ColumnType<string, number | string, number | string>;

export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export type JsonValue = JsonArray | JsonObject | JsonPrimitive;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };
export type JsonPrimitive = boolean | number | string | null;

/** json and jsonb columns are read as parsed values and written as JSON text. */
export type Json = ColumnType<JsonValue, string, string>;
`;

function pascalCase(name: string): string {
  return name
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function columnType(column: ColumnRow, isView: boolean): string {
  const base = TYPE_MAP[column.udt];
  if (base === undefined) {
    throw new Error(
      `codegen: no TypeScript type for Postgres type "${column.udt}" (${column.table_name}.${column.column_name}). Add it to TYPE_MAP.`,
    );
  }
  const type = column.nullable || isView ? `${base} | null` : base;
  if (isView) return type;
  if (column.identity === 'a' || column.generated === 's') return `GeneratedAlways<${type}>`;
  if (column.identity === 'd' || column.has_default) return `Generated<${type}>`;
  return type;
}

/** The SQL text of the TypeScript file for the `public` schema of the database. */
export async function generateTypes(connectionString: string): Promise<string> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows: relations } = await client.query<{ relname: string; relkind: string }>(`
      SELECT c.relname, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v')
        AND NOT c.relispartition AND c.relname <> 'schema_migrations'
      ORDER BY c.relname`);
    const { rows: columns } = await client.query<ColumnRow>(`
      SELECT c.relname AS table_name, a.attname AS column_name, t.typname AS udt,
             NOT a.attnotnull AS nullable, a.attidentity::text AS identity,
             a.attgenerated::text AS generated, (d.adbin IS NOT NULL) AS has_default
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      JOIN pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v')
        AND NOT c.relispartition AND c.relname <> 'schema_migrations'
      ORDER BY c.relname, a.attnum`);

    const interfaces = relations.map((relation) => {
      const isView = relation.relkind === 'v';
      const lines = columns
        .filter((column) => column.table_name === relation.relname)
        .map((column) => `  ${column.column_name}: ${columnType(column, isView)};`);
      return `export interface ${pascalCase(relation.relname)} {\n${lines.join('\n')}\n}\n`;
    });
    const db = relations
      .map((relation) => `  ${relation.relname}: ${pascalCase(relation.relname)};`)
      .join('\n');

    return `${HEADER}\n${interfaces.join('\n')}\nexport interface DB {\n${db}\n}\n`;
  } finally {
    await client.end();
  }
}
