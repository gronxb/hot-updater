import type { HotUpdaterTableSchema } from "../../schema/types";
import type { ORMSQLProvider } from "../types";
import { schemaIndexAppliesToProvider } from "./registry";

const assertSameSchemaValue = (
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
};
