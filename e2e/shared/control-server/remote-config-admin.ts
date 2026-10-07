/**
 * Remote Config's admin routes, as the Console reaches a self-hosted server:
 * the scenarios publish and roll back templates through them, against the
 * active version the server reports, so earlier scenarios' versions never
 * matter.
 */
export type RemoteConfigAdminClient = {
  /** Publishes a template as the next version; returns its number. */
  publish(input: {
    readonly template: unknown;
    readonly description?: string;
  }): Promise<number>;
  /** Publishes a copy of `version` as the next version; returns its number. */
  rollback(version: number): Promise<number>;
};

type RemoteConfigAdminClientOptions = {
  /** The admin handler's mount, such as `http://127.0.0.1:3007/hot-updater/admin`. */
  readonly baseUrl: string;
  readonly headers?: HeadersInit;
  readonly fetch?: typeof globalThis.fetch;
};

export class RemoteConfigAdminError extends Error {
  readonly name = "RemoteConfigAdminError";

  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: unknown,
  ) {
    super(
      `Remote Config admin route ${url} returned HTTP ${status}: ${JSON.stringify(body)}`,
    );
  }
}

const versionOf = (body: unknown, url: string): number => {
  const version =
    typeof body === "object" && body !== null
      ? Reflect.get(body, "version")
      : undefined;
  if (typeof version !== "number" || !Number.isSafeInteger(version)) {
    throw new RemoteConfigAdminError(200, url, body);
  }
  return version;
};

export const createRemoteConfigAdminClient = ({
  baseUrl,
  headers,
  fetch: fetchImplementation = globalThis.fetch,
}: RemoteConfigAdminClientOptions): RemoteConfigAdminClient => {
  const root = `${baseUrl.replace(/\/+$/, "")}/remote-config`;
  const request = async (
    path: string,
    init: { readonly method?: string; readonly body?: unknown } = {},
  ): Promise<unknown> => {
    const url = `${root}${path}`;
    const requestHeaders = new Headers(headers);
    requestHeaders.set("Accept", "application/json");
    if (init.body !== undefined) {
      requestHeaders.set("Content-Type", "application/json");
    }
    const response = await fetchImplementation(url, {
      method: init.method ?? "GET",
      headers: requestHeaders,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok)
      throw new RemoteConfigAdminError(response.status, url, body);
    return body;
  };
  const activeVersion = async () =>
    versionOf(await request("/template"), `${root}/template`);

  return {
    publish: async ({ template, description }) =>
      versionOf(
        await request("/template", {
          method: "PUT",
          body: {
            template,
            baseVersion: await activeVersion(),
            ...(description === undefined ? {} : { description }),
          },
        }),
        `${root}/template`,
      ),
    rollback: async (version) =>
      versionOf(
        await request(`/versions/${version}/rollback`, {
          method: "POST",
          body: { baseVersion: await activeVersion() },
        }),
        `${root}/versions/${version}/rollback`,
      ),
  };
};
