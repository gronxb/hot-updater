import type {
  RouteConfig,
  StandaloneRepositoryConfig,
} from "./standaloneRoutes";
import { createStandaloneTransport } from "./standaloneTransport";
import type { StandaloneRequestOptions } from "./standaloneTransport";

type StandaloneDatabaseErrorCode = "invalid-response" | "request-failed";

export class StandaloneDatabaseError extends Error {
  readonly name = "StandaloneDatabaseError";

  constructor(
    readonly code: StandaloneDatabaseErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const createStandaloneHttp = (config: StandaloneRepositoryConfig) => {
  const transport = createStandaloneTransport(config);
  const request = (
    route: RouteConfig,
    options: StandaloneRequestOptions,
  ): Promise<Response> =>
    transport.request(
      {
        ...route,
        headers: {
          "Content-Type": "application/json",
          ...route.headers,
        },
      },
      options,
    );
  const requestFailed = async (response: Response): Promise<never> => {
    throw new StandaloneDatabaseError(
      "request-failed",
      `Database request failed with status ${response.status}.`,
      response.status,
    );
  };
  const parseJson = async (response: Response): Promise<unknown> => {
    if (!response.ok) return requestFailed(response);
    try {
      return await response.json();
    } catch {
      throw new StandaloneDatabaseError(
        "invalid-response",
        "Database response must contain JSON.",
        response.status,
      );
    }
  };
  const load = async <TResult>(
    route: RouteConfig,
    searchParams: Readonly<Record<string, string>>,
    isResult: (value: unknown) => value is TResult,
    invalidMessage: string,
    signal?: AbortSignal,
  ): Promise<TResult> => {
    const response = await request(route, {
      method: "GET",
      searchParams: new URLSearchParams(searchParams),
      signal,
    });
    const value = await parseJson(response);
    if (!isResult(value)) {
      throw new StandaloneDatabaseError(
        "invalid-response",
        invalidMessage,
        response.status,
      );
    }
    return value;
  };

  return { load, parseJson, request, requestFailed };
};
