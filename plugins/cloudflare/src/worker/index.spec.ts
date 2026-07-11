import { describe, expect, expectTypeOf, it } from "vitest";

import {
  type CloudflareWorkerDatabaseEnv,
  type CloudflareWorkerStorageEnv,
  d1Database,
  r2Storage,
  type RequestEnvContext,
} from "./index";

type D1OnlyContext = RequestEnvContext<CloudflareWorkerDatabaseEnv>;
type R2OnlyContext = RequestEnvContext<CloudflareWorkerStorageEnv>;

describe("Cloudflare Worker helper context types", () => {
  it("accepts a D1-only environment for d1Database", () => {
    // Given / When
    const openDatabase = d1Database();

    // Then
    expect(openDatabase).toBeTypeOf("function");
    expectTypeOf(openDatabase)
      .parameter(0)
      .toEqualTypeOf<D1OnlyContext | undefined>();
  });

  it("accepts an R2-only environment for r2Storage", () => {
    // Given / When
    const openStorage = r2Storage({
      publicBaseUrl: "https://cdn.example.com",
    });
    const storage = openStorage();

    // Then
    expect(openStorage).toBeTypeOf("function");
    expectTypeOf(storage.profiles.runtime.getDownloadUrl)
      .parameter(0)
      .toEqualTypeOf<string>();
    expectTypeOf(storage.profiles.runtime.getDownloadUrl)
      .parameter(1)
      .toEqualTypeOf<R2OnlyContext | undefined>();
  });
});
