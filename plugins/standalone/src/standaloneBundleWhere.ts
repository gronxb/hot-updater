import type { DatabaseWhere } from "@hot-updater/plugin-core/internal";

export const appendBundleWhere = (
  url: URL,
  where: readonly DatabaseWhere<"bundles">[] | undefined,
): boolean => {
  const usedParameters = new Set<string>();
  const setParameter = (parameter: string, value: string): boolean => {
    if (usedParameters.has(parameter)) return false;
    usedParameters.add(parameter);
    url.searchParams.set(parameter, value);
    return true;
  };
  const appendParameter = (parameter: string, values: readonly string[]) => {
    if (values.length === 0 || usedParameters.has(parameter)) return false;
    usedParameters.add(parameter);
    for (const value of values) url.searchParams.append(parameter, value);
    return true;
  };

  for (const [index, condition] of (where ?? []).entries()) {
    if (index > 0 && condition.connector === "OR") return false;
    const operator = condition.operator ?? "eq";
    switch (condition.field) {
      case "platform":
        if (operator !== "eq" || typeof condition.value !== "string") {
          return false;
        }
        if (!setParameter("platform", condition.value)) return false;
        break;
      case "id": {
        let parameter: string | undefined;
        switch (operator) {
          case "eq":
            parameter = "idEq";
            break;
          case "gt":
            parameter = "idGt";
            break;
          case "gte":
            parameter = "idGte";
            break;
          case "lt":
            parameter = "idLt";
            break;
          case "lte":
            parameter = "idLte";
            break;
        }
        if (parameter && typeof condition.value === "string") {
          if (!setParameter(parameter, condition.value)) return false;
          break;
        }
        if (operator === "in" && Array.isArray(condition.value)) {
          if (!condition.value.every((value) => typeof value === "string")) {
            return false;
          }
          if (!appendParameter("idIn", condition.value)) return false;
          break;
        }
        return false;
      }
      default:
        return false;
    }
  }
  return true;
};
