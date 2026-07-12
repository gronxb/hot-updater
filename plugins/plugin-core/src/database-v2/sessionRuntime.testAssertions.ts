import { expect } from "vitest";

export const expectConnectorErrorCode = async (
  action: () => Promise<unknown>,
  code: string,
): Promise<void> => {
  const result = await action().then(
    () => ({ kind: "fulfilled" }) as const,
    (error: unknown) => ({ error, kind: "rejected" }) as const,
  );
  expect(result.kind).toBe("rejected");
  if (result.kind === "fulfilled") {
    return;
  }
  expect(
    typeof result.error === "object" && result.error !== null
      ? Reflect.get(result.error, "code")
      : undefined,
  ).toBe(code);
};
