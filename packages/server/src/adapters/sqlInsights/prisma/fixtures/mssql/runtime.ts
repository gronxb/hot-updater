import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type { PrismaInsightsClient } from "../../client";

const execFileAsync = promisify(execFile);
const fixtureDirectory = fileURLToPath(new URL(".", import.meta.url));
const schemaPath = fileURLToPath(new URL("./schema.prisma", import.meta.url));
const prismaExecutable = fileURLToPath(
  new URL("../../../../../../node_modules/.bin/prisma", import.meta.url),
);
const generatedClientUrl = pathToFileURL(
  fileURLToPath(new URL("./generated/client/index.js", import.meta.url)),
).href;

export interface MssqlEvidenceClient extends PrismaInsightsClient {
  $disconnect(): Promise<void>;
  $on(
    event: "query",
    callback: (event: { readonly query: string }) => void,
  ): void;
}

type MssqlEvidenceClientConstructor = new (options: {
  readonly datasourceUrl: string;
  readonly log?: readonly [{ readonly emit: "event"; readonly level: "query" }];
}) => MssqlEvidenceClient;

let generatedClient: Promise<MssqlEvidenceClientConstructor> | undefined;

const replaceDatabase = (connectionString: string, database: string): string =>
  /;database=[^;]*/i.test(connectionString)
    ? connectionString.replace(/;database=[^;]*/i, `;database=${database}`)
    : `${connectionString};database=${database}`;

const loadGeneratedClient = async (
  connectionString: string,
): Promise<MssqlEvidenceClientConstructor> => {
  await execFileAsync(prismaExecutable, ["generate", "--schema", schemaPath], {
    cwd: fixtureDirectory,
    env: {
      ...process.env,
      PATH: `${fileURLToPath(new URL(".", pathToFileURL(process.execPath)))}:${process.env.PATH ?? ""}`,
      PRISMA_INSIGHTS_MSSQL_URL: connectionString,
    },
    maxBuffer: 10 * 1024 * 1024,
  });
  const moduleUrl = generatedClientUrl;
  const module = (await import(/* @vite-ignore */ moduleUrl)) as {
    readonly PrismaClient?: MssqlEvidenceClientConstructor;
    readonly default?: {
      readonly PrismaClient?: MssqlEvidenceClientConstructor;
    };
  };
  const constructor = module.PrismaClient ?? module.default?.PrismaClient;
  if (constructor === undefined) {
    throw new Error(
      "Generated Prisma SQL Server client is missing PrismaClient",
    );
  }
  return constructor;
};

export const generateMssqlEvidenceClient = (
  connectionString: string,
): Promise<MssqlEvidenceClientConstructor> => {
  generatedClient ??= loadGeneratedClient(connectionString);
  return generatedClient;
};

export interface MssqlEvidenceDatabase {
  readonly client: MssqlEvidenceClient;
  readonly databaseName: string;
  readonly queries: string[];
  clearQueries(): void;
  reopen(): MssqlEvidenceClient;
  dispose(): Promise<void>;
}

export const createMssqlEvidenceDatabase = async (
  connectionString: string,
): Promise<MssqlEvidenceDatabase> => {
  const PrismaClient = await generateMssqlEvidenceClient(connectionString);
  const databaseName = `prisma_insights_${randomUUID().replaceAll("-", "")}`;
  const admin = new PrismaClient({
    datasourceUrl: replaceDatabase(connectionString, "master"),
  });
  let client: MssqlEvidenceClient | undefined;
  const clients: MssqlEvidenceClient[] = [];
  const queries: string[] = [];
  const openClient = () => {
    const opened = new PrismaClient({
      datasourceUrl: replaceDatabase(connectionString, databaseName),
      log: [{ emit: "event", level: "query" }],
    });
    opened.$on("query", ({ query }) => queries.push(query));
    clients.push(opened);
    return opened;
  };
  try {
    await admin.$executeRawUnsafe(`create database [${databaseName}]`);
    client = openClient();
    await client.$executeRawUnsafe(`create table bundle_events (
      id varchar(36) primary key,
      type varchar(255) not null,
      install_id nvarchar(1024) not null,
      user_id nvarchar(1024) null,
      username nvarchar(1024) null,
      from_release_id varchar(36) null,
      from_bundle_id varchar(36) null,
      to_release_id varchar(36) null,
      to_bundle_id varchar(36) not null,
      platform varchar(255) not null,
      app_version varchar(255) not null,
      channel varchar(255) not null,
      cohort nvarchar(1024) not null,
      update_strategy varchar(255) null,
      fingerprint_hash varchar(255) null,
      sdk_version varchar(255) null,
      received_at_ms float not null
    )`);
  } catch (error) {
    await Promise.allSettled(clients.map((opened) => opened.$disconnect()));
    await admin
      .$executeRawUnsafe(
        `if db_id(N'${databaseName}') is not null begin
          alter database [${databaseName}] set single_user with rollback immediate;
          drop database [${databaseName}];
        end`,
      )
      .catch(() => undefined);
    await admin.$disconnect();
    throw error;
  }

  return {
    client,
    databaseName,
    queries,
    clearQueries() {
      queries.length = 0;
    },
    reopen: openClient,
    async dispose() {
      await Promise.allSettled(clients.map((opened) => opened.$disconnect()));
      await admin.$executeRawUnsafe(
        `alter database [${databaseName}] set single_user with rollback immediate`,
      );
      await admin.$executeRawUnsafe(`drop database [${databaseName}]`);
      await admin.$disconnect();
    },
  };
};
