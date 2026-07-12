import type { DatabasePlugin } from "@hot-updater/plugin-core";
import { DatabasePluginInputError } from "@hot-updater/plugin-core";

import {
  isBundleCountBody,
  isBundleCreateBody,
  isBundleDeleteBody,
  isBundleFindManyBody,
  isBundleFindOneBody,
  isBundleUpdateBody,
  isChannelCreateBody,
  isChannelFindManyBody,
  isChannelFindOneBody,
  isGetBundlesArgs,
  isPatchCreateBody,
  isPatchDeleteBody,
  isPatchFindManyBody,
} from "./standaloneDatabaseValidation";

type ProtocolErrorCode =
  | "database-error"
  | "invalid-request"
  | "unsupported-capability"
  | "unsupported-operation";

type ProtocolError = {
  readonly code: ProtocolErrorCode;
  readonly message: string;
};

const rawJson = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const json = (data: unknown): Response => rawJson({ data });

const protocolError = (
  code: ProtocolErrorCode,
  message: string,
  status: number,
): Response =>
  rawJson({ error: { code, message } satisfies ProtocolError }, status);

const invalidBody = (model: string, operation: string): Response =>
  protocolError(
    "invalid-request",
    `Invalid request for database operation: ${model}.${operation}.`,
    400,
  );

const unsupported = (model: string, operation: string): Response =>
  protocolError(
    "unsupported-operation",
    `Unsupported database operation: ${model}.${operation}.`,
    400,
  );

type OperationOptions<TContext> = {
  readonly body: unknown;
  readonly context: TContext | undefined;
  readonly database: DatabasePlugin<TContext>;
  readonly model: string;
  readonly operation: string;
};

const executeBundles = async <TContext>(
  options: OperationOptions<TContext>,
): Promise<Response> => {
  const { body, context, database, operation } = options;
  switch (operation) {
    case "create":
      return isBundleCreateBody(body)
        ? json(await database.create({ model: "bundles", ...body }, context))
        : invalidBody("bundles", operation);
    case "update":
      return isBundleUpdateBody(body)
        ? json(await database.update({ model: "bundles", ...body }, context))
        : invalidBody("bundles", operation);
    case "delete":
      if (!isBundleDeleteBody(body)) return invalidBody("bundles", operation);
      await database.delete({ model: "bundles", ...body }, context);
      return json(null);
    case "count":
      return isBundleCountBody(body)
        ? json(await database.count({ model: "bundles", ...body }, context))
        : invalidBody("bundles", operation);
    case "findOne":
      return isBundleFindOneBody(body)
        ? json(await database.findOne({ model: "bundles", ...body }, context))
        : invalidBody("bundles", operation);
    case "findMany":
      return isBundleFindManyBody(body)
        ? json(await database.findMany({ model: "bundles", ...body }, context))
        : invalidBody("bundles", operation);
    case "getUpdateInfo":
      if (!isGetBundlesArgs(body)) return invalidBody("bundles", operation);
      return database.getUpdateInfo
        ? json(await database.getUpdateInfo(body, context))
        : protocolError(
            "unsupported-capability",
            "The database adapter does not implement getUpdateInfo.",
            501,
          );
    default:
      return unsupported("bundles", operation);
  }
};

const executePatches = async <TContext>(
  options: OperationOptions<TContext>,
): Promise<Response> => {
  const { body, context, database, operation } = options;
  switch (operation) {
    case "create":
      return isPatchCreateBody(body)
        ? json(
            await database.create(
              { model: "bundle_patches", ...body },
              context,
            ),
          )
        : invalidBody("bundle_patches", operation);
    case "delete":
      if (!isPatchDeleteBody(body)) {
        return invalidBody("bundle_patches", operation);
      }
      await database.delete({ model: "bundle_patches", ...body }, context);
      return json(null);
    case "findMany":
      return isPatchFindManyBody(body)
        ? json(
            await database.findMany(
              { model: "bundle_patches", ...body },
              context,
            ),
          )
        : invalidBody("bundle_patches", operation);
    default:
      return unsupported("bundle_patches", operation);
  }
};

const executeChannels = async <TContext>(
  options: OperationOptions<TContext>,
): Promise<Response> => {
  const { body, context, database, operation } = options;
  switch (operation) {
    case "create":
      return isChannelCreateBody(body)
        ? json(await database.create({ model: "channels", ...body }, context))
        : invalidBody("channels", operation);
    case "findOne":
      return isChannelFindOneBody(body)
        ? json(await database.findOne({ model: "channels", ...body }, context))
        : invalidBody("channels", operation);
    case "findMany":
      return isChannelFindManyBody(body)
        ? json(await database.findMany({ model: "channels", ...body }, context))
        : invalidBody("channels", operation);
    default:
      return unsupported("channels", operation);
  }
};

export const handleStandaloneDatabaseOperation = async <TContext>(
  request: Request,
  database: DatabasePlugin<TContext> | undefined,
  model: string,
  operation: string,
  context?: TContext,
): Promise<Response> => {
  if (!database) {
    return protocolError(
      "unsupported-capability",
      "The standalone database protocol is not configured.",
      501,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      return protocolError("invalid-request", "Invalid JSON body.", 400);
    }
    throw error;
  }

  try {
    const options = { body, context, database, model, operation };
    switch (model) {
      case "bundles":
        return await executeBundles(options);
      case "bundle_patches":
        return await executePatches(options);
      case "channels":
        return await executeChannels(options);
      default:
        return unsupported(model, operation);
    }
  } catch (error) {
    if (error instanceof DatabasePluginInputError) {
      return protocolError("invalid-request", error.message, 400);
    }
    return protocolError(
      "database-error",
      error instanceof Error ? error.message : "Database operation failed.",
      500,
    );
  }
};
