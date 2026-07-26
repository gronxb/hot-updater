import {
  isConfigReference,
  resolveConfigReference,
  type ConfigReference,
} from "@hot-updater/core/config";
import {
  createStoragePlugin,
  type StorageOperationContext,
  type StoragePlugin,
} from "@hot-updater/plugin-core/storage";

import {
  STANDALONE_STORAGE_V2,
  type StandaloneStorageV2RouteName,
} from "./standaloneStorageContract";
import {
  createStandaloneStorageOperations,
  type StandaloneStorageRequest,
} from "./standaloneStorageOperations";
import {
  createStandaloneTransport,
  type StandaloneTransportRoute,
} from "./standaloneTransport";

type ContextString = string | ConfigReference;

export type StandaloneStorageV2Route = Readonly<{
  path: string;
  headers?: Readonly<Record<string, ContextString>>;
}>;

export type StandaloneStorageV2Config = Readonly<{
  baseUrl: ContextString;
  commonHeaders?: Readonly<Record<string, ContextString>>;
  routes?: Partial<
    Readonly<Record<StandaloneStorageV2RouteName, StandaloneStorageV2Route>>
  >;
}>;

const resolveString = (
  value: ContextString,
  context: StorageOperationContext,
): string =>
  isConfigReference(value)
    ? resolveConfigReference<string>(value, context)
    : value;

const isLiteralConfig = (config: StandaloneStorageV2Config): boolean =>
  !isConfigReference(config.baseUrl) &&
  Object.values(config.commonHeaders ?? {}).every(
    (value) => !isConfigReference(value),
  ) &&
  Object.values(config.routes ?? {}).every((route) =>
    Object.values(route.headers ?? {}).every(
      (value) => !isConfigReference(value),
    ),
  );

const defaultRoutes: Readonly<
  Record<StandaloneStorageV2RouteName, StandaloneStorageV2Route>
> = Object.freeze({
  object: Object.freeze({ path: STANDALONE_STORAGE_V2.routes.object }),
  delivery: Object.freeze({ path: STANDALONE_STORAGE_V2.routes.delivery }),
});

export const standaloneStorage = (
  config: StandaloneStorageV2Config,
): StoragePlugin => {
  const literal = isLiteralConfig(config);
  const cachedTransport = literal
    ? createStandaloneTransport({
        baseUrl: String(config.baseUrl),
        commonHeaders: Object.fromEntries(
          Object.entries(config.commonHeaders ?? {}).map(([key, value]) => [
            key,
            String(value),
          ]),
        ),
      })
    : undefined;

  const request: StandaloneStorageRequest = (
    routeName: StandaloneStorageV2RouteName,
    context: StorageOperationContext,
    options: Parameters<
      ReturnType<typeof createStandaloneTransport>["request"]
    >[1],
  ): Promise<Response> => {
    const transport =
      cachedTransport ??
      createStandaloneTransport({
        baseUrl: resolveString(config.baseUrl, context),
        commonHeaders: Object.fromEntries(
          Object.entries(config.commonHeaders ?? {}).map(([key, value]) => [
            key,
            resolveString(value, context),
          ]),
        ),
      });
    const configured = config.routes?.[routeName];
    const fallback = defaultRoutes[routeName];
    const route: StandaloneTransportRoute = {
      path: configured?.path ?? fallback.path,
      headers: Object.fromEntries(
        Object.entries(configured?.headers ?? {}).map(([key, value]) => [
          key,
          resolveString(value, context),
        ]),
      ),
    };
    return transport.request(route, options);
  };

  return createStoragePlugin({
    name: "standaloneStorage",
    protocol: "http",
    plugin: () => createStandaloneStorageOperations(request),
  });
};

export { StandaloneStorageHttpError } from "./standaloneStorageOperations";
export { STANDALONE_STORAGE_V2 } from "./standaloneStorageContract";
export {
  createStandaloneStorageHandler,
  type StandaloneStorageHandlerOptions,
} from "./standaloneStorageHandler";
