import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { RequiredInsightsModel } from "@hot-updater/plugin-core/internal";
import {
  type RequiredInsightsModelConformanceHarness,
  registerRequiredInsightsModelTests,
} from "@hot-updater/test-utils";
import {
  BSON,
  MongoClient,
  type CommandSucceededEvent,
  type Document,
} from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";

import { findOpenPort } from "../../../test-utils/src/runtimeProcess";
import { createMongoInsightsModelMaintenance } from "../db/mongoInsightsModel";
import { createMongoInsightsSource } from "../db/mongoInsightsSource";
import {
  createMongoInsightsModelCollections,
  MONGO_INSIGHTS_ALIAS_COLLECTION,
  MONGO_INSIGHTS_INSTALLATION_COLLECTION,
  MONGO_INSIGHTS_PROJECTION_EVENT_COLLECTION,
  MONGO_INSIGHTS_REPORT_BUCKET_COLLECTION,
  MONGO_INSIGHTS_REPORT_COUNT_COLLECTION,
  MONGO_INSIGHTS_REPORT_JOB_COLLECTION,
  MONGO_INSIGHTS_REPORT_LATEST_COLLECTION,
  MONGO_INSIGHTS_REPORT_ORDER_COLLECTION,
  MONGO_INSIGHTS_SEARCH_JOB_COLLECTION,
  MONGO_INSIGHTS_SEARCH_ROW_COLLECTION,
} from "./mongodbInsightsModelSchema";
import { createMongoRequiredInsightsModel } from "./mongodbInsightsRequired";

const docker = (args: string[]) => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
};

class MongoCandidateMeter {
  #activeCollections: ReadonlySet<string> | null = null;
  #candidateRows = 0;
  #candidateBytes = 0;
  #requests = 0;
  #sawCandidateRead = false;
  #lastCandidateRows = 0;
  #lastCandidateBytes = 0;
  #lastRequests = 0;

  constructor(client: MongoClient) {
    client.on("commandStarted", ({ commandName }) => {
      if (
        this.#activeCollections !== null &&
        commandName !== "commitTransaction" &&
        commandName !== "abortTransaction" &&
        commandName !== "endSessions"
      ) {
        this.#requests++;
      }
    });
    client.on("commandSucceeded", (event) => this.#recordBatch(event));
  }

  #recordBatch(event: CommandSucceededEvent): void {
    if (this.#activeCollections === null) return;
    if (typeof event.reply !== "object" || event.reply === null) return;
    const cursor = Reflect.get(event.reply, "cursor");
    if (typeof cursor !== "object" || cursor === null) return;
    const namespace = Reflect.get(cursor, "ns");
    const collection =
      typeof namespace === "string" ? namespace.split(".").at(-1) : undefined;
    if (collection === undefined || !this.#activeCollections.has(collection))
      return;
    const firstBatch = Reflect.get(cursor, "firstBatch");
    const nextBatch = Reflect.get(cursor, "nextBatch");
    const batch = Array.isArray(firstBatch)
      ? firstBatch
      : Array.isArray(nextBatch)
        ? nextBatch
        : [];
    this.#sawCandidateRead = true;
    this.#candidateRows += batch.length;
    this.#candidateBytes += batch.reduce(
      (total, row) =>
        total +
        (typeof row === "object" && row !== null
          ? BSON.calculateObjectSize(row as Document)
          : 0),
      0,
    );
  }

  async measure<TResult>(
    collections: readonly string[],
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    this.#activeCollections = new Set(collections);
    this.#candidateRows = 0;
    this.#candidateBytes = 0;
    this.#requests = 0;
    this.#sawCandidateRead = false;
    try {
      return await operation();
    } finally {
      if (this.#sawCandidateRead) {
        this.#lastCandidateRows = this.#candidateRows;
        this.#lastCandidateBytes = this.#candidateBytes;
      }
      this.#lastRequests = this.#requests;
      this.#activeCollections = null;
    }
  }

  get candidateRows(): number {
    return this.#lastCandidateRows;
  }

  get candidateBytes(): number {
    return this.#lastCandidateBytes;
  }

  get requests(): number {
    return this.#lastRequests;
  }
}

const replicaSet = "insightsConformanceRs";
const container = `hot-updater-mongo-conformance-${randomUUID().slice(0, 8)}`;
const clients: MongoClient[] = [];
const databaseNames = new Set<string>();
let controlClient: MongoClient;
let directUri: string;
let nextNamespace = 0;

const connect = async (databaseName: string) => {
  const client = new MongoClient(
    `${directUri}/${databaseName}?directConnection=true&replicaSet=${encodeURIComponent(replicaSet)}`,
    {
      monitorCommands: true,
      serverSelectionTimeoutMS: 30_000,
    },
  );
  await client.connect();
  clients.push(client);
  databaseNames.add(databaseName);
  return client;
};

const prepareNamespace = async (client: MongoClient): Promise<void> => {
  const source = createMongoInsightsSource(client);
  await source.prepare({ writersDrained: true });
  for (let step = 0; step < 100; step++) {
    try {
      await source.ensureReady();
      break;
    } catch {
      await source.runStep({ maxItems: 100, maxRequests: 1_000 });
    }
  }
  await source.ensureReady();
  const maintenance = createMongoInsightsModelMaintenance(client);
  await maintenance.prepare();
  for (let step = 0; step < 100; step++) {
    try {
      await maintenance.ensureReady();
      break;
    } catch {
      await maintenance.runStep({ maxItems: 100, maxRequests: 1_000 });
    }
  }
  await maintenance.ensureReady();
};

const instrumentModel = (
  model: RequiredInsightsModel,
  meter: MongoCandidateMeter,
  jobKinds: Map<string, "search" | "report">,
): RequiredInsightsModel => {
  const recordJob = (value: unknown, kind: "search" | "report"): void => {
    if (typeof value !== "object" || value === null) return;
    const state = Reflect.get(value, "state");
    const holder =
      state === "preparing"
        ? Reflect.get(value, "job")
        : state === "stale"
          ? Reflect.get(value, "refresh")
          : null;
    const id =
      typeof holder === "object" && holder !== null
        ? Reflect.get(holder, "id")
        : undefined;
    if (typeof id === "string") jobKinds.set(id, kind);
  };
  return {
    append: (row) => meter.measure([], () => model.append(row)),
    pageEvents: (input) =>
      meter.measure([MONGO_INSIGHTS_PROJECTION_EVENT_COLLECTION], () =>
        model.pageEvents(input),
      ),
    pageInstallations: (async (input) => {
      const result = await meter.measure(
        input.kind === "all" || input.kind === "installationId"
          ? [MONGO_INSIGHTS_INSTALLATION_COLLECTION]
          : [MONGO_INSIGHTS_SEARCH_ROW_COLLECTION],
        () => model.pageInstallations(input),
      );
      recordJob(result, "search");
      return result;
    }) as RequiredInsightsModel["pageInstallations"],
    getReport: async (input) => {
      const result = await meter.measure([], () => model.getReport(input));
      recordJob(result, "report");
      return result;
    },
    pageReport: (input) =>
      meter.measure(
        [
          MONGO_INSIGHTS_REPORT_COUNT_COLLECTION,
          MONGO_INSIGHTS_REPORT_ORDER_COLLECTION,
        ],
        () => model.pageReport(input),
      ),
  };
};

const synchronousMongo = (databaseName: string, body: string): string => {
  const result = spawnSync(
    "docker",
    [
      "exec",
      container,
      "mongosh",
      "--quiet",
      "--eval",
      `const d=db.getSiblingDB(${JSON.stringify(databaseName)});${body}`,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim().split("\n").at(-1) ?? "";
};

const createHarness =
  async (): Promise<RequiredInsightsModelConformanceHarness> => {
    const namespace = ++nextNamespace;
    const primaryName = `insights_conformance_${namespace}_primary`;
    const otherName = `insights_conformance_${namespace}_other`;
    const initialPrimary = await connect(primaryName);
    const initialOther = await connect(otherName);
    await prepareNamespace(initialPrimary);
    await prepareNamespace(initialOther);
    const jobKinds = new Map<string, "search" | "report">();

    const createFacade = async (
      existingPrimary?: MongoClient,
      existingOther?: MongoClient,
    ): Promise<RequiredInsightsModelConformanceHarness> => {
      const primary = existingPrimary ?? (await connect(primaryName));
      const other = existingOther ?? (await connect(otherName));
      const primaryMeter = new MongoCandidateMeter(primary);
      const otherMeter = new MongoCandidateMeter(other);
      const primaryModel = instrumentModel(
        createMongoRequiredInsightsModel(primary),
        primaryMeter,
        jobKinds,
      );
      const otherModel = instrumentModel(
        createMongoRequiredInsightsModel(other),
        otherMeter,
        jobKinds,
      );
      const runJobStep = async (
        workerClient: MongoClient,
        meter: MongoCandidateMeter,
        jobId: string,
        input: { readonly maxItems: number; readonly maxRequests: number },
      ) => {
        const kind = jobKinds.get(jobId);
        if (kind === undefined) throw new Error("unknown active Mongo job");
        const maintenance = createMongoInsightsModelMaintenance(workerClient);
        const outcome = await meter.measure(
          kind === "search"
            ? [MONGO_INSIGHTS_ALIAS_COLLECTION]
            : [
                MONGO_INSIGHTS_PROJECTION_EVENT_COLLECTION,
                MONGO_INSIGHTS_REPORT_LATEST_COLLECTION,
                MONGO_INSIGHTS_REPORT_BUCKET_COLLECTION,
                MONGO_INSIGHTS_REPORT_COUNT_COLLECTION,
              ],
          () => maintenance.runJobStep(jobId, input),
        );
        if (meter.requests > input.maxRequests)
          throw new Error(
            `Mongo maintenance used ${meter.requests}/${input.maxRequests} requests`,
          );
        if (outcome.usage.requests < meter.requests)
          throw new Error(
            `Mongo maintenance underreported ${outcome.usage.requests}/${meter.requests} requests`,
          );
        if (outcome.jobId !== undefined && outcome.jobId !== jobId)
          throw new Error("Mongo maintenance selected an unexpected job");
        const usage = outcome.usage;
        if (outcome.state === "published")
          return { state: "complete" as const, publicationId: jobId, usage };
        if (outcome.state === "failed")
          return { state: "failed" as const, jobId, usage };
        return outcome.state === "idle" || outcome.processed === 0
          ? { state: "idle" as const, jobId, usage }
          : { state: "running" as const, jobId, usage };
      };
      return {
        model: primaryModel,
        otherNamespaceModel: otherModel,
        runJobStep: (jobId, input) =>
          runJobStep(primary, primaryMeter, jobId, input),
        runOtherNamespaceJobStep: (jobId, input) =>
          runJobStep(other, otherMeter, jobId, input),
        reopen: () => createFacade(),
        async insertMigrationPoisonRow() {
          const collections = createMongoInsightsModelCollections(primary);
          const poisoned = await collections.projectionEvents.findOneAndUpdate(
            {},
            { $set: { event: {} as never } },
            { sort: { projectionSequence: 1 }, returnDocument: "after" },
          );
          if (!poisoned) throw new Error("missing projection poison target");
        },
        setCurrentTimeMs(nowMs) {
          if (!Number.isSafeInteger(nowMs) || nowMs < 0)
            throw new Error("invalid time");
          vi.setSystemTime(nowMs);
        },
        expirePublication(publicationId) {
          synchronousMongo(
            primaryName,
            `d.getCollection(${JSON.stringify(MONGO_INSIGHTS_SEARCH_JOB_COLLECTION)}).deleteOne({_id:${JSON.stringify(publicationId)}});d.getCollection(${JSON.stringify(MONGO_INSIGHTS_REPORT_JOB_COLLECTION)}).deleteOne({_id:${JSON.stringify(publicationId)}});`,
          );
        },
        publicationStateForJob(jobId) {
          const state = synchronousMongo(
            primaryName,
            `const s=d.getCollection(${JSON.stringify(MONGO_INSIGHTS_SEARCH_JOB_COLLECTION)}).findOne({_id:${JSON.stringify(jobId)}},{state:1});const r=d.getCollection(${JSON.stringify(MONGO_INSIGHTS_REPORT_JOB_COLLECTION)}).findOne({_id:${JSON.stringify(jobId)}},{state:1});print(s?.state??r?.state??"absent");`,
          );
          return state === "ready" ? "complete" : "absent";
        },
        getLastStorageReadCount(namespace = "primary") {
          return namespace === "primary"
            ? primaryMeter.candidateRows
            : otherMeter.candidateRows;
        },
        getPageEventsCandidateReadBudget(input) {
          return input.selector.kind === "all"
            ? input.limit + 1
            : (input.limit + 1) * 2;
        },
        getPageInstallationsCandidateReadBudget(input) {
          return input.kind === "installationId" ? 1 : input.limit + 1;
        },
        getPageReportCandidateReadBudget(input) {
          return input.section === "activeBundleSeries"
            ? input.limit * 2 + 1
            : input.limit + 1;
        },
      };
    };

    return createFacade(initialPrimary, initialOther);
  };

vi.setConfig({ hookTimeout: 120_000, testTimeout: 120_000 });

beforeAll(async () => {
  docker(["image", "inspect", "mongo:7-jammy"]);
  const port = await findOpenPort();
  docker([
    "run",
    "--detach",
    "--rm",
    "--pull=never",
    "--name",
    container,
    "--tmpfs",
    "/data/db:rw,size=768m",
    "--tmpfs",
    "/data/configdb:rw,size=16m",
    "-p",
    `127.0.0.1:${port}:27017`,
    "mongo:7-jammy",
    "--bind_ip_all",
    "--replSet",
    replicaSet,
    "--wiredTigerCacheSizeGB",
    "0.5",
    "--quiet",
  ]);
  directUri = `mongodb://127.0.0.1:${port}`;
  const bootstrap = new MongoClient(
    `${directUri}/admin?directConnection=true`,
    {
      serverSelectionTimeoutMS: 30_000,
    },
  );
  try {
    await bootstrap.connect();
    await bootstrap.db("admin").command({
      replSetInitiate: {
        _id: replicaSet,
        members: [{ _id: 0, host: "localhost:27017" }],
      },
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      const hello = await bootstrap.db("admin").command({ hello: 1 });
      if (hello.isWritablePrimary === true) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await bootstrap.close();
  }
  controlClient = new MongoClient(
    `${directUri}/admin?directConnection=true&replicaSet=${encodeURIComponent(replicaSet)}`,
    { serverSelectionTimeoutMS: 30_000 },
  );
  await controlClient.connect();
}, 120_000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const name of databaseNames) {
    await controlClient.db(name).dropDatabase();
  }
  databaseNames.clear();
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

afterAll(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await controlClient?.close();
  spawnSync("docker", ["rm", "--force", container]);
});

registerRequiredInsightsModelTests(createHarness);
