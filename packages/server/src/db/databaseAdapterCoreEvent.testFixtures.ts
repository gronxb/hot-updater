import {
  databaseAnalyticsSupport,
  type DatabaseAdapter,
} from "@hot-updater/plugin-core";

type TestEventRow = {
  id: string;
  type: "UPDATE_APPLIED" | "RECOVERED";
  install_id: string;
  user_id: string | null;
  username: string | null;
  from_bundle_id: string;
  to_bundle_id: string;
  platform: "ios" | "android";
  app_version: string;
  channel: string;
  cohort: string;
  update_strategy: "fingerprint" | "appVersion";
  fingerprint_hash: string | null;
  sdk_version: string | null;
  received_at_ms: number;
};

export const createBundleEventAdapter = (
  supportsAnalytics = true,
): DatabaseAdapter => {
  const rows: TestEventRow[] = [];
  const matches = (
    row: TestEventRow,
    where: readonly Record<string, unknown>[] | undefined,
  ): boolean => {
    if (!where || where.length === 0) return true;
    const [firstCondition, ...remainingConditions] = where;
    if (!firstCondition) return true;
    const evaluate = (condition: Record<string, unknown>): boolean => {
      const actual = Reflect.get(row, condition.field as string);
      const operator = (condition.operator ?? "eq") as string;
      const expected = condition.value;
      if (
        operator === "contains" &&
        typeof actual === "string" &&
        typeof expected === "string"
      ) {
        return actual.toLowerCase().includes(expected.toLowerCase());
      }
      if (operator === "in" && Array.isArray(expected)) {
        return expected.includes(actual);
      }
      if (
        operator === "gte" &&
        typeof actual === "number" &&
        typeof expected === "number"
      ) {
        return actual >= expected;
      }
      if (
        operator === "lt" &&
        typeof actual === "number" &&
        typeof expected === "number"
      ) {
        return actual < expected;
      }
      return actual === expected;
    };
    let result = evaluate(firstCondition);
    for (const condition of remainingConditions) {
      const current = evaluate(condition);
      result =
        condition.connector === "OR" ? result || current : result && current;
    }
    return result;
  };
  const ordered = (input: {
    where?: readonly Record<string, unknown>[];
    orderBy?: readonly { field: string; direction: "asc" | "desc" }[];
    distinctOn?: { fields: readonly string[] };
    limit: number;
    offset: number;
  }) => {
    let result = rows.filter((row) => matches(row, input.where));
    if (input.orderBy) {
      const orderBy = input.orderBy;
      result = result.toSorted((left, right) => {
        for (const clause of orderBy) {
          const leftValue = Reflect.get(left, clause.field) as
            | string
            | number
            | null;
          const rightValue = Reflect.get(right, clause.field) as
            | string
            | number
            | null;
          const order =
            typeof leftValue === "number" && typeof rightValue === "number"
              ? leftValue - rightValue
              : String(leftValue).localeCompare(String(rightValue));
          if (order !== 0) {
            return clause.direction === "asc" ? order : -order;
          }
        }
        return 0;
      });
    }
    if (input.distinctOn) {
      const seen = new Set<string>();
      result = result.filter((row) => {
        const key = JSON.stringify(
          input.distinctOn?.fields.map((field) => Reflect.get(row, field)),
        );
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    return result.slice(input.offset, input.offset + input.limit);
  };
  return {
    name: "bundle-event-test",
    ...(supportsAnalytics ? { [databaseAnalyticsSupport]: true } : {}),
    create: async (input) => {
      if (input.model === "bundle_events") {
        rows.push(input.data as TestEventRow);
        return input.data as never;
      }
      throw new Error("unused");
    },
    update: async () => {
      throw new Error("unused");
    },
    delete: async () => {
      throw new Error("unused");
    },
    count: async (input) => {
      if (input.model !== "bundle_events") throw new Error("unused");
      const filtered = rows.filter((row) =>
        matches(
          row,
          input.where as readonly Record<string, unknown>[] | undefined,
        ),
      );
      if (!input.distinct) return filtered.length;
      return new Set(
        filtered.map((row) =>
          JSON.stringify(
            input.distinct?.map((field) => Reflect.get(row, field)),
          ),
        ),
      ).size;
    },
    findOne: async () => null,
    findMany: async (input) => {
      if (input.model !== "bundle_events") return [] as never[];
      return ordered({
        where: input.where as readonly Record<string, unknown>[] | undefined,
        orderBy: input.orderBy as
          | readonly { field: string; direction: "asc" | "desc" }[]
          | undefined,
        distinctOn: input.distinctOn as
          | { fields: readonly string[] }
          | undefined,
        limit: input.limit ?? 100,
        offset: input.offset ?? 0,
      }) as never[];
    },
  } as DatabaseAdapter;
};
