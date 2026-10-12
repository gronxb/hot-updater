import { MissingInitInputsError, p } from "@hot-updater/cli-tools";

import { initProvider as FIREBASE_INIT_PROVIDER } from "./init/index";

export const FIRESTORE_DEFAULT_DATABASE_ID = "(default)";

/**
 * The IDs of a project's databases the Firestore API can use, from
 * `gcloud firestore databases list --format=json`, whose names are
 * `projects/<project>/databases/<id>`: not Datastore mode, and not an
 * Enterprise database with Firestore data access disabled, the default for
 * MongoDB-compatible ones.
 */
export const parseFirestoreDatabaseIds = (databases: unknown): string[] =>
  Array.isArray(databases)
    ? databases.flatMap((database: unknown) => {
        if (typeof database !== "object" || database === null) return [];
        const name = Reflect.get(database, "name");
        if (
          typeof name !== "string" ||
          Reflect.get(database, "type") === "DATASTORE_MODE" ||
          Reflect.get(database, "firestoreDataAccessMode") ===
            "DATA_ACCESS_MODE_DISABLED"
        ) {
          return [];
        }
        return [name.slice(name.lastIndexOf("/") + 1)];
      })
    : [];

/**
 * The database init sets up: the saved one, the only one, or the one the
 * user selects. Without a saved one, non-interactive init keeps `(default)`
 * and needs `HOT_UPDATER_FIREBASE_DATABASE_ID` only to choose among named
 * databases.
 */
export const resolveFirestoreDatabaseId = async ({
  databaseIds,
  nonInteractive,
  savedDatabaseId,
}: {
  readonly databaseIds: readonly string[];
  readonly nonInteractive: boolean;
  readonly savedDatabaseId?: string;
}): Promise<string> => {
  const input = FIREBASE_INIT_PROVIDER.inputs.databaseId;
  if (savedDatabaseId !== undefined) {
    if (databaseIds.includes(savedDatabaseId)) return savedDatabaseId;
    if (nonInteractive) throw new MissingInitInputsError([input.envKey]);
    p.log.warn(
      `Saved Firestore database ${savedDatabaseId} was not found. Select a database again.`,
    );
  }
  const [onlyDatabaseId] = databaseIds;
  if (databaseIds.length === 1 && onlyDatabaseId !== undefined) {
    return onlyDatabaseId;
  }
  const hasDefault = databaseIds.includes(FIRESTORE_DEFAULT_DATABASE_ID);
  if (nonInteractive) {
    if (hasDefault) return FIRESTORE_DEFAULT_DATABASE_ID;
    throw new MissingInitInputsError([input.envKey]);
  }
  const selected = await p.select<string>({
    initialValue: hasDefault ? FIRESTORE_DEFAULT_DATABASE_ID : onlyDatabaseId,
    message: input.prompt.message,
    options: databaseIds.map((databaseId) => ({
      value: databaseId,
      label: databaseId,
    })),
  });
  if (p.isCancel(selected)) {
    p.cancel("Operation cancelled.");
    process.exit(1);
  }
  return selected;
};
