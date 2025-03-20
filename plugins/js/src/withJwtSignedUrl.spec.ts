import { NIL_UUID } from "@hot-updater/core";
import { describe, expect, it } from "vitest";
import { withJwtSignedUrl } from "./withJwtSignedUrl";

describe("withJwtSignedUrl", () => {
  const jwtSecret = "test-secret";
  const reqUrl = "https://example.com/api";

  it("should return null when data is null", async () => {
    const result = await withJwtSignedUrl({
      data: null,
      reqUrl,
      jwtSecret,
    });
    expect(result).toBeNull();
  });

  it("should return data with fileUrl set to null when id is NIL_UUID", async () => {
    const data = {
      id: NIL_UUID,
      someProperty: "value",
    };

    const result = await withJwtSignedUrl({
      data,
      reqUrl,
      jwtSecret,
    });

    expect(result).not.toBeNull();
    expect(result?.fileUrl).toBeNull();
    expect(result?.id).toBe(NIL_UUID);
    expect(result?.someProperty).toBe("value");
  });

  it("should generate a JWT signed URL when data is valid", async () => {
    const data = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      someProperty: "value",
    };

    const result = await withJwtSignedUrl({
      data,
      reqUrl,
      jwtSecret,
    });

    expect(result).not.toBeNull();
    expect(result?.fileUrl).toBeTypeOf("string");
    expect(result?.fileUrl).toContain(`/${data.id}/bundle.zip`);
    expect(result?.fileUrl).toContain("token=");

    const url = new URL(result?.fileUrl as string);
    expect(url.origin).toBe("https://example.com");
    expect(url.pathname).toBe(`/${data.id}/bundle.zip`);
    expect(url.searchParams.has("token")).toBe(true);
    expect(result?.someProperty).toBe("value");
  });
});
