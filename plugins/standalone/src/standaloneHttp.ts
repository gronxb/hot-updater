import { type Lazy, resolveLazy } from "@hot-updater/plugin-core";

import type { StandaloneRepositoryConfig } from "./standaloneRoutes";

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

/** `headers` with each lazy value resolved. */
export const resolveHeaders = async (
  headers: Readonly<Record<string, Lazy<string>>> = {},
): Promise<Record<string, string>> =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(headers).map(
        async ([name, value]) => [name, await resolveLazy(value)] as const,
      ),
    ),
  );

export const createStandaloneHttp = (config: StandaloneRepositoryConfig) => {
  // Read on the first request, so a config loads without the URL.
  const buildUrl = (path: string): string =>
    `${config.baseUrl.replace(/\/+$/, "")}${path}`;
  const headers = async (routeHeaders?: Readonly<Record<string, string>>) => ({
    "Content-Type": "application/json",
    ...(await resolveHeaders(config.commonHeaders)),
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
  return { buildUrl, headers, parseJson };
};
