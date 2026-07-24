import type {
  HotUpdaterVersionMetadataContribution,
  JsonValue,
} from "./contracts";
import { HotUpdaterConstructionError } from "./errors";
import { copyJsonValue, isJsonRecord } from "./jsonValue";

export const VERSION_METADATA_DEADLINE_MS = 5_000;
export const VERSION_METADATA_CONTRIBUTION_BYTES = 16 * 1_024;
export const VERSION_METADATA_AGGREGATE_BYTES = 64 * 1_024;

export type CompiledVersionMetadata = {
  readonly contributions: readonly HotUpdaterVersionMetadataContribution[];
};

export type VersionMetadataResolution =
  | {
      readonly kind: "metadata";
      readonly value: Readonly<Record<string, JsonValue>>;
    }
  | { readonly kind: "response"; readonly response: Response };

type ValidatedContribution = {
  readonly value: Readonly<Record<string, JsonValue>>;
};

const copyContribution = (
  contribution: HotUpdaterVersionMetadataContribution,
): HotUpdaterVersionMetadataContribution =>
  Object.freeze({
    keys: Object.freeze([...contribution.keys].sort()),
    namespace: contribution.namespace,
    optionalKeys: Object.freeze([...(contribution.optionalKeys ?? [])].sort()),
    resolve: contribution.resolve,
    target: contribution.target,
  });

export type CompileVersionMetadataOptions = {
  readonly contributions: readonly HotUpdaterVersionMetadataContribution[];
  readonly reservedCoreKeys?: readonly string[];
};

export const compileVersionMetadata = (
  options: CompileVersionMetadataOptions,
): CompiledVersionMetadata => {
  const namespaces = new Set<string>();
  const keys = new Set(options.reservedCoreKeys ?? []);
  const contributions = [...options.contributions]
    .sort((left, right) => left.namespace.localeCompare(right.namespace))
    .map((contribution) => {
      if (namespaces.has(contribution.namespace)) {
        throw new HotUpdaterConstructionError("DUPLICATE_METADATA_NAMESPACE", {
          namespace: contribution.namespace,
        });
      }
      namespaces.add(contribution.namespace);
      if (contribution.target !== "capabilities") {
        throw new HotUpdaterConstructionError("INVALID_PLUGIN_CONTRIBUTION", {
          pluginId: contribution.namespace,
        });
      }
      for (const key of [
        ...contribution.keys,
        ...(contribution.optionalKeys ?? []),
      ]) {
        if (key.length === 0 || keys.has(key)) {
          throw new HotUpdaterConstructionError("DUPLICATE_METADATA_WIRE_KEY", {
            key,
          });
        }
        keys.add(key);
      }
      return copyContribution(contribution);
    });
  return Object.freeze({
    contributions: Object.freeze(contributions),
  });
};

const validateContribution = (
  contribution: HotUpdaterVersionMetadataContribution,
  value: unknown,
): ValidatedContribution => {
  const copied = copyJsonValue(value);
  if (copied.kind === "invalid" || !isJsonRecord(copied.value)) {
    throw new Error("Invalid metadata.");
  }
  const actualKeys = Object.keys(copied.value).sort();
  const requiredKeys = new Set(contribution.keys);
  const allowedKeys = new Set([
    ...contribution.keys,
    ...(contribution.optionalKeys ?? []),
  ]);
  if (
    contribution.keys.some((key) => !actualKeys.includes(key)) ||
    actualKeys.some((key) => !allowedKeys.has(key)) ||
    requiredKeys.size !== contribution.keys.length
  ) {
    throw new Error("Invalid metadata.");
  }
  const serialized = JSON.stringify(copied.value);
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > VERSION_METADATA_CONTRIBUTION_BYTES) {
    throw new Error("Invalid metadata.");
  }
  return { value: copied.value };
};

export type ResolveVersionMetadataOptions = {
  readonly compiled: CompiledVersionMetadata;
  readonly deadlineMs?: number;
};

export const resolveVersionMetadata = async (
  options: ResolveVersionMetadataOptions,
): Promise<VersionMetadataResolution> => {
  const controller = new AbortController();
  const deadlineMs = options.deadlineMs ?? VERSION_METADATA_DEADLINE_MS;
  let rejectDeadline: (reason?: unknown) => void = () => undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timeout = setTimeout(() => {
    controller.abort();
    rejectDeadline(new Error("Metadata deadline exceeded."));
  }, deadlineMs);

  try {
    const pending = options.compiled.contributions.map(async (contribution) =>
      validateContribution(
        contribution,
        await contribution.resolve(controller.signal),
      ),
    );
    const values = await Promise.race([Promise.all(pending), deadline]);
    const output: Record<string, JsonValue> = {};
    values.forEach((contribution) => {
      for (const [key, value] of Object.entries(contribution.value)) {
        Object.defineProperty(output, key, {
          enumerable: true,
          value,
        });
      }
    });
    const aggregateBytes = new TextEncoder().encode(
      JSON.stringify(output),
    ).byteLength;
    if (aggregateBytes > VERSION_METADATA_AGGREGATE_BYTES) {
      throw new Error("Invalid metadata.");
    }
    return { kind: "metadata", value: Object.freeze(output) };
  } catch {
    controller.abort();
    return {
      kind: "response",
      response: Response.json(
        { error: "Internal server error" },
        { status: 500 },
      ),
    };
  } finally {
    clearTimeout(timeout);
  }
};
