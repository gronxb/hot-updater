import { InitError } from "@hot-updater/cli-tools";

export type CloudflareD1Database = {
  readonly name: string;
  readonly uuid: string;
};

export type CloudflareReplayD1Resolution =
  | {
      readonly database: CloudflareD1Database;
      readonly kind: "existing";
    }
  | {
      readonly kind: "create";
      readonly name: string;
    };

export class CloudflareD1IdentifierConflictError extends InitError {
  readonly name = "CloudflareD1IdentifierConflictError";

  constructor({
    databaseId,
    databaseName,
  }: {
    readonly databaseId: string;
    readonly databaseName: string;
  }) {
    super(
      [
        "Cloudflare D1 identifiers conflict.",
        `Database ID: ${databaseId}`,
        `Database name: ${databaseName}`,
        "Update the env file so both values identify the same database, then rerun init.",
      ].join("\n"),
    );
  }
}

export const resolveCloudflareReplayD1Database = ({
  availableDatabases,
  databaseId,
  databaseName,
}: {
  readonly availableDatabases: readonly CloudflareD1Database[];
  readonly databaseId: string;
  readonly databaseName: string;
}): CloudflareReplayD1Resolution => {
  const exactMatch = availableDatabases.find(
    (database) =>
      database.uuid === databaseId && database.name === databaseName,
  );
  if (exactMatch) {
    return { database: exactMatch, kind: "existing" };
  }

  const identifierExists = availableDatabases.some(
    (database) =>
      database.uuid === databaseId || database.name === databaseName,
  );
  if (identifierExists) {
    throw new CloudflareD1IdentifierConflictError({
      databaseId,
      databaseName,
    });
  }

  return { kind: "create", name: databaseName };
};
