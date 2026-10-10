const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const hmac = async (key: BufferSource, value: string) =>
  crypto.subtle.sign(
    "HMAC",
    await crypto.subtle.importKey(
      "raw",
      key,
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"],
    ),
    encoder.encode(value),
  );

/** RFC 3986 encoding, which S3 signs keys and query values in. */
const encodeRfc3986 = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** R2's S3-compatible credentials. */
export interface R2Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * A presigned GET URL for an object on R2's S3-compatible API: AWS Signature
 * Version 4 on Web Crypto, in the form `getSignedUrl` from
 * `@aws-sdk/s3-request-presigner` signs, so a Worker presigns without the
 * AWS SDK.
 */
export const presignR2GetUrl = async ({
  accountId,
  bucketName,
  credentials,
  expiresInSeconds,
  key,
  signingDate = new Date(),
}: {
  readonly accountId: string;
  readonly bucketName: string;
  readonly credentials: R2Credentials;
  readonly expiresInSeconds: number;
  /** The object's key, unencoded. */
  readonly key: string;
  readonly signingDate?: Date;
}): Promise<string> => {
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const path = `/${bucketName}/${key.split("/").map(encodeRfc3986).join("/")}`;
  const amzDate = signingDate.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const scope = `${amzDate.slice(0, 8)}/auto/s3/aws4_request`;
  // Sorted by name, as the canonical request orders them.
  const query: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD"],
    ["X-Amz-Credential", `${credentials.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expiresInSeconds)],
    ["X-Amz-SignedHeaders", "host"],
    ["x-id", "GetObject"],
  ];
  const queryString = (entries: [string, string][]) =>
    entries
      .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
      .join("&");
  const canonicalRequest = [
    "GET",
    path,
    queryString(query),
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    hex(
      await crypto.subtle.digest("SHA-256", encoder.encode(canonicalRequest)),
    ),
  ].join("\n");
  let signingKey: ArrayBuffer = encoder.encode(
    `AWS4${credentials.secretAccessKey}`,
  ).buffer as ArrayBuffer;
  for (const part of [amzDate.slice(0, 8), "auto", "s3", "aws4_request"]) {
    signingKey = await hmac(signingKey, part);
  }
  const signature = hex(await hmac(signingKey, stringToSign));
  const signed: [string, string][] = [
    ...query.slice(0, 5),
    ["X-Amz-Signature", signature],
    ...query.slice(5),
  ];
  return `https://${host}${path}?${queryString(signed)}`;
};
