const MANAGED_RESOURCE_ENGINE_ERROR =
  /\bengine-error\b[^\r\n]*\bcode=(301|302)\b/g;

export function findManagedResourceEngineErrorCodes(logs: string): number[] {
  return [...logs.matchAll(MANAGED_RESOURCE_ENGINE_ERROR)].map((match) =>
    Number(match[1]),
  );
}

export function assertNoManagedResourceEngineErrors(logs: string): void {
  const codes = findManagedResourceEngineErrorCodes(logs);
  if (codes.length > 0) {
    throw new Error(
      `Managed Lynx resources emitted engine errors: ${codes.join(", ")}`,
    );
  }
}
