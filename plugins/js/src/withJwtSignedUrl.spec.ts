import { NIL_UUID, type UpdateInfo } from "@hot-updater/core";
import { describe, expect, it } from "vitest";
import { withJwtSignedUrl } from "./withJwtSignedUrl";

describe("withJwtSignedUrl", () => {
  const jwtSecret = "test-secret";
  const reqUrl = "https://example.com/api";

  it("should return null when updateInfo is null", async () => {
    const result = await withJwtSignedUrl(null, reqUrl, jwtSecret);
    expect(result).toBeNull();
  });

  it("should return updateInfo with fileUrl set to null when id is NIL_UUID", async () => {
    const updateInfo: UpdateInfo = {
      id: NIL_UUID,
      shouldForceUpdate: false,
      message: null,
      status: "UPDATE",
    };

    const result = await withJwtSignedUrl(updateInfo, reqUrl, jwtSecret);

    expect(result).not.toBeNull();
    expect(result?.fileUrl).toBeNull();
    expect(result?.id).toBe(NIL_UUID);
  });

  it("should generate a JWT signed URL when updateInfo is valid", async () => {
    const updateInfo: UpdateInfo = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      shouldForceUpdate: false,
      message: null,
      status: "UPDATE",
    };

    const result = await withJwtSignedUrl(updateInfo, reqUrl, jwtSecret);

    expect(result).not.toBeNull();
    expect(result?.fileUrl).toBeTypeOf("string");
    expect(result?.fileUrl).toContain(`/${updateInfo.id}/bundle.zip`);
    expect(result?.fileUrl).toContain("token=");

    const url = new URL(result?.fileUrl as string);
    expect(url.origin).toBe("https://example.com");
    expect(url.pathname).toBe(`/${updateInfo.id}/bundle.zip`);
    expect(url.searchParams.has("token")).toBe(true);
  });

  it("should verify that null is returned when updateInfo is null", async () => {
    const result = await withJwtSignedUrl(null, reqUrl, jwtSecret);
    expect(result).toBeNull();
  });

  it("should verify that fileUrl is null when id is NIL_UUID", async () => {
    const updateInfo: UpdateInfo = {
      id: NIL_UUID,
      shouldForceUpdate: false,
      message: null,
      status: "ROLLBACK",
    };

    const result = await withJwtSignedUrl(updateInfo, reqUrl, jwtSecret);

    expect(result).not.toBeNull();
    expect(result?.fileUrl).toBeNull();
    expect(result?.id).toBe(NIL_UUID);
    expect(result?.shouldForceUpdate).toBe(false);
    expect(result?.status).toBe("ROLLBACK");
  });
});
