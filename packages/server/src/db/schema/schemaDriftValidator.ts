import type {
  HotUpdaterTableSchema,
  HotUpdaterVersionedSchema,
} from "../../schema/types";
import type { ORMSQLProvider } from "../types";
import { schemaIndexAppliesToProvider } from "./registry";

export const assertSameSchemaValue = (
  location: string,
  previous: unknown,
  next: unknown,
): void => {
  if (JSON.stringify(previous) !== JSON.stringify(next)) {
    throw new Error(
      `Unsupported Hot Updater schema change at ${location}. Add an explicit migration step before changing existing schema metadata.`,
    );
  }
};

const assertNamedMetadataIsUnchanged = <
  Metadata extends { readonly name: string },
>(
  location: string,
  previousItems: readonly Metadata[] | undefined,
  nextItems: readonly Metadata[] | undefined,
): void => {
  const nextItemsByName = new Map(
    (nextItems ?? []).map((item) => [item.name, item]),
  );
  for (const previousItem of previousItems ?? []) {
    const nextItem = nextItemsByName.get(previousItem.name);
    if (!nextItem) {
      throw new Error(
        `Unsupported Hot Updater schema change at ${location}.${previousItem.name}. Removing schema metadata requires an explicit migration step.`,
      );
    }
    assertSameSchemaValue(
      `${location}.${previousItem.name}`,
      previousItem,
      nextItem,
    );
  }
};

const v036ChannelsTable = {
  ormName: "channels",
  columns: [
    { ormName: "id", type: "varchar(255)", primaryKey: true },
    { ormName: "name", type: "varchar(255)" },
  ],
  indexes: [{ name: "channels_name_key", columns: ["name"], unique: true }],
} as const satisfies HotUpdaterTableSchema;

const v036BundlesAdditions = {
  columns: [{ ormName: "channel_id", type: "varchar(255)" }],
  indexes: [{ name: "bundles_channel_id_idx", columns: ["channel_id"] }],
  checks: [],
  foreignKeys: [
    {
      name: "bundles_channel_id_fk",
      columns: ["channel_id"],
      referencedTable: "channels",
      referencedColumns: ["id"],
      onUpdate: "restrict",
      onDelete: "restrict",
    },
  ],
  relations: [
    {
      name: "channelRef",
      fieldName: "bundles",
      targetFieldName: "channelRef",
      relationName: "channels_bundles_channel",
      columns: ["channel_id"],
      referencedTable: "channels",
      referencedColumns: ["id"],
    },
  ],
} as const;

const noV036Additions = {
  columns: [],
  indexes: [],
  checks: [],
  foreignKeys: [],
  relations: [],
} as const;

const addedNamedMetadata = <Metadata extends { readonly name: string }>(
  previousItems: readonly Metadata[] | undefined,
  nextItems: readonly Metadata[] | undefined,
): readonly Metadata[] => {
  const previousNames = new Set((previousItems ?? []).map((item) => item.name));
  return (nextItems ?? []).filter((item) => !previousNames.has(item.name));
};

const addedMetadataLocation = (
  location: string,
  actualName: string | undefined,
  allowedName: string | undefined,
): string => {
  const metadataName = actualName ?? allowedName;
  return `${location}${metadataName ? `.${metadataName}` : ""}`;
};

const assertV036TableAdditionsAreAllowlisted = (
  previous: HotUpdaterTableSchema,
  next: HotUpdaterTableSchema,
): void => {
  const allowed =
    previous.ormName === "bundles" ? v036BundlesAdditions : noV036Additions;
  const previousColumns = new Set(
    previous.columns.map((column) => column.ormName),
  );
  const addedColumns = next.columns.filter(
    (column) => !previousColumns.has(column.ormName),
  );
  const additions = {
    columns: addedColumns,
    indexes: addedNamedMetadata(previous.indexes, next.indexes),
    checks: addedNamedMetadata(previous.checks, next.checks),
    foreignKeys: addedNamedMetadata(previous.foreignKeys, next.foreignKeys),
    relations: addedNamedMetadata(previous.relations, next.relations),
  };
  assertSameSchemaValue(
    addedMetadataLocation(
      `${previous.ormName}.columns`,
      additions.columns[0]?.ormName,
      allowed.columns[0]?.ormName,
    ),
    allowed.columns,
    additions.columns,
  );
  for (const kind of [
    "indexes",
    "checks",
    "foreignKeys",
    "relations",
  ] as const) {
    assertSameSchemaValue(
      addedMetadataLocation(
        `${previous.ormName}.${kind}`,
        additions[kind][0]?.name,
        allowed[kind][0]?.name,
      ),
      allowed[kind],
      additions[kind],
    );
  }
};

export const assertExistingSchemaMetadataIsPreserved = (
  previous: HotUpdaterTableSchema,
  next: HotUpdaterTableSchema,
  provider: ORMSQLProvider,
): void => {
  const nextColumns = new Map(
    next.columns.map((column) => [column.ormName, column]),
  );
  for (const previousColumn of previous.columns) {
    const nextColumn = nextColumns.get(previousColumn.ormName);
    if (!nextColumn) {
      throw new Error(
        `Unsupported Hot Updater schema change at ${previous.ormName}.${previousColumn.ormName}. Dropping columns requires an explicit migration step.`,
      );
    }
    assertSameSchemaValue(
      `${previous.ormName}.${previousColumn.ormName}`,
      previousColumn,
      nextColumn,
    );
  }
  assertNamedMetadataIsUnchanged(
    `${previous.ormName}.indexes`,
    previous.indexes?.filter((index) =>
      schemaIndexAppliesToProvider(index, provider),
    ),
    next.indexes?.filter((index) =>
      schemaIndexAppliesToProvider(index, provider),
    ),
  );
  assertNamedMetadataIsUnchanged(
    `${previous.ormName}.checks`,
    previous.checks,
    next.checks,
  );
  assertNamedMetadataIsUnchanged(
    `${previous.ormName}.foreignKeys`,
    previous.foreignKeys,
    next.foreignKeys,
  );
  assertNamedMetadataIsUnchanged(
    `${previous.ormName}.relations`,
    previous.relations,
    next.relations,
  );
};

export const assertV036MigrationSchemaDriftIsAllowlisted = (
  previous: HotUpdaterVersionedSchema,
  next: HotUpdaterVersionedSchema,
  provider: ORMSQLProvider,
): void => {
  const previousTables = new Map(
    previous.tables
      .filter((table) => !table.internal)
      .map((table) => [table.ormName, table]),
  );
  const nextTables = new Map(
    next.tables
      .filter((table) => !table.internal)
      .map((table) => [table.ormName, table]),
  );
  for (const previousTable of previousTables.values()) {
    const nextTable = nextTables.get(previousTable.ormName);
    if (!nextTable) {
      throw new Error(
        `Unsupported Hot Updater schema change at ${previousTable.ormName}. Removing tables requires an explicit migration step.`,
      );
    }
    assertExistingSchemaMetadataIsPreserved(previousTable, nextTable, provider);
    assertV036TableAdditionsAreAllowlisted(previousTable, nextTable);
  }
  const addedTables = [...nextTables.values()].filter(
    (table) => !previousTables.has(table.ormName),
  );
  for (const addedTable of addedTables) {
    if (addedTable.ormName !== v036ChannelsTable.ormName) {
      throw new Error(
        `Unsupported Hot Updater schema change at ${addedTable.ormName}. Adding tables requires an explicit migration step.`,
      );
    }
    assertSameSchemaValue(
      v036ChannelsTable.ormName,
      v036ChannelsTable,
      addedTable,
    );
  }
  assertSameSchemaValue(v036ChannelsTable.ormName, 1, addedTables.length);
};
