import { createBundleRouteHandlers } from "./handlerBundleRoutes";
import {
  HandlerBadRequestError,
  HandlerPayloadTooLargeError,
} from "./handlerErrors";
import type { HandlerAPI, RouteHandler } from "./handlerTypes";
import { createUpdateRouteHandlers } from "./handlerUpdateRoutes";
import type {
  HotUpdaterRouteContext,
  HotUpdaterServerRoute,
} from "./kernel/contracts";
import type { CoreRouteDescriptor } from "./kernel/coreRoutes";
import {
  resolveVersionMetadata,
  type CompiledVersionMetadata,
} from "./kernel/metadata";
import { HOT_UPDATER_SERVER_VERSION } from "./version";

export type CreateCoreServerRoutesOptions<TContext, TDatabaseContext> = {
  readonly api: HandlerAPI<TDatabaseContext>;
  readonly descriptors: readonly CoreRouteDescriptor[];
  readonly resolveMetadata: () => CompiledVersionMetadata | undefined;
  readonly toDatabaseContext: (
    context: HotUpdaterRouteContext<TContext>,
  ) => TDatabaseContext | undefined;
};

const requestParser = Object.freeze({
  parse(request: Request): Promise<Request> {
    return Promise.resolve(request);
  },
});

const errorResponse = (error: HandlerBadRequestError): Response =>
  Response.json({ error: error.message }, { status: 400 });

const resolveRouteHandler = <TContext>(
  descriptor: CoreRouteDescriptor,
  updates: Record<string, RouteHandler<TContext>>,
  bundles: Record<string, RouteHandler<TContext>>,
): RouteHandler<TContext> | undefined => {
  switch (descriptor.id) {
    case "core.update.fingerprint":
    case "core.update.fingerprint-cohort":
      return updates.fingerprintUpdateWithCohort;
    case "core.update.app-version":
    case "core.update.app-version-cohort":
      return updates.appVersionUpdateWithCohort;
    case "core.bundles.channels":
      return bundles.getChannels;
    case "core.bundles.get":
      return bundles.getBundle;
    case "core.bundles.list":
      return bundles.getBundles;
    case "core.bundles.create":
      return bundles.createBundles;
    case "core.bundles.update":
      return bundles.updateBundle;
    case "core.bundles.delete":
      return bundles.deleteBundle;
    default:
      return undefined;
  }
};

const executeRouteHandler = async <TContext, TDatabaseContext>(
  api: HandlerAPI<TDatabaseContext>,
  context: HotUpdaterRouteContext<TContext>,
  handler: RouteHandler<TDatabaseContext>,
  request: Request,
  databaseContext: TDatabaseContext | undefined,
): Promise<Response> => {
  try {
    return await handler(context.route.params, request, api, databaseContext);
  } catch (error) {
    if (error instanceof HandlerBadRequestError) {
      return errorResponse(error);
    }
    if (error instanceof HandlerPayloadTooLargeError) {
      return Response.json({ error: error.message }, { status: 413 });
    }
    throw error;
  }
};

const createVersionRoute = <TContext>(
  descriptor: CoreRouteDescriptor,
  resolveMetadata: () => CompiledVersionMetadata | undefined,
): HotUpdaterServerRoute<unknown, TContext> =>
  Object.freeze({
    access: descriptor.access,
    id: descriptor.id,
    method: descriptor.method,
    path: descriptor.path,
    async handle() {
      const compiled = resolveMetadata();
      if (compiled === undefined) {
        return Response.json(
          { error: "Internal server error" },
          { status: 500 },
        );
      }
      const resolved = await resolveVersionMetadata({ compiled });
      if (resolved.kind === "response") return resolved.response;
      return Response.json({
        capabilities: resolved.value,
        version: HOT_UPDATER_SERVER_VERSION,
      });
    },
  });

export const createCoreServerRoutes = <TContext, TDatabaseContext>(
  options: CreateCoreServerRoutesOptions<TContext, TDatabaseContext>,
): readonly HotUpdaterServerRoute[] => {
  const updates = createUpdateRouteHandlers<TDatabaseContext>();
  const bundles = createBundleRouteHandlers<TDatabaseContext>();
  return Object.freeze(
    options.descriptors.map((descriptor) => {
      if (descriptor.id === "core.version") {
        return createVersionRoute<TContext>(
          descriptor,
          options.resolveMetadata,
        );
      }
      const handler = resolveRouteHandler(descriptor, updates, bundles);
      if (handler === undefined) {
        throw new Error(`Unknown core route: ${descriptor.id}`);
      }
      return Object.freeze({
        access: descriptor.access,
        id: descriptor.id,
        input: requestParser,
        method: descriptor.method,
        path: descriptor.path,
        handle(context: HotUpdaterRouteContext<TContext>, request: Request) {
          return executeRouteHandler(
            options.api,
            context,
            handler,
            request,
            options.toDatabaseContext(context),
          );
        },
      }) satisfies HotUpdaterServerRoute<Request, TContext>;
    }),
  );
};
