import { execFile } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  assertPrismaInsightsRawClient,
  type PrismaInsightsClient,
} from "../client";

const execFileAsync = promisify(execFile);

const resolvePrismaCli = async (): Promise<string> => {
  const prismaCli = join(
    process.cwd(),
    "node_modules/.pnpm/node_modules/prisma/build/index.js",
  );
  try {
    await access(prismaCli);
    return prismaCli;
  } catch {
    throw new Error("Could not locate the workspace Prisma CLI");
  }
};

export interface EvidencePrismaClient extends PrismaInsightsClient {
  $disconnect(): Promise<void>;
}

export interface EvidencePrismaClientConstructor {
  new (options?: { readonly datasourceUrl?: string }): EvidencePrismaClient;
}

export interface GeneratedEvidenceClient {
  readonly PrismaClient: EvidencePrismaClientConstructor;
  cleanup(): Promise<void>;
}

export const captureEvidencePrismaQueries = (
  client: EvidencePrismaClient,
): { readonly client: EvidencePrismaClient; readonly queries: string[] } => {
  const queries: string[] = [];
  const wrapped: EvidencePrismaClient = {
    $disconnect: () => client.$disconnect(),
    $executeRawUnsafe(query: string, ...values: readonly unknown[]) {
      queries.push(query);
      return client.$executeRawUnsafe(query, ...values);
    },
    $queryRawUnsafe<TResult = unknown>(
      query: string,
      ...values: readonly unknown[]
    ) {
      queries.push(query);
      return client.$queryRawUnsafe<TResult>(query, ...values);
    },
    $transaction(callback, options) {
      return client.$transaction((transaction) => {
        assertPrismaInsightsRawClient(transaction);
        return callback({
          $executeRawUnsafe(query: string, ...values: readonly unknown[]) {
            queries.push(query);
            return transaction.$executeRawUnsafe(query, ...values);
          },
          $queryRawUnsafe<TResult = unknown>(
            query: string,
            ...values: readonly unknown[]
          ) {
            queries.push(query);
            return transaction.$queryRawUnsafe<TResult>(query, ...values);
          },
        });
      }, options);
    },
  };
  return { client: wrapped, queries };
};

export const generateEvidencePrismaClient = async (
  schemaPath: string,
  outputPath: string,
  databaseUrl: string,
): Promise<GeneratedEvidenceClient> => {
  await mkdir(dirname(outputPath), { recursive: true });
  const prismaCli = await resolvePrismaCli();
  await execFileAsync(
    process.execPath,
    [prismaCli, "generate", "--schema", schemaPath],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PRISMA_EVIDENCE_CLIENT_OUTPUT: outputPath,
      },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const generated = (await import(
    pathToFileURL(join(outputPath, "index.js")).href
  )) as { readonly PrismaClient?: EvidencePrismaClientConstructor };
  if (typeof generated.PrismaClient !== "function") {
    throw new Error(
      "Prisma evidence client generation did not produce a client",
    );
  }
  return {
    PrismaClient: generated.PrismaClient,
    cleanup: () => rm(outputPath, { recursive: true, force: true }),
  };
};
