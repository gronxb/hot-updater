import { DatabaseConnectorErrorV2 } from "./errors";

interface CapturedDatabaseScopeV2 {
  readonly tenantId: string;
  readonly principalId: string;
  readonly context: unknown;
}

const invalidScope = (message: string, cause?: unknown): never => {
  throw new DatabaseConnectorErrorV2(
    "INVALID_SCOPE",
    message,
    cause === undefined ? undefined : { cause },
  );
};

const requireDataDescriptor = (
  descriptors: Record<string, PropertyDescriptor>,
  key: string,
): PropertyDescriptor => {
  const descriptor = Reflect.get(descriptors, key);
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    Object.hasOwn(descriptor, "get") ||
    Object.hasOwn(descriptor, "set") ||
    !Object.hasOwn(descriptor, "value")
  ) {
    return invalidScope(`scope ${key} must be an enumerable data property`);
  }
  return descriptor;
};

const requireIdentifier = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalidScope(`${label} must be a non-empty asserted string`);
  }
  return value;
};

const captureScope = (scope: unknown): CapturedDatabaseScopeV2 => {
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
    return invalidScope("asserted scope must be a plain object");
  }
  if (Object.getPrototypeOf(scope) !== Object.prototype) {
    return invalidScope("asserted scope must have a plain object prototype");
  }
  if (Object.getOwnPropertySymbols(scope).length > 0) {
    return invalidScope("asserted scope must not contain symbol properties");
  }
  const descriptors = Object.getOwnPropertyDescriptors(scope);
  const keys = Object.keys(descriptors);
  const expectedKeys = ["tenantId", "principalId", "context"];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => !expectedKeys.includes(key))
  ) {
    return invalidScope("asserted scope has an invalid shape");
  }
  const tenant = requireDataDescriptor(descriptors, "tenantId");
  const principal = requireDataDescriptor(descriptors, "principalId");
  const context = requireDataDescriptor(descriptors, "context");
  return Object.freeze({
    tenantId: requireIdentifier(tenant.value, "tenantId"),
    principalId: requireIdentifier(principal.value, "principalId"),
    context: context.value,
  });
};

export const captureDatabaseScopeV2 = (
  scope: unknown,
): CapturedDatabaseScopeV2 => {
  try {
    return captureScope(scope);
  } catch (error) {
    if (error instanceof DatabaseConnectorErrorV2) {
      throw error;
    }
    if (error instanceof Error) {
      return invalidScope(
        "asserted scope could not be inspected safely",
        error,
      );
    }
    return invalidScope("scope inspection threw a non-error value", error);
  }
};
