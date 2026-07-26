const CONFIG_REFERENCE_TYPE = "hot-updater.config-reference" as const;
const IDENTIFIER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONFIG_TARGETS = ["node", "worker", "functions", "edge"] as const;

export type ConfigTarget = (typeof CONFIG_TARGETS)[number];

export type ConfigReferenceKind = "env" | "secret" | "binding";

export type ConfigReference<
  TKind extends ConfigReferenceKind = ConfigReferenceKind,
  TName extends string = string,
> = Readonly<{
  $type: "hot-updater.config-reference";
  kind: TKind;
  name: TName;
}>;

export type ConfigResolutionContext<
  TBindings extends Record<string, unknown> = Record<string, unknown>,
> = Readonly<{
  target: ConfigTarget;
  environment: Readonly<Record<string, string | undefined>>;
  bindings: Readonly<TBindings>;
}>;

export type ConfigReferenceErrorCode =
  | "invalid-name"
  | "missing"
  | "wrong-target";

export class ConfigReferenceError extends Error {
  override readonly name = "ConfigReferenceError";
  readonly code: ConfigReferenceErrorCode;
  readonly kind: ConfigReferenceKind;
  readonly referenceName: string;

  constructor(
    code: ConfigReferenceErrorCode,
    reference: Readonly<{ kind: ConfigReferenceKind; name: string }>,
  ) {
    super(
      `Configuration reference ${reference.kind}:${reference.name} ${code}`,
    );
    this.code = code;
    this.kind = reference.kind;
    this.referenceName = reference.name;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isConfigTarget(value: unknown): value is ConfigTarget {
  return (
    typeof value === "string" &&
    CONFIG_TARGETS.some((target) => target === value)
  );
}

function assertValidName(kind: ConfigReferenceKind, name: string): void {
  if (!IDENTIFIER_NAME_PATTERN.test(name)) {
    throw new ConfigReferenceError("invalid-name", { kind, name });
  }
}

function createConfigReference<
  TKind extends ConfigReferenceKind,
  TName extends string,
>(kind: TKind, name: TName): ConfigReference<TKind, TName> {
  assertValidName(kind, name);
  return Object.freeze({ $type: CONFIG_REFERENCE_TYPE, kind, name });
}

export const env = <const TName extends string>(
  name: TName,
): ConfigReference<"env", TName> => createConfigReference("env", name);

export const secret = <const TName extends string>(
  name: TName,
): ConfigReference<"secret", TName> => createConfigReference("secret", name);

export const binding = <const TName extends string>(
  name: TName,
): ConfigReference<"binding", TName> => createConfigReference("binding", name);

export function isConfigReference(value: unknown): value is ConfigReference {
  if (!isRecord(value) || !Object.isFrozen(value)) {
    return false;
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "$type" ||
    keys[1] !== "kind" ||
    keys[2] !== "name"
  ) {
    return false;
  }

  const type = descriptors.$type;
  const kind = descriptors.kind;
  const name = descriptors.name;
  if (
    type === undefined ||
    kind === undefined ||
    name === undefined ||
    !("value" in type) ||
    !("value" in kind) ||
    !("value" in name)
  ) {
    return false;
  }

  return (
    type.value === CONFIG_REFERENCE_TYPE &&
    (kind.value === "env" ||
      kind.value === "secret" ||
      kind.value === "binding") &&
    typeof name.value === "string" &&
    IDENTIFIER_NAME_PATTERN.test(name.value)
  );
}

function assertContextInput(input: unknown): asserts input is Readonly<{
  target: ConfigTarget;
  environment: Readonly<Record<string, string | undefined>>;
  bindings: Readonly<Record<string, unknown>>;
}> {
  if (!isRecord(input)) {
    throw new TypeError("Configuration context must be an object");
  }

  if (!isConfigTarget(input.target)) {
    throw new TypeError("Configuration context target is invalid");
  }

  if (!isRecord(input.environment) || !isRecord(input.bindings)) {
    throw new TypeError("Configuration context maps must be objects");
  }

  for (const value of Object.values(input.environment)) {
    if (typeof value !== "string" && value !== undefined) {
      throw new TypeError("Configuration environment values must be strings");
    }
  }
}

export function createStorageOperationContext<
  TBindings extends Record<string, unknown>,
>(
  input: Readonly<{
    target: ConfigTarget;
    environment: Readonly<Record<string, string | undefined>>;
    bindings: Readonly<TBindings>;
  }>,
): ConfigResolutionContext<TBindings> {
  assertContextInput(input);

  return Object.freeze({
    target: input.target,
    environment: Object.freeze({ ...input.environment }),
    bindings: Object.freeze({ ...input.bindings }),
  });
}

function resolveReference(
  reference: ConfigReference,
  context: ConfigResolutionContext,
): unknown {
  switch (reference.kind) {
    case "env":
    case "secret": {
      const value = context.environment[reference.name];
      if (value === undefined) {
        throw new ConfigReferenceError("missing", reference);
      }
      return value;
    }
    case "binding": {
      if (context.target === "node") {
        throw new ConfigReferenceError("wrong-target", reference);
      }
      const value = context.bindings[reference.name];
      if (value === undefined) {
        throw new ConfigReferenceError("missing", reference);
      }
      return value;
    }
  }
}

export function resolveConfigReference<TValue>(
  value: TValue | ConfigReference,
  context: ConfigResolutionContext,
): TValue;
export function resolveConfigReference(
  value: unknown,
  context: ConfigResolutionContext,
): unknown {
  if (!isConfigReference(value)) {
    return value;
  }

  return resolveReference(value, context);
}
