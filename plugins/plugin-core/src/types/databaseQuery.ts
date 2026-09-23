import type { DatabaseField, DatabaseModel, DatabaseRow } from "./databaseRows";

export type DatabaseWhereOperator = "eq" | "lt" | "lte" | "gt" | "gte" | "in";

export type DatabaseSortNulls = "first" | "last";

type WhereBase<TField extends string> = {
  readonly field: TField;
};

type EqualityWhere<TField extends string, TValue> = WhereBase<TField> & {
  readonly operator?: "eq";
  readonly value: TValue;
};

type OrderedWhere<
  TField extends string,
  TValue extends number | string,
> = WhereBase<TField> & {
  readonly operator: "gt" | "gte" | "lt" | "lte";
  readonly value: TValue;
};

type SetWhere<
  TField extends string,
  TValue extends boolean | number | string,
> = WhereBase<TField> & {
  readonly operator: "in";
  readonly value: readonly TValue[];
};

type ScalarWhereValue<TValue> = unknown extends TValue
  ? never
  : Extract<TValue, readonly unknown[] | object> extends never
    ? Extract<TValue, boolean | number | string | null>
    : never;

type FieldWhere<TField extends string, TValue> =
  | ([ScalarWhereValue<TValue>] extends [never]
      ? never
      : EqualityWhere<TField, ScalarWhereValue<TValue>>)
  | (Extract<TValue, number | string> extends never
      ? never
      : OrderedWhere<TField, Extract<TValue, number | string>>)
  | (Extract<TValue, boolean | number | string> extends never
      ? never
      : SetWhere<TField, Extract<TValue, boolean | number | string>>);

export type DatabaseWhere<TModel extends DatabaseModel> = {
  readonly [TField in DatabaseField<TModel>]: FieldWhere<
    TField,
    DatabaseRow<TModel>[TField]
  >;
}[DatabaseField<TModel>];

export type DatabaseSelect<TModel extends DatabaseModel> =
  readonly DatabaseField<TModel>[];

export type SelectedDatabaseRow<
  TModel extends DatabaseModel,
  TSelect extends DatabaseSelect<TModel> | undefined,
> =
  TSelect extends DatabaseSelect<TModel>
    ? Pick<DatabaseRow<TModel>, TSelect[number]>
    : DatabaseRow<TModel>;

type DatabaseSortableField<TModel extends DatabaseModel> = {
  readonly [TField in DatabaseField<TModel>]: Exclude<
    DatabaseRow<TModel>[TField],
    null
  > extends number | string
    ? TField
    : never;
}[DatabaseField<TModel>];

export interface DatabaseSortClause<TModel extends DatabaseModel> {
  readonly field: DatabaseSortableField<TModel>;
  readonly direction: "asc" | "desc";
  readonly nulls?: DatabaseSortNulls;
}

export type DatabaseSortBy<TModel extends DatabaseModel> =
  DatabaseSortClause<TModel>;

export type DatabaseOrderBy<TModel extends DatabaseModel> = readonly [
  DatabaseSortClause<TModel>,
  ...DatabaseSortClause<TModel>[],
];

export type DatabaseDistinctFields<TModel extends DatabaseModel> = readonly [
  DatabaseField<TModel>,
  ...DatabaseField<TModel>[],
];
