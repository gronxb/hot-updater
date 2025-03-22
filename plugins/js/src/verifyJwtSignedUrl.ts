import { jwtVerify } from "jose";

// Common type definitions
export type SuccessResponse = {
  status: 200;
  responseHeaders?: Record<string, string>;
  responseBody: any;
};

export type ErrorResponse = {
  status: 400 | 403 | 404;
  error: string;
};

export type VerifyJwtSignedUrlResponse = SuccessResponse | ErrorResponse;

/**
 * Verifies JWT token only and returns the file key (path with leading slashes removed) if valid.
 */
export const verifyJwtToken = async ({
  path,
  token,
  jwtSecret,
}: {
  path: string;
  token: string | undefined;
  jwtSecret: string;
}): Promise<{ valid: boolean; key?: string; error?: string }> => {
  const key = path.replace(/^\/+/, "");

  if (!token) {
    return { valid: false, error: "Missing token" };
  }

  try {
    const secretKey = new TextEncoder().encode(jwtSecret);
    const { payload } = await jwtVerify(token, secretKey);
    if (!payload || payload.key !== key) {
      return { valid: false, error: "Token does not match requested file" };
    }
    return { valid: true, key };
  } catch (error) {
    return { valid: false, error: "Invalid or expired token" };
  }
};

/**
 * Retrieves file data through the handler and constructs a response object with appropriate headers for download.
 */
const getFileResponse = async ({
  key,
  handler,
}: {
  key: string;
  handler: (key: string) => Promise<{ body: any; contentType?: string } | null>;
}): Promise<VerifyJwtSignedUrlResponse> => {
  const object = await handler(key);
  if (!object) {
    return { status: 404, error: "File not found" };
  }

  const pathParts = key.split("/");
  const fileName = pathParts[pathParts.length - 1];

  const headers = {
    "Content-Type": object.contentType || "application/octet-stream",
    "Content-Disposition": `attachment; filename=${fileName}`,
  };

  return { status: 200, responseHeaders: headers, responseBody: object.body };
};

/**
 * Integrated function for JWT verification and file handling.
 * - Returns error response if token is missing or validation fails.
 * - On success, retrieves file data through the handler and constructs a response object.
 */
export const verifyJwtSignedUrl = async ({
  path,
  token,
  jwtSecret,
  handler,
}: {
  path: string;
  token: string | undefined;
  jwtSecret: string;
  handler: (key: string) => Promise<{ body: any; contentType?: string } | null>;
}): Promise<VerifyJwtSignedUrlResponse> => {
  const result = await verifyJwtToken({ path, token, jwtSecret });
  if (!result.valid) {
    // Return 400 for missing token, 403 for other errors
    if (result.error === "Missing token") {
      return { status: 400, error: result.error };
    }
    return { status: 403, error: result.error || "Unauthorized" };
  }

  return getFileResponse({ key: result.key!, handler });
};
