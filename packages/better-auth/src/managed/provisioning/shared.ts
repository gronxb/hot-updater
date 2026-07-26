export const HOT_UPDATER_API_KEY_ENV_NAME = "HOT_UPDATER_API_KEY";

export type ProvisionManagedBetterAuthApiKeyOptions = {
  readonly envFilePath?: string;
};

export type ProvisionedManagedBetterAuthApiKey = {
  readonly apiKey: string;
  readonly sha256: string;
};

export class ManagedBetterAuthProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedBetterAuthProvisioningError";
  }
}

export const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  Reflect.get(error, "code") === code;

export type AsyncOutcome<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ error: unknown; ok: false }>;

export const captureOutcome = async <Value>(
  operation: () => Promise<Value>,
): Promise<AsyncOutcome<Value>> => {
  try {
    return Object.freeze({ ok: true, value: await operation() });
  } catch (error) {
    return Object.freeze({ error, ok: false });
  }
};

export const captureFailure = async (
  operation: () => Promise<void>,
): Promise<unknown | undefined> => {
  const outcome = await captureOutcome(operation);
  return outcome.ok ? undefined : outcome.error;
};

export const collectFailures = async (
  operations: ReadonlyArray<() => Promise<void>>,
): Promise<readonly unknown[]> => {
  const failures: unknown[] = [];
  for (const operation of operations) {
    const failure = await captureFailure(operation);
    if (failure !== undefined) failures.push(failure);
  }
  return Object.freeze(failures);
};

export const combineFailure = (
  primary: unknown,
  cleanupFailures: readonly unknown[],
): unknown => {
  if (cleanupFailures.length === 0) return primary;
  const message =
    primary instanceof Error
      ? primary.message
      : "Managed API-key provisioning failed.";
  return new AggregateError([primary, ...cleanupFailures], message, {
    cause: primary,
  });
};

export const finishOutcome = <Value>(
  outcome: AsyncOutcome<Value>,
  cleanupFailures: readonly unknown[],
  cleanupMessage: string,
): Value => {
  if (!outcome.ok) throw combineFailure(outcome.error, cleanupFailures);
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, cleanupMessage, {
      cause: cleanupFailures[0],
    });
  }
  return outcome.value;
};
