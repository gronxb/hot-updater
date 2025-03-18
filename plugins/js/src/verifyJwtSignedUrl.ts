import { type JWTPayload, jwtVerify } from "jose";

type SuccessResponse = {
  status: 200;
  responseHeaders?: Record<string, string>;
  responseBody: any;
};

type ErrorResponse = {
  status: 400 | 403 | 404;
  message: string;
};

type VerifyJwtSignedUrlResponse = SuccessResponse | ErrorResponse;

/**
 * Verifies JWT token and handles the logic to retrieve the file from the bucket.
 * This function can be shared and used in various environments such as Cloudflare Workers (Hono) and AWS Lambda.
 *
 * @param {Object} params
 * @param {string} params.path - Request path (e.g., "/1234/bundle.zip")
 * @param {string | undefined} params.token - JWT token passed as a query parameter
 * @param {string} params.jwtSecret - Secret key used for JWT verification
 * @param {object} params.bucket - Storage object to retrieve files from (requires get(key) method)
 * @returns {Promise<VerifyJwtSignedUrlResponse>} - Object containing verification result and file data
 */
export async function verifyJwtSignedUrl({
  path,
  token,
  jwtSecret,
  handler,
}: {
  path: string;
  token: string | undefined;
  jwtSecret: string;
  handler: (key: string) => Promise<any>;
}): Promise<VerifyJwtSignedUrlResponse> {
  const key = path.replace(/^\/+/, "");

  if (!token) {
    return { status: 400, message: "Missing token" };
  }

  let payload: JWTPayload;
  try {
    const secretKey = new TextEncoder().encode(jwtSecret);
    const { payload: verifiedPayload } = await jwtVerify(token, secretKey);
    payload = verifiedPayload;
  } catch (error) {
    return { status: 403, message: "Invalid or expired token" };
  }

  if (!payload || payload.key !== key) {
    return { status: 403, message: "Token does not match requested file" };
  }

  const object = await handler(key);
  if (!object) {
    return { status: 404, message: "File not found" };
  }

  const pathParts = key.split("/");
  const fileName = pathParts[pathParts.length - 1];

  const headers = {
    "Content-Type":
      object.httpMetadata?.contentType || "application/octet-stream",
    "Content-Disposition": `attachment; filename=${fileName}`,
  };

  return { status: 200, responseHeaders: headers, responseBody: object };
}
