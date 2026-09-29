import {
  builtInTarget,
  createTableStatements,
  isMultiIndex,
  SETTINGS_TABLE,
  WRITE_GUARD_TABLE,
  type ResolvedSchema,
} from "@hot-updater/server/database";
import { generateEngineSql, type ToolingTarget } from "@hot-updater/server/db";

import {
  SUPABASE_APPLY_FUNCTION,
  SUPABASE_TABLE_PREFIX,
} from "./supabaseInfrastructureNames";

export {
  SUPABASE_APPLY_FUNCTION,
  SUPABASE_SETTINGS_TABLE,
  SUPABASE_TABLE_PREFIX,
} from "./supabaseInfrastructureNames";

/** Every table the apply RPC may name: models, index tables, settings, and the write guard. */
export const supabaseTableNames = (
  schema: ResolvedSchema = builtInTarget.schema,
): string[] =>
  [
    ...schema.tables.flatMap((table) => [
      table.name,
      ...table.indexes
        .filter((index) => isMultiIndex(table, index))
        .map((index) => `${table.name}__${index.name}`),
    ]),
    SETTINGS_TABLE.name,
    WRITE_GUARD_TABLE.name,
  ].map((name) => SUPABASE_TABLE_PREFIX + name);

/** The words the SQL core's statements use besides quoted names, numbers, and operators. */
const KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "AND",
  "OR",
  "NOT",
  "EXISTS",
  "INSERT",
  "INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE",
  "ORDER",
  "BY",
  "ASC",
  "DESC",
  "LIMIT",
  "IS",
  "NULL",
  "ON",
  "CONFLICT",
  "DO",
  "JOIN",
  "FOR",
  "bigint",
  "double",
  "precision",
  "boolean",
  "jsonb",
  "i",
  "b",
];

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * Runs a batch of the SQL core's statements in the caller's transaction and
 * privileges (service role only), with every parameter read from one jsonb
 * array. Only the core's statement shapes on Hot Updater's tables pass: one
 * statement each, no literal, comment, or function call, and no word the
 * core does not write.
 */
const applyFunction = (
  tables: readonly string[],
) => `CREATE OR REPLACE FUNCTION public.${SUPABASE_APPLY_FUNCTION}(p_statements jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $apply$
DECLARE
  item jsonb;
  statement text;
  shape text;
  target text;
  found record;
  rows jsonb;
  changed bigint;
  results jsonb := '[]'::jsonb;
BEGIN
  FOR item IN SELECT value FROM jsonb_array_elements(p_statements) LOOP
    statement := item->>'sql';
    FOR target IN SELECT (regexp_matches(statement, '(?:FROM|INTO|UPDATE|JOIN) "([^"]+)"', 'g'))[1] LOOP
      IF NOT target = ANY (ARRAY[${tables.map(literal).join(", ")}]) THEN
        RAISE EXCEPTION '${SUPABASE_APPLY_FUNCTION}: % is not a Hot Updater table', target USING ERRCODE = '42501';
      END IF;
    END LOOP;
    shape := regexp_replace(regexp_replace(statement, '^INSERT INTO "[^"]+" \\(', 'INSERT INTO ('), '"[^"]*"', '"', 'g');
    IF shape !~ '^(SELECT|INSERT INTO|UPDATE|DELETE FROM) '
      OR shape ~ '"[[:space:]]*\\('
      OR shape ~ '[;''\\\\]|--|/\\*'
      OR regexp_replace(shape, '\\m(${KEYWORDS.join("|")})\\M', '', 'gi') !~ '^[[:space:]"(),.*=<>+0-9$:-]*$' THEN
      RAISE EXCEPTION '${SUPABASE_APPLY_FUNCTION}: statement not allowed' USING ERRCODE = '42501';
    END IF;
    IF statement ~ '^SELECT ' THEN
      rows := '[]'::jsonb;
      FOR found IN EXECUTE statement USING item->'params' LOOP
        rows := rows || jsonb_build_array(to_jsonb(found));
      END LOOP;
      results := results || jsonb_build_array(jsonb_build_object('rows', rows, 'changes', 0));
    ELSE
      EXECUTE statement USING item->'params';
      GET DIAGNOSTICS changed = ROW_COUNT;
      results := results || jsonb_build_array(jsonb_build_object('rows', '[]'::jsonb, 'changes', changed));
    END IF;
  END LOOP;
  RETURN results;
END;
$apply$`;

/**
 * Supabase's migration: the shared SQL schema under the table prefix, the
 * write guard, row-level security on every table (no policy, so only the
 * service role reads or writes), the apply RPC for the service role alone,
 * and the settings rows last. Every statement can run again, so a migration
 * for a server's plugin tables repeats the built-in ones.
 */
export const supabaseSchemaStatements = ({
  schema,
  settings: expected,
}: ToolingTarget = builtInTarget): string[] => {
  const engine = generateEngineSql("postgresql", schema, expected, {
    tablePrefix: SUPABASE_TABLE_PREFIX,
  });
  const settings = engine.slice(-Object.keys(expected).length);
  const tables = supabaseTableNames(schema);
  const apply = `public.${SUPABASE_APPLY_FUNCTION}(jsonb)`;
  return [
    ...createTableStatements(
      "postgresql",
      [WRITE_GUARD_TABLE],
      SUPABASE_TABLE_PREFIX,
    ),
    ...engine.slice(0, -settings.length),
    ...tables.map(
      (table) => `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
    ),
    applyFunction(tables),
    `REVOKE EXECUTE ON FUNCTION ${apply} FROM PUBLIC, anon, authenticated`,
    `GRANT EXECUTE ON FUNCTION ${apply} TO service_role`,
    ...settings,
  ];
};

export const supabaseSchemaSql = (target?: ToolingTarget): string =>
  `-- HotUpdater.schema\n\n${supabaseSchemaStatements(target)
    .map((statement) => `${statement};`)
    .join("\n\n")}\n`;
