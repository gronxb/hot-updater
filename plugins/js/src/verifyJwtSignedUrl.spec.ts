import { jwtVerify } from "jose";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyJwtSignedUrl } from "./verifyJwtSignedUrl";

vi.mock("jose", () => ({
  jwtVerify: vi.fn(),
}));

describe("verifyJwtSignedUrl", () => {
  const mockedJwtVerify = vi.mocked(jwtVerify);
  const createJwtVerifyResult = (key: string) => ({
    payload: { key },
    protectedHeader: { alg: "HS256" },
    key: new Uint8Array(),
  });
  const mockJwtSecret = "test-secret";
  const mockPath = "/test-file.zip";
  const mockToken = "mock-token";
  const mockKey = "test-file.zip";

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should return 400 if token is missing", async () => {
    const result = await verifyJwtSignedUrl({
      path: mockPath,
      token: undefined,
      jwtSecret: mockJwtSecret,
      handler: vi.fn(),
    });

    expect(result).toEqual({
      status: 400,
      error: "Missing token",
    });
  });

  it("should return 403 if token verification fails", async () => {
    mockedJwtVerify.mockRejectedValue(new Error("Invalid token"));

    const result = await verifyJwtSignedUrl({
      path: mockPath,
      token: mockToken,
      jwtSecret: mockJwtSecret,
      handler: vi.fn(),
    });

    expect(result).toEqual({
      status: 403,
      error: "Invalid or expired token",
    });
  });

  it("should return 403 if payload key doesn't match requested file", async () => {
    mockedJwtVerify.mockResolvedValue(
      createJwtVerifyResult("different-file.zip"),
    );

    const result = await verifyJwtSignedUrl({
      path: mockPath,
      token: mockToken,
      jwtSecret: mockJwtSecret,
      handler: vi.fn(),
    });

    expect(result).toEqual({
      status: 403,
      error: "Token does not match requested file",
    });
  });

  it("should return 404 if file is not found", async () => {
    mockedJwtVerify.mockResolvedValue(createJwtVerifyResult(mockKey));
    const mockHandler = vi.fn().mockResolvedValue(null);

    const result = await verifyJwtSignedUrl({
      path: mockPath,
      token: mockToken,
      jwtSecret: mockJwtSecret,
      handler: mockHandler,
    });

    expect(mockHandler).toHaveBeenCalledWith(mockKey);
    expect(result).toEqual({
      status: 404,
      error: "File not found",
    });
  });

  it("should return 200 with file data if verification succeeds", async () => {
    mockedJwtVerify.mockResolvedValue(createJwtVerifyResult(mockKey));

    const mockObject = {
      contentType: "application/zip",
      body: "file-content",
    };

    const mockHandler = vi.fn().mockResolvedValue(mockObject);

    const result = await verifyJwtSignedUrl({
      path: mockPath,
      token: mockToken,
      jwtSecret: mockJwtSecret,
      handler: mockHandler,
    });

    expect(mockHandler).toHaveBeenCalledWith(mockKey);
    expect(result).toEqual({
      status: 200,
      responseHeaders: {
        "Content-Type": "application/zip",
        "Content-Disposition": "attachment; filename=test-file.zip",
      },
      responseBody: "file-content",
    });
  });

  it("should use default content type if not provided", async () => {
    mockedJwtVerify.mockResolvedValue(createJwtVerifyResult(mockKey));

    const mockObject = {
      body: "file-content",
    };
    const mockHandler = vi.fn().mockResolvedValue(mockObject);

    const result = await verifyJwtSignedUrl({
      path: mockPath,
      token: mockToken,
      jwtSecret: mockJwtSecret,
      handler: mockHandler,
    });

    expect(result.status).toBe(200);
    assert(result.status === 200);

    expect(result.responseHeaders).toEqual({
      "Content-Type": "application/octet-stream",
      "Content-Disposition": "attachment; filename=test-file.zip",
    });
  });
});
