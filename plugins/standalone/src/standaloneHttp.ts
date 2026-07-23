import type {
  RouteConfig,
  StandaloneRepositoryConfig,
} from "./standaloneRoutes";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const createStandaloneHttp = (config: StandaloneRepositoryConfig) => {
  const buildUrl = (path: string): string => `${config.baseUrl}${path}`;
  const headers = (routeHeaders?: Readonly<Record<string, string>>) => ({
    "Content-Type": "application/json",
    ...config.commonHeaders,
    ...routeHeaders,
  });
  const requestFailed = async (response: Response): Promise<never> => {
    let message = `Database request failed with status ${response.status}.`;
    try {
      const body: unknown = await response.json();
      if (isRecord(body) && typeof body.message === "string") {
        message = body.message;
      } else if (isRecord(body) && typeof body.error === "string") {
        message = body.error;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    throw new StandaloneDatabaseError(
      "request-failed",
      message,
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
  ): Promise<TResult> => {
    const url = new URL(buildUrl(route.path));
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url, {
      method: "GET",
      headers: headers(route.headers),
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

  return { buildUrl, headers, load, parseJson, requestFailed };
};
