export const exactDynamoDBId = (
  where: readonly object[] | undefined,
): string | undefined => {
  if (where?.length !== 1) return undefined;
  const condition = where[0];
  if (
    Reflect.get(condition, "field") !== "id" ||
    (Reflect.get(condition, "operator") ?? "eq") !== "eq" ||
    Reflect.get(condition, "mode") === "insensitive"
  ) {
    return undefined;
  }
  const value = Reflect.get(condition, "value");
  return typeof value === "string" ? value : undefined;
};

export const exactDynamoDBPatchOwner = (
  where: readonly object[] | undefined,
): string | undefined => {
  const owners = exactDynamoDBPatchOwners(where);
  return owners?.length === 1 ? owners[0] : undefined;
};

export const exactDynamoDBPatchOwners = (
  where: readonly object[] | undefined,
): readonly string[] | undefined => {
  if (
    !where ||
    where.some((condition) => Reflect.get(condition, "connector") === "OR")
  ) {
    return undefined;
  }
  const ownerConditions = where.filter(
    (condition) => Reflect.get(condition, "field") === "bundle_id",
  );
  if (ownerConditions.length !== 1) return undefined;
  const condition = ownerConditions[0];
  if (Reflect.get(condition, "mode") === "insensitive") {
    return undefined;
  }
  const operator = Reflect.get(condition, "operator") ?? "eq";
  const value = Reflect.get(condition, "value");
  if (operator === "eq") {
    return typeof value === "string" ? [value] : undefined;
  }
  if (
    operator === "in" &&
    Array.isArray(value) &&
    value.every((id) => typeof id === "string")
  ) {
    return value;
  }
  return undefined;
};

export const exactDynamoDBBundleIds = (
  where: readonly object[] | undefined,
): readonly string[] | undefined => {
  if (where?.length !== 1) return undefined;
  const condition = where[0];
  if (
    Reflect.get(condition, "field") !== "id" ||
    Reflect.get(condition, "mode") === "insensitive"
  ) {
    return undefined;
  }
  const operator = Reflect.get(condition, "operator") ?? "eq";
  const value = Reflect.get(condition, "value");
  if (operator === "eq" && typeof value === "string") return [value];
  if (
    operator === "in" &&
    Array.isArray(value) &&
    value.every((id) => typeof id === "string")
  ) {
    return value;
  }
  return undefined;
};

export const dynamoDBBundlePageStart = (
  where: readonly object[] | undefined,
  direction: "asc" | "desc",
): { readonly id: string; readonly inclusive: boolean } | undefined => {
  if (
    (where ?? []).some(
      (condition) => Reflect.get(condition, "connector") === "OR",
    )
  ) {
    return undefined;
  }
  let result: { readonly id: string; readonly inclusive: boolean } | undefined;
  for (const condition of where ?? []) {
    if (Reflect.get(condition, "field") !== "id") continue;
    const operator = Reflect.get(condition, "operator") ?? "eq";
    const value = Reflect.get(condition, "value");
    const eligible =
      direction === "asc"
        ? operator === "gt" || operator === "gte"
        : operator === "lt" || operator === "lte";
    if (!eligible || typeof value !== "string") continue;
    const inclusive = operator === "gte" || operator === "lte";
    if (
      result === undefined ||
      (direction === "asc" ? value > result.id : value < result.id) ||
      (value === result.id && !inclusive)
    ) {
      result = { id: value, inclusive };
    }
  }
  return result;
};
