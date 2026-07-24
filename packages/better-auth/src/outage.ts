const isObjectLike = (
  value: unknown,
): value is object | ((...args: never[]) => unknown) =>
  (typeof value === "object" && value !== null) || typeof value === "function";

export const isUnavailableError = (error: unknown): boolean => {
  if (!isObjectLike(error)) return false;

  try {
    const status = Reflect.get(error, "status");
    return (
      status === 503 ||
      status === "SERVICE_UNAVAILABLE" ||
      Reflect.get(error, "statusCode") === 503
    );
  } catch {
    return false;
  }
};
