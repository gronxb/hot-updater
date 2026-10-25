/** A Google Cloud or Google Play API request that failed, with Google's error. */
export class GoogleApiError extends Error {
  readonly status: number;
  /** Google's canonical status, such as `PERMISSION_DENIED`. */
  readonly apiStatus: string | undefined;
  readonly apiMessage: string;
  /** The `ErrorInfo` reasons, such as `SERVICE_DISABLED`. */
  readonly reasons: readonly string[];
  /** The `PreconditionFailure` violation types, such as an org policy constraint. */
  readonly violations: readonly string[];
  /** The `ErrorInfo` consumer of a disabled service, such as `projects/123`. */
  readonly consumer: string | undefined;

  constructor(
    action: string,
    status: number,
    body: {
      apiStatus?: string;
      apiMessage?: string;
      reasons?: readonly string[];
      violations?: readonly string[];
      consumer?: string;
    } = {},
  ) {
    const apiMessage = body.apiMessage ?? "";
    super(
      `${action} failed (HTTP ${status})${apiMessage ? `: ${apiMessage}` : "."}`,
    );
    this.name = "GoogleApiError";
    this.status = status;
    this.apiStatus = body.apiStatus;
    this.apiMessage = apiMessage;
    this.reasons = body.reasons ?? [];
    this.violations = body.violations ?? [];
    this.consumer = body.consumer;
  }
}

interface GoogleErrorDetail {
  readonly "@type"?: string;
  readonly reason?: string;
  readonly metadata?: Record<string, string>;
  readonly violations?: readonly { readonly type?: string }[];
}

/** Google's error body, `{ error: { code, status, message, details } }`. */
const readError = async (action: string, response: Response) => {
  let error:
    | {
        status?: unknown;
        message?: unknown;
        details?: readonly GoogleErrorDetail[];
      }
    | undefined;
  try {
    error = ((await response.json()) as { error?: typeof error }).error;
  } catch {
    // Not JSON: only the status says what failed.
  }
  const details: readonly GoogleErrorDetail[] = Array.isArray(error?.details)
    ? error.details
    : [];
  const info = details.filter((detail) => typeof detail.reason === "string");
  return new GoogleApiError(action, response.status, {
    ...(typeof error?.status === "string" ? { apiStatus: error.status } : {}),
    ...(typeof error?.message === "string"
      ? { apiMessage: error.message }
      : {}),
    reasons: info.map((detail) => detail.reason!),
    violations: details.flatMap((detail) =>
      (detail.violations ?? []).flatMap((violation) =>
        typeof violation.type === "string" ? [violation.type] : [],
      ),
    ),
    ...(info.find((detail) => detail.metadata?.["consumer"])
      ? {
          consumer: info.find((detail) => detail.metadata?.["consumer"])!
            .metadata!["consumer"],
        }
      : {}),
  });
};

/** Whether Google answered that a service is disabled in a project. */
export const isServiceDisabled = (error: unknown): error is GoogleApiError =>
  error instanceof GoogleApiError &&
  (error.reasons.includes("SERVICE_DISABLED") ||
    /has not been used in project .* or it is disabled/i.test(
      error.apiMessage,
    ));

export type GoogleRequest = <T>(
  action: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
) => Promise<T>;

/** Requests with the signed-in user's access token, throwing `GoogleApiError`. */
export const createGoogleRequest =
  ({
    accessToken,
    fetch,
  }: {
    accessToken: string;
    fetch: typeof globalThis.fetch;
  }): GoogleRequest =>
  async <T>(
    action: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    body?: unknown,
  ): Promise<T> => {
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw await readError(action, response);
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  };

/** A long-running operation, as Resource Manager and Service Usage answer. */
export interface GoogleOperation<T = unknown> {
  readonly name?: string;
  readonly done?: boolean;
  readonly error?: { readonly code?: number; readonly message?: string };
  readonly response?: T;
}

/**
 * Polls `operation` at `origin` until it is done, returning its response or
 * throwing its error as a `GoogleApiError` with the operation's code.
 */
export const waitForOperation = async <T>({
  request,
  origin,
  operation,
  action,
  sleep,
  intervalMs = 2_000,
  attempts = 60,
}: {
  request: GoogleRequest;
  origin: string;
  operation: GoogleOperation<T>;
  action: string;
  sleep: (ms: number) => Promise<void>;
  intervalMs?: number;
  attempts?: number;
}): Promise<T | undefined> => {
  let current = operation;
  for (let attempt = 0; !current.done; attempt++) {
    if (attempt >= attempts || !current.name) {
      throw new Error(`${action} did not finish in time.`);
    }
    await sleep(intervalMs);
    current = await request<GoogleOperation<T>>(
      action,
      "GET",
      `${origin}/${current.name}`,
    );
  }
  if (current.error) {
    // An operation's error code is a google.rpc.Code, not an HTTP status.
    throw new GoogleApiError(action, 400, {
      apiMessage: current.error.message ?? "",
      ...(current.error.code === 7 ? { apiStatus: "PERMISSION_DENIED" } : {}),
      ...(current.error.code === 8 ? { apiStatus: "RESOURCE_EXHAUSTED" } : {}),
    });
  }
  return current.response;
};
