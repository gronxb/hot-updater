import { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { D1RestDialect } from "./d1RestDialect";

type TestDatabase = {
  readonly primitive_values: {
    readonly boolean_value: boolean;
    readonly nullable_value: string | null;
    readonly number_value: number;
    readonly text_value: string;
  };
};

describe("D1RestDialect parameter compilation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("binds only strings and emits primitive values as safe SQL literals", async () => {
    // Given
    const requests: Request[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(
        JSON.stringify({
          errors: [],
          messages: [],
          result: [
            {
              meta: { changes: 1, last_row_id: 1 },
              results: [],
              success: true,
            },
          ],
          success: true,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const db = new Kysely<TestDatabase>({
      dialect: new D1RestDialect({
        accountId: "account-id",
        cloudflareApiToken: "api-token",
        databaseId: "database-id",
      }),
    });
    const textValue = "value'); drop table primitive_values; --";

    // When
    await db
      .insertInto("primitive_values")
      .values({
        boolean_value: true,
        nullable_value: null,
        number_value: 42,
        text_value: textValue,
      })
      .execute();

    // Then
    expect(requests).toHaveLength(1);
    await expect(requests[0]?.json()).resolves.toEqual({
      params: [textValue],
      sql: 'insert into "primitive_values" ("boolean_value", "nullable_value", "number_value", "text_value") values (true, null, 42, ?)',
    });
    await db.destroy();
  });
});
