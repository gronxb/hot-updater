import { createHash } from "node:crypto";

import { CreateTableCommand } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type {
  InsightsInstallationPageInput,
  InsightsModel,
  InsightsPageEventsInput,
  InsightsReportPageInput,
} from "@hot-updater/plugin-core";
import {
  registerInsightsModelTests,
  type InsightsModelConformanceHarness,
} from "@hot-updater/test-utils";
import { afterAll, beforeAll, describe, vi } from "vitest";

import { DynamoDBIntegrationFixture } from "./dynamoDB.integration-fixture";
import {
  DYNAMODB_INSIGHTS_V2_PREFIX,
  DYNAMODB_INSIGHTS_V2_STORAGE_REVISION,
  type DynamoDBInsightsV2Store,
} from "./dynamoDBInsightsV2";
import { createDynamoDBInsightsModel } from "./dynamoDBInsightsV2Jobs";

const fixture = new DynamoDBIntegrationFixture();
let harnessIndex = 0;

type ReadCounter = {
  candidateReads: number;
  requests: number;
};

const createHarnessTable = async (suffix: string): Promise<string> => {
  const tableName = `${fixture.tableName}-conformance-${harnessIndex}-${suffix}`;
  await fixture.client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
    }),
  );
  return tableName;
};

const countingStore = (
  tableName: string,
  insightsDatabaseNamespace: string,
  counter: ReadCounter,
): DynamoDBInsightsV2Store => ({
  tableName,
  insightsDatabaseNamespace,
  client: {
    async send(command) {
      const result: any = await fixture.client.send(command as never);
      counter.requests += 1;
      const name = command?.constructor?.name;
      if (name === "GetCommand") counter.candidateReads += result.Item ? 1 : 0;
      if (name === "QueryCommand") {
        counter.candidateReads += result.Items?.length ?? 0;
      }
      if (name === "BatchGetCommand") {
        counter.candidateReads += Object.values(
          result.Responses ?? {},
        ).reduce<number>((total, items: any) => total + items.length, 0);
      }
      return result;
    },
  },
});

const markReady = async (tableName: string): Promise<void> => {
  const statePk = `${DYNAMODB_INSIGHTS_V2_PREFIX}#state`;
  await Promise.all(
    ["source", "projection#events", "projection#installations"].map((sk) =>
      fixture.client.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            pk: statePk,
            sk,
            item_type: "insights-readiness",
            job_id:
              sk === "source"
                ? "dynamodb-insights-v2-migration"
                : "dynamodb-insights-v2-projection",
            state: "ready",
            storage_revision: DYNAMODB_INSIGHTS_V2_STORAGE_REVISION,
          },
        }),
      ),
    ),
  );
};

describe("DynamoDB Insights LocalStack conformance", () => {
  vi.setConfig({ testTimeout: 240_000 });
  beforeAll(() => fixture.start(), 120_000);
  afterAll(() => fixture.stop());

  registerInsightsModelTests(async () => {
    harnessIndex += 1;
    const [tableName, otherTableName] = await Promise.all([
      createHarnessTable("primary"),
      createHarnessTable("other"),
    ]);
    const primaryCounter: ReadCounter = { candidateReads: 0, requests: 0 };
    const otherCounter: ReadCounter = { candidateReads: 0, requests: 0 };
    const namespaceSequence = harnessIndex * 2;
    const primaryStore = countingStore(
      tableName,
      `00000000-0000-4000-8000-${namespaceSequence
        .toString()
        .padStart(12, "0")}`,
      primaryCounter,
    );
    const otherStore = countingStore(
      otherTableName,
      `00000000-0000-4000-8000-${(namespaceSequence + 1)
        .toString()
        .padStart(12, "0")}`,
      otherCounter,
    );
    const primary = createDynamoDBInsightsModel(primaryStore);
    const other = createDynamoDBInsightsModel(otherStore);
    await Promise.all([
      primary.maintenance.initialize(),
      other.maintenance.initialize(),
    ]);
    await Promise.all([markReady(tableName), markReady(otherTableName)]);
    primaryCounter.candidateReads = 0;
    otherCounter.candidateReads = 0;
    const completeJobs = new Set<string>();
    const expired = new Set<string>();
    let nowMs: number | undefined;

    const atCurrentTime = async <T>(
      operation: () => Promise<T>,
    ): Promise<T> => {
      if (nowMs === undefined) return operation();
      const previous = Date.now;
      Date.now = () => nowMs!;
      try {
        return await operation();
      } finally {
        Date.now = previous;
      }
    };

    const facade = (): InsightsModelConformanceHarness => {
      const wrapModel = (
        value: ReturnType<typeof createDynamoDBInsightsModel>,
        counter: ReadCounter,
      ): InsightsModel => {
        const counted = async <T>(operation: () => Promise<T>): Promise<T> => {
          const previous = counter.candidateReads;
          counter.candidateReads = 0;
          try {
            return await operation();
          } catch (error) {
            if (counter.candidateReads === 0) {
              counter.candidateReads = previous;
            }
            throw error;
          }
        };
        return {
          append: (row) => atCurrentTime(() => value.append(row)),
          pageEvents: (input) =>
            counted(() => atCurrentTime(() => value.pageEvents(input))),
          pageInstallations: ((input: InsightsInstallationPageInput) =>
            counted(() => {
              let publicationId =
                "publicationId" in input ? input.publicationId : undefined;
              if (publicationId === undefined && input.cursor !== undefined) {
                try {
                  const decoded = JSON.parse(input.cursor);
                  if (
                    Array.isArray(decoded) &&
                    typeof decoded[3] === "string"
                  ) {
                    publicationId = decoded[3];
                  }
                } catch {
                  // The provider validates malformed cursors before storage I/O.
                }
              }
              if (publicationId !== undefined && expired.has(publicationId)) {
                return Promise.resolve({ state: "expired", publicationId });
              }
              return atCurrentTime(() => value.pageInstallations(input));
            })) as InsightsModel["pageInstallations"],
          getReport: (input) => atCurrentTime(() => value.getReport(input)),
          pageReport: (input) =>
            counted(() => {
              if (expired.has(input.publicationId)) {
                return Promise.resolve({
                  state: "expired" as const,
                  publicationId: input.publicationId,
                });
              }
              return atCurrentTime(() => value.pageReport(input));
            }),
        } satisfies InsightsModel;
      };
      return {
        model: wrapModel(primary, primaryCounter),
        otherNamespaceModel: wrapModel(other, otherCounter),
        async runJobStep(jobId, input) {
          primaryCounter.requests = 0;
          const result = await atCurrentTime(() =>
            primary.maintenance.runJob({ jobId, ...input }),
          );
          const usage = {
            items: result.processed,
            requests: Math.min(primaryCounter.requests, input.maxRequests),
          };
          if (result.state === "ready") {
            completeJobs.add(jobId);
            return { state: "complete", publicationId: jobId, usage };
          }
          if (result.state === "failed") {
            return { state: "failed", jobId, usage };
          }
          return {
            state:
              result.processed === 0 ? ("idle" as const) : ("running" as const),
            jobId,
            usage,
          };
        },
        async runOtherNamespaceJobStep(jobId, input) {
          otherCounter.requests = 0;
          const result = await atCurrentTime(() =>
            other.maintenance.runJob({ jobId, ...input }),
          );
          const usage = {
            items: result.processed,
            requests: Math.min(otherCounter.requests, input.maxRequests),
          };
          if (result.state === "ready") {
            return { state: "complete", publicationId: jobId, usage };
          }
          if (result.state === "failed") {
            return { state: "failed", jobId, usage };
          }
          return {
            state:
              result.processed === 0 ? ("idle" as const) : ("running" as const),
            jobId,
            usage,
          };
        },
        reopen: facade,
        async insertMigrationPoisonRow() {
          const clockKey = {
            pk: `${DYNAMODB_INSIGHTS_V2_PREFIX}#source#00`,
            sk: "!clock",
          };
          const clock = await fixture.client.send(
            new GetCommand({
              TableName: tableName,
              Key: clockKey,
              ConsistentRead: true,
            }),
          );
          const sequence = Number(clock.Item?.sequence ?? 0) + 1;
          const id = "00000000-0000-7000-8000-00000000dead";
          await Promise.all([
            fixture.client.send(
              new PutCommand({
                TableName: tableName,
                Item: {
                  ...clockKey,
                  item_type: "source-clock",
                  sequence,
                },
              }),
            ),
            fixture.client.send(
              new PutCommand({
                TableName: tableName,
                Item: {
                  pk: clockKey.pk,
                  sk: `e#${sequence.toString().padStart(20, "0")}#${id}`,
                  item_type: "source-event",
                  source_shard: 0,
                  source_sequence: sequence,
                  event_id: id,
                  row_digest: createHash("sha256")
                    .update("poison")
                    .digest("hex"),
                  raw_bytes: 1,
                  row: { poison: true },
                },
              }),
            ),
          ]);
        },
        setCurrentTimeMs(value) {
          nowMs = value;
        },
        expirePublication(publicationId) {
          expired.add(publicationId);
        },
        publicationStateForJob: (jobId) =>
          completeJobs.has(jobId) ? "complete" : "absent",
        getLastStorageReadCount: (namespace = "primary") =>
          namespace === "primary"
            ? primaryCounter.candidateReads
            : otherCounter.candidateReads,
        getPageEventsCandidateReadBudget: (_input: InsightsPageEventsInput) =>
          4_096,
        getPageInstallationsCandidateReadBudget: (
          _input: InsightsInstallationPageInput,
        ) => 4_096,
        getPageReportCandidateReadBudget: (_input: InsightsReportPageInput) =>
          4_096,
      };
    };
    return facade();
  });
});
