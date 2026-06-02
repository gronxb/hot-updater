import { setTimeout as sleep } from "node:timers/promises";

import {
  ControlEndpointError,
  ControlJobError,
  ControlProtocolError,
  readJobState,
  readJsonObject,
  readStringField,
} from "./control-protocol.ts";
import type {
  ControlFetch,
  JsonObject,
  ResponseLike,
  StageTiming,
} from "./control-protocol.ts";

export {
  ControlEndpointError,
  ControlJobError,
  ControlProtocolError,
  type ControlFetch,
  type JsonObject,
  type ResponseLike,
  type StageTiming,
} from "./control-protocol.ts";

type ControlClientOptions = {
  readonly baseUrl: string;
  readonly fetch?: ControlFetch;
  readonly httpTimeoutMs?: number;
  readonly jobTimeoutMs?: number;
  readonly nowMs?: () => number;
  readonly onStageTiming?: (timing: StageTiming) => void;
  readonly pollDelayMs?: (durationMs: number) => Promise<void>;
  readonly pollIntervalMs?: number;
};

const defaultHttpTimeoutMs = 120 * 1000;
const defaultJobTimeoutMs = Number(
  process.env.HOT_UPDATER_E2E_CONTROL_JOB_TIMEOUT_MS || 45 * 60 * 1000,
);
const defaultPollIntervalMs = 1000;
const closeConnectionHeader = { connection: "close" } as const;

function defaultFetch(url: string, init: RequestInit): Promise<ResponseLike> {
  return fetch(url, init);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function formatDiagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ControlClient {
  private readonly baseUrl: string;
  private readonly fetch: ControlFetch;
  private readonly httpTimeoutMs: number;
  private readonly jobTimeoutMs: number;
  private readonly nowMs: () => number;
  private readonly onStageTiming?: (timing: StageTiming) => void;
  private readonly pollDelayMs: (durationMs: number) => Promise<void>;
  private readonly pollIntervalMs: number;

  constructor(options: ControlClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetch = options.fetch ?? defaultFetch;
    this.httpTimeoutMs = options.httpTimeoutMs ?? defaultHttpTimeoutMs;
    this.jobTimeoutMs = options.jobTimeoutMs ?? defaultJobTimeoutMs;
    this.nowMs = options.nowMs ?? Date.now;
    this.onStageTiming = options.onStageTiming;
    this.pollDelayMs = options.pollDelayMs ?? sleep;
    this.pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
  }

  async postJson(
    stage: string,
    pathName: string,
    body?: JsonObject,
  ): Promise<JsonObject> {
    return this.runStage(stage, () =>
      this.postJsonUntraced(stage, pathName, body),
    );
  }

  async runJob(
    stage: string,
    pathName: string,
    body?: JsonObject,
  ): Promise<JsonObject> {
    return this.runStage(stage, async () => {
      const started = await this.postJsonUntraced(stage, pathName, body);
      const jobId = readStringField(started, "jobId");
      if (!jobId) {
        throw new ControlProtocolError(`${pathName} did not return a jobId`);
      }
      return this.waitForJobUntraced(stage, jobId);
    });
  }

  private async runStage<T>(
    stage: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAtMs = this.nowMs();
    try {
      const result = await operation();
      this.recordStage(stage, startedAtMs, "succeeded");
      return result;
    } catch (error) {
      this.recordStage(stage, startedAtMs, "failed", formatDiagnostic(error));
      throw error;
    }
  }

  private recordStage(
    stage: string,
    startedAtMs: number,
    outcome: "failed" | "succeeded",
    diagnostic?: string,
  ): void {
    const endedAtMs = this.nowMs();
    const timing = {
      durationMs: endedAtMs - startedAtMs,
      endedAtMs,
      outcome,
      stage,
      startedAtMs,
    };
    this.onStageTiming?.(
      diagnostic === undefined ? timing : { ...timing, diagnostic },
    );
  }

  private async postJsonUntraced(
    stage: string,
    pathName: string,
    body?: JsonObject,
  ): Promise<JsonObject> {
    const response = await this.fetch(`${this.baseUrl}${pathName}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "content-type": "application/json", ...closeConnectionHeader },
      method: "POST",
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
    return readResponseJson(response, pathName, stage);
  }

  private async waitForJobUntraced(
    stage: string,
    jobId: string,
  ): Promise<JsonObject> {
    const deadlineMs = this.nowMs() + this.jobTimeoutMs;
    for (;;) {
      const state = readJobState(
        await this.getJsonUntraced(`/e2e/jobs/${jobId}`),
        `/e2e/jobs/${jobId}`,
      );
      if (state.status === "succeeded") return state.result ?? {};
      if (state.status === "failed") {
        throw new ControlJobError({
          jobId,
          message: state.error ?? "Unknown control job failure",
          stage,
        });
      }
      if (this.nowMs() >= deadlineMs) {
        throw new ControlJobError({
          jobId,
          message: `timed out after ${this.jobTimeoutMs}ms`,
          stage,
        });
      }
      await this.pollDelayMs(this.pollIntervalMs);
    }
  }

  private async getJsonUntraced(pathName: string): Promise<JsonObject> {
    const response = await this.fetch(`${this.baseUrl}${pathName}`, {
      headers: closeConnectionHeader,
      method: "GET",
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
    return readResponseJson(response, pathName, pathName);
  }
}

async function readResponseJson(
  response: ResponseLike,
  pathName: string,
  stage: string,
): Promise<JsonObject> {
  const text = await response.text();
  if (!response.ok) {
    throw new ControlEndpointError({
      body: text,
      pathName,
      stage,
      status: response.status,
    });
  }
  return readJsonObject(text, pathName);
}

export function createControlClient(
  options: ControlClientOptions,
): ControlClient {
  return new ControlClient(options);
}
