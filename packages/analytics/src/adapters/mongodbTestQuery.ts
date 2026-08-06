import type {
  MongoAnalyticsCursor,
  MongoAnalyticsDocument,
} from "./mongodbTypes";

const matchesCondition = (value: unknown, condition: unknown): boolean => {
  if (typeof condition !== "object" || condition === null) {
    return value === condition;
  }
  const lower = Reflect.get(condition, "$gt");
  if (lower !== undefined) {
    return (
      (typeof value === "number" &&
        typeof lower === "number" &&
        value > lower) ||
      (typeof value === "string" && typeof lower === "string" && value > lower)
    );
  }
  const upper = Reflect.get(condition, "$lt");
  return (
    (typeof value === "number" && typeof upper === "number" && value < upper) ||
    (typeof value === "string" && typeof upper === "string" && value < upper)
  );
};

export const matchesMongoAnalyticsDocument = (
  document: MongoAnalyticsDocument,
  filter: MongoAnalyticsDocument,
): boolean =>
  Object.entries(filter).every(([key, condition]) => {
    if (key === "$and") {
      return (
        Array.isArray(condition) &&
        condition.every(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            matchesMongoAnalyticsDocument(document, item),
        )
      );
    }
    if (key === "$or") {
      return (
        Array.isArray(condition) &&
        condition.some(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            matchesMongoAnalyticsDocument(document, item),
        )
      );
    }
    return matchesCondition(Reflect.get(document, key), condition);
  });

const compare = (left: unknown, right: unknown): number => {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return 0;
};

export class MongoAnalyticsHarnessCursor implements MongoAnalyticsCursor {
  private maximum = Number.POSITIVE_INFINITY;
  private sortSpecification: MongoAnalyticsDocument | null = null;

  constructor(private readonly documents: readonly MongoAnalyticsDocument[]) {}

  get limitValue(): number {
    return this.maximum;
  }

  get sortValue(): MongoAnalyticsDocument | null {
    return this.sortSpecification;
  }

  limit(value: number): this {
    this.maximum = value;
    return this;
  }

  sort(value: MongoAnalyticsDocument): this {
    this.sortSpecification = value;
    return this;
  }

  async toArray(): Promise<readonly MongoAnalyticsDocument[]> {
    const rows = [...this.documents];
    if (this.sortSpecification !== null) {
      rows.sort((left, right) => {
        for (const [field, direction] of Object.entries(
          this.sortSpecification ?? {},
        )) {
          const result = compare(
            Reflect.get(left, field),
            Reflect.get(right, field),
          );
          if (result !== 0) return result * Number(direction);
        }
        return 0;
      });
    }
    return structuredClone(rows.slice(0, this.maximum));
  }
}
