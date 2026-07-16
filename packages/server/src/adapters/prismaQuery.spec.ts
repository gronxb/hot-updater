import { describe, expect, it } from "vitest";

import { createPrismaWhere } from "./prismaQuery";

describe("createPrismaWhere", () => {
  it.each(["sqlite", "mysql"] as const)(
    "keeps every identity OR predicate without mode for %s",
    (provider) => {
      // Given
      const identityWhere = [
        {
          field: "username",
          operator: "contains",
          value: "alice",
          mode: "insensitive",
        },
        {
          field: "user_id",
          operator: "contains",
          value: "alice",
          mode: "insensitive",
          connector: "OR",
        },
        {
          field: "install_id",
          operator: "contains",
          value: "alice",
          mode: "insensitive",
          connector: "OR",
        },
      ] as const;

      // When
      const result = createPrismaWhere(identityWhere, provider);

      // Then
      expect(result).toEqual({
        OR: [
          {
            OR: [
              { username: { contains: "alice" } },
              { user_id: { contains: "alice" } },
            ],
          },
          { install_id: { contains: "alice" } },
        ],
      });
    },
  );

  it.each(["postgresql", "mongodb", "cockroachdb"] as const)(
    "preserves insensitive string mode for %s",
    (provider) => {
      // Given
      const where = [
        {
          field: "username",
          operator: "contains",
          value: "alice",
          mode: "insensitive",
        },
      ] as const;

      // When
      const result = createPrismaWhere(where, provider);

      // Then
      expect(result).toEqual({
        username: { contains: "alice", mode: "insensitive" },
      });
    },
  );
});
