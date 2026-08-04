import type {
  HotUpdaterColumnSchema,
  HotUpdaterColumnType,
  HotUpdaterCheckSchema,
  HotUpdaterDefault,
  HotUpdaterForeignKeySchema,
  HotUpdaterIndexSchema,
  HotUpdaterRelationSchema,
  HotUpdaterTableSchema,
  HotUpdaterVersionedSchema,
} from "./types";

type DefaultValue = boolean | number | string | Record<string, unknown>;

export type HotUpdaterColumnDsl = {
  readonly dsl: "column";
  readonly ormName: string;
  readonly type: HotUpdaterColumnType;
  readonly default?: HotUpdaterDefault;
  readonly nullableValue?: true;
  readonly primaryKeyValue?: true;
  readonly nullable: () => HotUpdaterColumnDsl;
  readonly primaryKey: () => HotUpdaterColumnDsl;
  readonly defaultTo: (value: DefaultValue) => HotUpdaterColumnDsl;
};

export type HotUpdaterTableDsl = HotUpdaterTableSchema & {
  readonly dsl: "table";
};

const withDsl = <Value extends object, Dsl extends string>(
  value: Value,
  dsl: Dsl,
): Value & { readonly dsl: Dsl } =>
  Object.defineProperty(value, "dsl", {
    enumerable: false,
    value: dsl,
  }) as Value & { readonly dsl: Dsl };

const defaultValue = (value: DefaultValue): HotUpdaterDefault =>
  typeof value === "object"
    ? { type: "json", value }
    : { type: "literal", value };

const columnSchema = (column: HotUpdaterColumnDsl): HotUpdaterColumnSchema => ({
  ormName: column.ormName,
  type: column.type,
  ...(column.nullableValue ? { nullable: true } : {}),
  ...(column.primaryKeyValue ? { primaryKey: true } : {}),
  ...(column.default ? { default: column.default } : {}),
});

type ColumnState = HotUpdaterColumnSchema & {
  readonly nullableValue?: boolean;
  readonly primaryKeyValue?: boolean;
};

const createColumn = (state: ColumnState): HotUpdaterColumnDsl => ({
  dsl: "column",
  ormName: state.ormName,
  type: state.type,
  ...(state.nullableValue ? { nullableValue: true } : {}),
  ...(state.primaryKeyValue ? { primaryKeyValue: true } : {}),
  ...(state.default ? { default: state.default } : {}),
  nullable: () => createColumn({ ...state, nullableValue: true }),
  primaryKey: () => createColumn({ ...state, primaryKeyValue: true }),
  defaultTo: (value) =>
    createColumn({ ...state, default: defaultValue(value) }),
});

export const varchar = <Length extends number>(
  length: Length,
): `varchar(${Length})` => `varchar(${length})` as `varchar(${Length})`;

export const column = (
  ormName: string,
  type: HotUpdaterColumnType,
): HotUpdaterColumnDsl => createColumn({ ormName, type });

export const idColumn = (
  ormName: string,
  type: HotUpdaterColumnType,
): HotUpdaterColumnDsl => column(ormName, type).primaryKey();

export const uuid = (ormName: string): HotUpdaterColumnDsl =>
  column(ormName, "uuid");

export const integer = (ormName: string): HotUpdaterColumnDsl =>
  column(ormName, "integer");

export const float = (ormName: string): HotUpdaterColumnDsl =>
  column(ormName, "float");

export const bool = (ormName: string): HotUpdaterColumnDsl =>
  column(ormName, "bool");

export const json = (ormName: string): HotUpdaterColumnDsl =>
  column(ormName, "json");

export const stringColumn = (ormName: string): HotUpdaterColumnDsl =>
  column(ormName, "string");

export const index = (
  name: string,
  columns: readonly string[],
  providers?: HotUpdaterIndexSchema["providers"],
): HotUpdaterIndexSchema => ({
  name,
  columns,
  ...(providers ? { providers } : {}),
});

export const uniqueIndex = (
  name: string,
  columns: readonly string[],
  providers?: HotUpdaterIndexSchema["providers"],
): HotUpdaterIndexSchema => ({
  name,
  columns,
  ...(providers ? { providers } : {}),
  unique: true,
});

export const foreignKey = (
  name: string,
  columns: readonly string[],
  referencedTable: string,
  referencedColumns: readonly string[],
  options: {
    readonly onDelete?: HotUpdaterForeignKeySchema["onDelete"];
  } = {},
): HotUpdaterForeignKeySchema => ({
  name,
  columns,
  referencedTable,
  referencedColumns,
  onUpdate: "restrict",
  onDelete: options.onDelete ?? "cascade",
});

export const check = (config: HotUpdaterCheckSchema): HotUpdaterCheckSchema =>
  config;

export const relation = (
  config: HotUpdaterRelationSchema,
): HotUpdaterRelationSchema => config;

export const table = (
  ormName: string,
  columns: Record<string, HotUpdaterColumnDsl>,
  extras: Omit<HotUpdaterTableSchema, "columns" | "ormName"> = {},
): HotUpdaterTableDsl =>
  withDsl(
    {
      ormName,
      columns: Object.values(columns).map(columnSchema),
      ...extras,
    },
    "table",
  );

export const schema = (
  value: HotUpdaterVersionedSchema,
): HotUpdaterVersionedSchema & { readonly dsl: "schema" } =>
  withDsl({ ...value }, "schema");
