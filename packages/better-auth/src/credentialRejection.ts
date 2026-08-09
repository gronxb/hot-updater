const isObjectLike = (
  value: unknown,
): value is object | ((...args: never[]) => unknown) =>
  (typeof value === "object" && value !== null) || typeof value === "function";

export const isCredentialRejectionError = (error: unknown): boolean => {
  if (!isObjectLike(error)) return false;

  try {
    const status = Reflect.get(error, "status");
    return (
      status === 401 ||
      status === 403 ||
      status === "UNAUTHORIZED" ||
      status === "FORBIDDEN" ||
      Reflect.get(error, "statusCode") === 401 ||
      Reflect.get(error, "statusCode") === 403
    );
  } catch {
    return false;
  }
};
