export type JsonObject = Record<string, unknown>;

export type ResponseLike = {
  readonly ok: boolean;
  readonly status: number;
  readonly text: () => Promise<string>;
};

export type ControlFetch = (
  url: string,
  init: RequestInit,
) => Promise<ResponseLike>;

export type StageOutcome = "failed" | "succeeded";

export type StageTiming = {
  readonly diagnostic?: string;
  readonly durationMs: number;
  readonly endedAtMs: number;
  readonly outcome: StageOutcome;
  readonly stage: string;
  readonly startedAtMs: number;
};

export type ControlJobState = {
  readonly error?: string;
  readonly result?: JsonObject;
  readonly status: "failed" | "running" | "succeeded";
};

export class ControlEndpointError extends Error {
  readonly body: string;
  readonly pathName: string;
  readonly stage: string;
  readonly status: number;

  constructor(input: {
    readonly body: string;
    readonly pathName: string;
    readonly stage: string;
    readonly status: number;
  }) {
    super(`${input.stage} failed with HTTP ${input.status}: ${input.body}`);
    this.name = "ControlEndpointError";
    this.body = input.body;
    this.pathName = input.pathName;
    this.stage = input.stage;
    this.status = input.status;
  }
}

export class ControlJobError extends Error {
  readonly jobId: string;
  readonly stage: string;

  constructor(input: {
    readonly jobId: string;
    readonly message: string;
    readonly stage: string;
  }) {
    super(`${input.stage} job ${input.jobId} failed: ${input.message}`);
    this.name = "ControlJobError";
    this.jobId = input.jobId;
    this.stage = input.stage;
  }
}

export class ControlProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlProtocolError";
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readJsonObject(text: string, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ControlProtocolError(
      `${label} returned invalid JSON: ${message}`,
    );
  }

  if (!isJsonObject(parsed)) {
    throw new ControlProtocolError(`${label} returned non-object JSON`);
  }
  return parsed;
}

export function readStringField(
  source: JsonObject,
  fieldName: string,
): string | undefined {
  const value = source[fieldName];
  return typeof value === "string" ? value : undefined;
}

export function readJobState(
  source: JsonObject,
  label: string,
): ControlJobState {
  const status = source.status;
  if (status !== "failed" && status !== "running" && status !== "succeeded") {
    throw new ControlProtocolError(`${label} returned invalid job status`);
  }

  const result = source.result;
  if (result !== undefined && !isJsonObject(result)) {
    throw new ControlProtocolError(`${label} returned non-object job result`);
  }

  return {
    error: readStringField(source, "error"),
    result,
    status,
  };
}
