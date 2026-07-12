export type DatabaseConnectorV2ConformanceCheck =
  | "atomicity"
  | "concurrent-zero-io"
  | "cursor-binding"
  | "happy-read"
  | "lifecycle"
  | "lifecycle-close-wait"
  | "malformed-input"
  | "replay-identity"
  | "scope-isolation"
  | "scope-zero-io"
  | "unknown-recovery";

export class DatabaseConnectorV2ConformanceViolation extends Error {
  override readonly name = "DatabaseConnectorV2ConformanceViolation";

  constructor(
    readonly check: DatabaseConnectorV2ConformanceCheck,
    message: string,
  ) {
    super(message);
  }
}

export function assertDatabaseConnectorV2(
  condition: boolean,
  check: DatabaseConnectorV2ConformanceCheck,
  message: string,
): asserts condition {
  if (!condition) {
    throw new DatabaseConnectorV2ConformanceViolation(check, message);
  }
}

export async function assertDatabaseConnectorV2Error(
  action: () => Promise<unknown>,
  code: string,
  check: DatabaseConnectorV2ConformanceCheck,
): Promise<void> {
  const result = await action().then(
    () => ({ kind: "fulfilled" }) as const,
    (error: unknown) => ({ error, kind: "rejected" }) as const,
  );

  assertDatabaseConnectorV2(
    result.kind === "rejected",
    check,
    `expected ${code}, but the operation fulfilled`,
  );

  const error = result.error;
  const actualCode =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : undefined;

  assertDatabaseConnectorV2(
    actualCode === code,
    check,
    `expected ${code}, received ${String(actualCode)}`,
  );
}
