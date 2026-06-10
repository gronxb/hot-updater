import { setTimeout as sleep } from "node:timers/promises";

import {
  ControlEndpointError,
  ControlJobError,
  ControlProtocolError,
  isJsonObject,
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
  readonly screenStateTimeoutMs?: number;
};

type ScreenStateWaitOptions = {
  readonly expectedValue?: string;
  readonly rejectSubstrings?: readonly string[];
  readonly rejectValues?: readonly string[];
  readonly timeoutMs?: number;
};

const defaultHttpTimeoutMs = 120 * 1000;
const defaultJobTimeoutMs = Number(
  process.env.HOT_UPDATER_E2E_CONTROL_JOB_TIMEOUT_MS || 10 * 60 * 1000,
);
const defaultScreenStateTimeoutMs = 60 * 1000;
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
  private readonly screenStateTimeoutMs: number;

  constructor(options: ControlClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetch = options.fetch ?? defaultFetch;
    this.httpTimeoutMs = options.httpTimeoutMs ?? defaultHttpTimeoutMs;
    this.jobTimeoutMs = options.jobTimeoutMs ?? defaultJobTimeoutMs;
    this.nowMs = options.nowMs ?? Date.now;
    this.onStageTiming = options.onStageTiming;
    this.pollDelayMs = options.pollDelayMs ?? sleep;
    this.pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
    this.screenStateTimeoutMs =
      options.screenStateTimeoutMs ?? defaultScreenStateTimeoutMs;
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

  async waitForScreenStateField(
    stage: string,
    fieldName: string,
    options: ScreenStateWaitOptions = {},
  ): Promise<JsonObject> {
    return this.runStage(stage, () =>
      this.waitForScreenStateFieldUntraced(stage, fieldName, options),
    );
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
      if (state.status === "failed" || state.status === "cancelled") {
        throw new ControlJobError({
          jobId,
          message: state.error ?? "Unknown control job failure",
          stage,
        });
      }
      if (this.nowMs() >= deadlineMs) {
        const cancelError = await this.cancelJobUntraced(stage, jobId);
        const cancelSuffix = cancelError
          ? `; cancel request failed: ${cancelError}`
          : "";
        throw new ControlJobError({
          jobId,
          message: `timed out after ${this.jobTimeoutMs}ms${cancelSuffix}`,
          stage,
        });
      }
      await this.pollDelayMs(this.pollIntervalMs);
    }
  }

  private async waitForScreenStateFieldUntraced(
    stage: string,
    fieldName: string,
    options: ScreenStateWaitOptions,
  ): Promise<JsonObject> {
    const timeoutMs = options.timeoutMs ?? this.screenStateTimeoutMs;
    const deadlineMs = this.nowMs() + timeoutMs;
    for (;;) {
      const runtimeConfig = await this.getJsonUntraced("/e2e/runtime-config");
      const screenState = runtimeConfig.screenState;
      if (!isJsonObject(screenState)) {
        throw new ControlProtocolError(
          "/e2e/runtime-config returned non-object screenState",
        );
      }
      const value = readStringField(screenState, fieldName);
      if (value !== undefined && isAcceptedScreenStateValue(value, options)) {
        return { [fieldName]: value };
      }
      if (this.nowMs() >= deadlineMs) {
        throw new ControlProtocolError(
          `${stage} timed out waiting for ${fieldName} after ${timeoutMs}ms`,
        );
      }
      await this.pollDelayMs(this.pollIntervalMs);
    }
  }

  private async cancelJobUntraced(
    stage: string,
    jobId: string,
  ): Promise<string | null> {
    try {
      const response = await this.fetch(`${this.baseUrl}/e2e/jobs/${jobId}`, {
        headers: closeConnectionHeader,
        method: "DELETE",
        signal: AbortSignal.timeout(this.httpTimeoutMs),
      });
      await readResponseJson(response, `/e2e/jobs/${jobId}`, stage);
      return null;
    } catch (error) {
      return formatDiagnostic(error);
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

function isAcceptedScreenStateValue(
  value: string,
  options: ScreenStateWaitOptions,
): boolean {
  if (options.expectedValue !== undefined && value !== options.expectedValue) {
    return false;
  }
  if (options.rejectValues?.includes(value)) return false;
  return !options.rejectSubstrings?.some((substring) =>
    value.includes(substring),
  );
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
