import type {
  RemoteConfigActive,
  RemoteConfigEvaluatedParameter,
  RemoteConfigEvaluationContext,
  RemoteConfigTemplateIssue,
  RemoteConfigVersionDetail,
  RemoteConfigVersionsPage,
} from "@hot-updater/server/plugins/remote-config";
import { createServerFn } from "@tanstack/react-start";

import { consoleAccess } from "./console-access";
import type { ConsolePublishResult } from "./server/remoteConfig";

export type { ConsolePublishResult } from "./server/remoteConfig";

/** What the preview shows: each parameter's value for the device, or what to fix first. */
export type RemoteConfigPreview =
  | {
      readonly status: "ok";
      readonly parameters: Readonly<
        Record<string, RemoteConfigEvaluatedParameter>
      >;
    }
  | {
      readonly status: "invalid";
      readonly issues: readonly RemoteConfigTemplateIssue[];
    };

/** Remote Config, once the console's access check and the feature guard pass. */
const remoteConfig = async () => {
  const [{ prepareConfig }, { requireFeature }] = await Promise.all([
    import("./server/config.server"),
    import("./server/runtime.server"),
  ]);
  const { runtime } = await prepareConfig();
  return requireFeature(runtime, "remoteConfig");
};

const field = (input: unknown, key: string): unknown =>
  typeof input === "object" && input !== null
    ? Reflect.get(input, key)
    : undefined;

const versionNumber = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
  return value;
};

const parseCursor = (input: unknown): { readonly cursor?: string } => {
  const cursor = field(input, "cursor");
  if (cursor !== undefined && typeof cursor !== "string") {
    throw new TypeError("cursor must be text.");
  }
  return cursor === undefined ? {} : { cursor };
};

const parseVersion = (input: unknown): { readonly version: number } => ({
  version: versionNumber(field(input, "version"), "version"),
});

const parsePublish = (
  input: unknown,
): {
  readonly template: unknown;
  readonly baseVersion: number;
  readonly description?: string;
} => {
  const description = field(input, "description");
  if (description !== undefined && typeof description !== "string") {
    throw new TypeError("description must be text.");
  }
  return {
    template: field(input, "template"),
    baseVersion: versionNumber(field(input, "baseVersion"), "baseVersion"),
    ...(description === undefined ? {} : { description }),
  };
};

const parseRollback = (
  input: unknown,
): { readonly version: number; readonly baseVersion: number } => ({
  version: versionNumber(field(input, "version"), "version"),
  baseVersion: versionNumber(field(input, "baseVersion"), "baseVersion"),
});

const CONTEXT_FIELDS = [
  "platform",
  "appVersion",
  "channel",
  "cohort",
  "fingerprintHash",
] as const;

const parsePreview = (
  input: unknown,
): {
  readonly template: unknown;
  readonly context: RemoteConfigEvaluationContext;
} => {
  const raw = field(input, "context");
  const context: Record<string, string> = {};
  for (const key of CONTEXT_FIELDS) {
    const value = field(raw, key);
    if (typeof value === "string" && value.trim().length > 0) {
      context[key] = value.trim();
    }
  }
  if (
    context.platform !== undefined &&
    context.platform !== "ios" &&
    context.platform !== "android"
  ) {
    throw new TypeError('platform must be "ios" or "android".');
  }
  return {
    template: field(input, "template"),
    context: context as RemoteConfigEvaluationContext,
  };
};

export const getRemoteConfigRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .handler(
    async (): Promise<RemoteConfigActive> => (await remoteConfig()).getActive(),
  );

export const listRemoteConfigVersionsRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator(parseCursor)
  .handler(
    async ({ data }): Promise<RemoteConfigVersionsPage> =>
      (await remoteConfig()).listVersions({ limit: 20, ...data }),
  );

export const getRemoteConfigVersionRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator(parseVersion)
  .handler(
    async ({ data }): Promise<RemoteConfigVersionDetail | null> =>
      (await remoteConfig()).getVersion(data.version),
  );

export const publishRemoteConfigRpc = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator(parsePublish)
  .handler(
    async ({ data }): Promise<ConsolePublishResult> =>
      (await remoteConfig()).publish(data),
  );

export const rollbackRemoteConfigRpc = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator(parseRollback)
  .handler(
    async ({
      data,
    }): Promise<ConsolePublishResult | { readonly status: "not_found" }> =>
      (await remoteConfig()).rollback(data),
  );

/** What a device with `context` would receive from a template, published or not. */
export const previewRemoteConfigRpc = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator(parsePreview)
  .handler(async ({ data }): Promise<RemoteConfigPreview> => {
    await remoteConfig();
    const {
      evaluateRemoteConfig,
      RemoteConfigValidationError,
      validateRemoteConfigTemplate,
    } = await import("@hot-updater/server/plugins/remote-config");
    try {
      return {
        status: "ok",
        parameters: evaluateRemoteConfig(
          validateRemoteConfigTemplate(data.template),
          data.context,
        ),
      };
    } catch (error) {
      if (error instanceof RemoteConfigValidationError) {
        return { status: "invalid", issues: error.issues };
      }
      throw error;
    }
  });
