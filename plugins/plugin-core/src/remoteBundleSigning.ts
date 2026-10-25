import type { BundleSigningAdapter } from "./types";

export const REMOTE_BUNDLE_SIGNING_PATH = "/_hot-updater/signing";
export const REMOTE_BUNDLE_SIGNING_PROTOCOL_VERSION = 1 as const;
export const REMOTE_BUNDLE_SIGNING_ALGORITHM = "RSA-SHA256" as const;
export const REMOTE_BUNDLE_SIGNING_TOKEN_HEADER = "x-hot-updater-signing-token";

const MESSAGE_BYTES = 32;
const REQUEST_BODY_LIMIT = 4 * 1024;
const RESPONSE_BODY_LIMIT = 32 * 1024;
const SIGNATURE_BYTES_LIMIT = 16 * 1024;
const TOKEN_BYTES_LIMIT = 4 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const JSON_CONTENT_TYPE_PATTERN = /^application\/json(?:\s*;|$)/iu;
const BASE64_PATTERN =
  /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u;
const PUBLIC_KEY_PATTERN =
  /^-----BEGIN PUBLIC KEY-----\s+([A-Za-z\d+/=\s]+)\s+-----END PUBLIC KEY-----$/u;

/**
 * The name of the errors `remoteSigning` throws with a reason it wrote itself,
 * which never holds the token or what an upstream library threw. The CLI
 * shows these, and redacts any other signing adapter error, by this name.
 */
const REMOTE_SIGNING_ERROR_NAME = "HotUpdaterRemoteSigningError";
const ERROR_RESPONSE_BODY_LIMIT = 4 * 1024;
const ERROR_MESSAGE_LENGTH_LIMIT = 300;
const MISSING_TOKEN_MESSAGE =
  "remoteSigning requires signingToken or HOT_UPDATER_SIGNING_TOKEN.";

/** A failure whose reason is safe to show: it names no secret. */
class RemoteSigningFailure extends Error {}

const remoteSigningError = (summary: string, error?: unknown) => {
  if (!(error instanceof RemoteSigningFailure)) return new Error(summary);
  const named = new Error(`${summary} ${error.message}`);
  named.name = REMOTE_SIGNING_ERROR_NAME;
  return named;
};

type Fetch = typeof globalThis.fetch;
type WebCryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
type HeadersInitializer = ConstructorParameters<typeof Headers>[0];

type RemoteMetadata = Readonly<{
  algorithm: typeof REMOTE_BUNDLE_SIGNING_ALGORITHM;
  keyId: string;
  protocolVersion: typeof REMOTE_BUNDLE_SIGNING_PROTOCOL_VERSION;
  publicKey: string;
}>;

type ResolvedPublicKey = Readonly<{
  cryptoKey: WebCryptoKey;
  keyId: string;
  publicKey: string;
}>;

export interface RemoteSigningOptions {
  readonly endpoint: string;
  readonly fetch?: Fetch;
  /**
   * Dedicated signing token or a lazy resolver for provider integrations.
   * Defaults to HOT_UPDATER_SIGNING_TOKEN.
   */
  readonly signingToken?: string | (() => string | Promise<string>);
}

export interface BundleSigningHandlerOptions {
  /** Exact request pathname. Defaults to the root managed signing path. */
  readonly endpointPath?: string;
  /**
   * The SPKI public key in PEM, or a function that returns it, called only
   * once the token is accepted, such as for a key chosen by the token.
   */
  readonly publicKey: string | (() => string | Promise<string>);
  readonly request: Request;
  readonly sign: (message: Uint8Array) => Uint8Array | Promise<Uint8Array>;
  /**
   * The dedicated signing token, or a function that accepts or refuses the
   * token a request presents, such as one that looks it up in a store.
   */
  readonly token: string | ((presented: string) => boolean | Promise<boolean>);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
) => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
};

const bytesToBase64 = (value: Uint8Array) => {
  let binary = "";
  for (let offset = 0; offset < value.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array | null => {
  if (!value || !BASE64_PATTERN.test(value)) return null;

  try {
    const binary = atob(value);
    const result = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return bytesToBase64(result) === value ? result : null;
  } catch {
    return null;
  }
};

const bytesToHex = (value: Uint8Array) =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

const toArrayBuffer = (value: Uint8Array): ArrayBuffer =>
  new Uint8Array(value).buffer;

const canonicalizePublicKey = async (
  publicKey: string,
): Promise<ResolvedPublicKey> => {
  const match = PUBLIC_KEY_PATTERN.exec(publicKey.trim());
  const der = match?.[1]
    ? base64ToBytes(match[1].replaceAll(/\s/gu, ""))
    : null;
  if (!der) {
    throw new Error("invalid public key");
  }

  const cryptoKey = await crypto.subtle.importKey(
    "spki",
    toArrayBuffer(der),
    { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
    true,
    ["verify"],
  );
  const modulusLength = Reflect.get(cryptoKey.algorithm, "modulusLength");
  if (![2048, 3072, 4096].includes(modulusLength)) {
    throw new Error("unsupported public key");
  }
  const canonicalDer = new Uint8Array(
    await crypto.subtle.exportKey("spki", cryptoKey),
  );
  const encoded = bytesToBase64(canonicalDer);
  const lines = encoded.match(/.{1,64}/gu) ?? [];
  const keyId = bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", canonicalDer)),
  );

  return {
    cryptoKey,
    keyId,
    publicKey: `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`,
  };
};

const assertSafePath = (path: string) => {
  if (!path.startsWith("/") || path.includes("\\") || path.includes("//")) {
    throw new Error("invalid path");
  }
  for (const segment of path.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error("invalid path");
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0")
    ) {
      throw new Error("invalid path");
    }
  }
};

const invalidEndpoint = () => {
  const error = new Error("Remote bundle signing requires a valid endpoint.");
  error.name = REMOTE_SIGNING_ERROR_NAME;
  return error;
};

const normalizeEndpoint = (endpoint: string) => {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw invalidEndpoint();
  }

  const rawPath = /^https?:\/\/[^/?#]*(\/[^?#]*)?/iu.exec(endpoint)?.[1] ?? "/";
  try {
    assertSafePath(rawPath);
  } catch {
    throw invalidEndpoint();
  }
  const isLoopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw invalidEndpoint();
  }

  const prefix = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${prefix}${REMOTE_BUNDLE_SIGNING_PATH}`;
  return url.href;
};

const normalizeHandlerPath = (endpointPath: string) => {
  try {
    assertSafePath(endpointPath);
    const url = new URL(endpointPath, "https://hot-updater.invalid");
    if (
      url.origin !== "https://hot-updater.invalid" ||
      url.search ||
      url.hash ||
      url.pathname !== endpointPath ||
      !endpointPath.endsWith(REMOTE_BUNDLE_SIGNING_PATH)
    ) {
      throw new Error("invalid path");
    }
    return endpointPath;
  } catch {
    throw new Error("Bundle signing handler requires a valid endpoint path.");
  }
};

const readLimitedBody = async (
  body: ReadableStream<Uint8Array> | null,
  contentLength: string | null,
  limit: number,
) => {
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength) || Number(contentLength) > limit) {
      throw new Error("body too large");
    }
  }
  if (!body) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
};

const parseJsonBody = async (
  body: ReadableStream<Uint8Array> | null,
  headers: Headers,
  limit: number,
) => {
  if (!JSON_CONTENT_TYPE_PATTERN.test(headers.get("content-type") ?? "")) {
    throw new Error("invalid content type");
  }
  return JSON.parse(
    await readLimitedBody(body, headers.get("content-length"), limit),
  ) as unknown;
};

const parseMetadata = async (value: unknown): Promise<ResolvedPublicKey> => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "algorithm",
      "keyId",
      "protocolVersion",
      "publicKey",
    ]) ||
    value.protocolVersion !== REMOTE_BUNDLE_SIGNING_PROTOCOL_VERSION ||
    value.algorithm !== REMOTE_BUNDLE_SIGNING_ALGORITHM ||
    typeof value.keyId !== "string" ||
    !/^[a-f\d]{64}$/u.test(value.keyId) ||
    typeof value.publicKey !== "string"
  ) {
    throw new Error("invalid metadata");
  }

  const resolved = await canonicalizePublicKey(value.publicKey);
  if (resolved.keyId !== value.keyId) {
    throw new Error("invalid metadata");
  }
  return resolved;
};

const remoteRequest = async (
  fetchImplementation: Fetch,
  endpoint: string,
  resolveToken: () => string | Promise<string>,
  init: RequestInit,
) => {
  const token = await resolveToken();
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("missing token");
  }

  let response: Response;
  try {
    response = await fetchImplementation(endpoint, {
      ...init,
      headers: {
        Accept: "application/json",
        ...init.headers,
        [REMOTE_BUNDLE_SIGNING_TOKEN_HEADER]: token,
      },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // What fetch threw may quote the request: name only the endpoint.
    throw new RemoteSigningFailure(`Could not reach ${endpoint}.`);
  }
  if (response.status !== 200) {
    const refusal = await describeRefusal(response, token);
    throw new RemoteSigningFailure(
      `${endpoint} answered ${refusal}${/[.!?]$/u.test(refusal) ? "" : "."}`,
    );
  }
  return parseJsonBody(response.body, response.headers, RESPONSE_BODY_LIMIT);
};

/**
 * A refusal's status, with the `{ error }` or `{ error: { code, message } }`
 * a signing server answers it with, such as a scope refusal.
 * The token is masked and the message shortened to one line.
 */
const describeRefusal = async (response: Response, token: string) => {
  let code: unknown;
  let message: unknown;
  try {
    const body = await parseJsonBody(
      response.body,
      response.headers,
      ERROR_RESPONSE_BODY_LIMIT,
    );
    const error = isRecord(body) ? body.error : undefined;
    if (typeof error === "string") {
      message = error;
    } else if (isRecord(error)) {
      code = error.code;
      message = error.message;
    }
  } catch {
    // A body that is not JSON adds nothing to the status.
  }
  const status =
    typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(code)
      ? `${response.status} ${code}`
      : String(response.status);
  if (typeof message !== "string") return status;
  const text = message
    .split(token)
    .join("********")
    .replace(/\p{Cc}+/gu, " ")
    .trim();
  if (!text) return status;
  return `${status}: ${
    text.length > ERROR_MESSAGE_LENGTH_LIMIT
      ? `${text.slice(0, ERROR_MESSAGE_LENGTH_LIMIT)}…`
      : text
  }`;
};

/** Signs through a server implementing the Hot Updater signing protocol. */
export const remoteSigning = ({
  endpoint,
  fetch: fetchImplementation = globalThis.fetch,
  signingToken,
}: RemoteSigningOptions): BundleSigningAdapter => {
  if (typeof fetchImplementation !== "function") {
    throw new Error("Remote bundle signing requires fetch.");
  }
  // Checked on first use, so a config loads without the endpoint.
  let normalizedEndpoint: string | undefined;
  const endpointUrl = () =>
    (normalizedEndpoint ??= normalizeEndpoint(endpoint));
  let resolvedKey: Promise<ResolvedPublicKey> | undefined;
  const resolveToken = async () => {
    const token =
      typeof signingToken === "function"
        ? await signingToken()
        : (signingToken ?? process.env.HOT_UPDATER_SIGNING_TOKEN);
    if (!token?.trim()) {
      throw new RemoteSigningFailure(MISSING_TOKEN_MESSAGE);
    }
    return token;
  };

  const getResolvedKey = () => {
    if (resolvedKey) return resolvedKey;
    const url = endpointUrl();
    resolvedKey = remoteRequest(fetchImplementation, url, resolveToken, {
      method: "GET",
    })
      .then(parseMetadata)
      .catch((error: unknown) => {
        resolvedKey = undefined;
        throw remoteSigningError(
          "Failed to load the remote bundle signing public key.",
          error,
        );
      });
    return resolvedKey;
  };

  return {
    name: "remoteSigning",
    async getPublicKey() {
      const { publicKey } = await getResolvedKey();
      return { publicKey };
    },
    async sign({ message }) {
      if (
        !(message instanceof Uint8Array) ||
        message.byteLength !== MESSAGE_BYTES
      ) {
        throw new Error(
          "Remote bundle signing messages must be exactly 32 bytes.",
        );
      }

      const resolved = await getResolvedKey();
      let value: unknown;
      try {
        value = await remoteRequest(
          fetchImplementation,
          endpointUrl(),
          resolveToken,
          {
            body: JSON.stringify({
              algorithm: REMOTE_BUNDLE_SIGNING_ALGORITHM,
              keyId: resolved.keyId,
              message: bytesToBase64(message),
              protocolVersion: REMOTE_BUNDLE_SIGNING_PROTOCOL_VERSION,
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          },
        );
      } catch (error) {
        throw remoteSigningError(
          "Remote bundle signer failed to sign the message.",
          error,
        );
      }

      if (
        !isRecord(value) ||
        !hasExactKeys(value, [
          "algorithm",
          "keyId",
          "protocolVersion",
          "signature",
        ]) ||
        value.protocolVersion !== REMOTE_BUNDLE_SIGNING_PROTOCOL_VERSION ||
        value.algorithm !== REMOTE_BUNDLE_SIGNING_ALGORITHM ||
        value.keyId !== resolved.keyId ||
        typeof value.signature !== "string"
      ) {
        throw new Error("Remote bundle signer returned an invalid signature.");
      }
      const signature = base64ToBytes(value.signature);
      if (!signature || signature.byteLength > SIGNATURE_BYTES_LIMIT) {
        throw new Error("Remote bundle signer returned an invalid signature.");
      }
      const verified = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        resolved.cryptoKey,
        toArrayBuffer(signature),
        toArrayBuffer(message),
      );
      if (!verified) {
        throw new Error(
          "Remote bundle signer returned an unverifiable signature.",
        );
      }
      return { signature: new Uint8Array(signature) };
    },
  };
};

const jsonResponse = (
  value: unknown,
  status = 200,
  headers?: HeadersInitializer,
) =>
  Response.json(value, {
    headers: {
      "Cache-Control": "private, no-store",
      ...headers,
    },
    status,
  });

const isTokenSized = (value: string) =>
  new TextEncoder().encode(value).byteLength <= TOKEN_BYTES_LIMIT;

const tokensMatch = async (expected: string, actual: string | null) => {
  if (
    !expected ||
    actual === null ||
    !isTokenSized(expected) ||
    !isTokenSized(actual)
  ) {
    return false;
  }
  const [expectedHash, actualHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(actual)),
  ]);
  const left = new Uint8Array(expectedHash);
  const right = new Uint8Array(actualHash);
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
};

/** Handles the portable managed signing protocol in Web API runtimes. */
export const createBundleSigningHandler = async ({
  endpointPath = REMOTE_BUNDLE_SIGNING_PATH,
  publicKey,
  request,
  sign,
  token,
}: BundleSigningHandlerOptions): Promise<Response | null> => {
  const normalizedEndpointPath = normalizeHandlerPath(endpointPath);
  const url = new URL(request.url);
  if (url.pathname !== normalizedEndpointPath) return null;
  if (url.search || url.hash) {
    return jsonResponse({ error: "Bad request" }, 400);
  }

  const presented = request.headers.get(REMOTE_BUNDLE_SIGNING_TOKEN_HEADER);
  let accepted: boolean;
  try {
    accepted =
      typeof token === "function"
        ? presented !== null &&
          presented.length > 0 &&
          isTokenSized(presented) &&
          (await token(presented)) === true
        : await tokensMatch(token, presented);
  } catch {
    // A verifier that cannot decide, such as one whose store is down.
    return jsonResponse({ error: "Signing service unavailable" }, 503);
  }
  if (!accepted) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, {
      Allow: "GET, POST",
    });
  }

  let resolved: ResolvedPublicKey;
  try {
    resolved = await canonicalizePublicKey(
      typeof publicKey === "function" ? await publicKey() : publicKey,
    );
  } catch {
    return jsonResponse({ error: "Signing service unavailable" }, 503);
  }
  const metadata: RemoteMetadata = {
    algorithm: REMOTE_BUNDLE_SIGNING_ALGORITHM,
    keyId: resolved.keyId,
    protocolVersion: REMOTE_BUNDLE_SIGNING_PROTOCOL_VERSION,
    publicKey: resolved.publicKey,
  };
  if (request.method === "GET") {
    return jsonResponse(metadata);
  }

  let body: unknown;
  try {
    body = await parseJsonBody(
      request.body,
      request.headers,
      REQUEST_BODY_LIMIT,
    );
  } catch {
    return jsonResponse({ error: "Bad request" }, 400);
  }
  if (
    !isRecord(body) ||
    !hasExactKeys(body, ["algorithm", "keyId", "message", "protocolVersion"]) ||
    body.protocolVersion !== REMOTE_BUNDLE_SIGNING_PROTOCOL_VERSION ||
    body.algorithm !== REMOTE_BUNDLE_SIGNING_ALGORITHM ||
    body.keyId !== resolved.keyId ||
    typeof body.message !== "string"
  ) {
    return jsonResponse({ error: "Bad request" }, 400);
  }
  const message = base64ToBytes(body.message);
  if (!message || message.byteLength !== MESSAGE_BYTES) {
    return jsonResponse({ error: "Bad request" }, 400);
  }

  let signature: Uint8Array;
  try {
    const result = await sign(new Uint8Array(message));
    if (
      !(result instanceof Uint8Array) ||
      result.byteLength === 0 ||
      result.byteLength > SIGNATURE_BYTES_LIMIT
    ) {
      throw new Error("invalid signature");
    }
    signature = result;
  } catch {
    return jsonResponse({ error: "Signing service unavailable" }, 503);
  }
  try {
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      resolved.cryptoKey,
      toArrayBuffer(signature),
      toArrayBuffer(message),
    );
    if (!verified) {
      return jsonResponse({ error: "Signing service unavailable" }, 503);
    }
  } catch {
    return jsonResponse({ error: "Signing service unavailable" }, 503);
  }
  return jsonResponse({
    algorithm: REMOTE_BUNDLE_SIGNING_ALGORITHM,
    keyId: resolved.keyId,
    protocolVersion: REMOTE_BUNDLE_SIGNING_PROTOCOL_VERSION,
    signature: bytesToBase64(signature),
  });
};
