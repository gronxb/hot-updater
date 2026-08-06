import type { KyselyAnalyticsDialect } from "./kyselyMigrationSql.js";
import type { KyselyAnalyticsCatalogCheck } from "./kyselySchemaCatalog.js";

export const v1CheckNames = [
  "bundle_events_type_check",
  "bundle_events_update_strategy_check",
] as const;

export const v2CheckNames = [
  "bundle_events_type_v038_check",
  "bundle_events_update_strategy_v038_check",
  "bundle_events_shape_v038_check",
] as const;

const portableCheckDefinitions: ReadonlyMap<string, string> = new Map([
  [v1CheckNames[0], "type in ('UPDATE_APPLIED', 'RECOVERED')"],
  [v1CheckNames[1], "update_strategy in ('fingerprint', 'appVersion')"],
  [v2CheckNames[0], "type in ('UPDATE_APPLIED', 'RECOVERED', 'UNCHANGED')"],
  [
    v2CheckNames[1],
    "update_strategy is null or update_strategy in ('fingerprint', 'appVersion')",
  ],
  [
    v2CheckNames[2],
    "(type in ('UPDATE_APPLIED', 'RECOVERED') and from_bundle_id is not null and update_strategy is not null) or (type = 'UNCHANGED' and from_bundle_id is null and update_strategy is null)",
  ],
]);

const postgresCheckDefinitions: ReadonlyMap<string, string> = new Map([
  [
    v1CheckNames[0],
    "CHECK ((type = ANY (ARRAY['UPDATE_APPLIED'::text, 'RECOVERED'::text])))",
  ],
  [
    v1CheckNames[1],
    "CHECK ((update_strategy = ANY (ARRAY['fingerprint'::text, 'appVersion'::text])))",
  ],
  [
    v2CheckNames[0],
    "CHECK ((type = ANY (ARRAY['UPDATE_APPLIED'::text, 'RECOVERED'::text, 'UNCHANGED'::text])))",
  ],
  [
    v2CheckNames[1],
    "CHECK (((update_strategy IS NULL) OR (update_strategy = ANY (ARRAY['fingerprint'::text, 'appVersion'::text]))))",
  ],
  [
    v2CheckNames[2],
    "CHECK ((((type = ANY (ARRAY['UPDATE_APPLIED'::text, 'RECOVERED'::text])) AND (from_bundle_id IS NOT NULL) AND (update_strategy IS NOT NULL)) OR ((type = 'UNCHANGED'::text) AND (from_bundle_id IS NULL) AND (update_strategy IS NULL))))",
  ],
]);

const mysqlCheckDefinitions: ReadonlyMap<string, string> = new Map([
  [v1CheckNames[0], "(type in ('UPDATE_APPLIED', 'RECOVERED'))"],
  [v1CheckNames[1], "(update_strategy in ('fingerprint', 'appVersion'))"],
  [v2CheckNames[0], "(type in ('UPDATE_APPLIED', 'RECOVERED', 'UNCHANGED'))"],
  [
    v2CheckNames[1],
    "((update_strategy is null) or (update_strategy in ('fingerprint', 'appVersion')))",
  ],
  [
    v2CheckNames[2],
    "(((type in ('UPDATE_APPLIED', 'RECOVERED')) and (from_bundle_id is not null) and (update_strategy is not null)) or ((type = 'UNCHANGED') and (from_bundle_id is null) and (update_strategy is null)))",
  ],
]);

function checkDefinitionsFor(
  dialect: KyselyAnalyticsDialect,
): ReadonlyMap<string, string> {
  switch (dialect) {
    case "postgresql":
      return postgresCheckDefinitions;
    case "mysql":
      return mysqlCheckDefinitions;
    case "sqlite":
      return portableCheckDefinitions;
  }
}

function normalizeCheckDefinition(definition: string): string {
  return definition
    .replaceAll("\\'", "'")
    .split(/('(?:''|[^'])*')/)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part
        .replaceAll(/_[a-z0-9]+$/gi, "")
        .toLowerCase()
        .replaceAll(/[\s"`]/g, "");
    })
    .join("");
}

export function checksHaveExactDefinitions(
  checks: readonly KyselyAnalyticsCatalogCheck[],
  dialect: KyselyAnalyticsDialect,
): boolean {
  const definitions = checkDefinitionsFor(dialect);
  return checks.every(({ definition, name }) => {
    const expected = definitions.get(name);
    return (
      expected !== undefined &&
      normalizeCheckDefinition(definition) ===
        normalizeCheckDefinition(expected)
    );
  });
}
