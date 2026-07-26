type FirebaseRequestLike = {
  readonly headers: Readonly<
    Record<string, string | readonly string[] | undefined>
  >;
  readonly hostname: string;
  readonly method: string;
  readonly originalUrl?: string;
  readonly rawBody?: Uint8Array;
  readonly url: string;
};

type FirebaseResponseLike = {
  send(body: string): void;
  setHeader(name: string, value: string): void;
  status(code: number): FirebaseResponseLike;
};

export type FirebaseWebRequestResult =
  | { readonly kind: "payload-too-large" }
  | { readonly kind: "request"; readonly request: Request };

export const FIREBASE_FUNCTION_CONCURRENCY = 10;
export const FIREBASE_FUNCTION_MAX_INSTANCES = 10;

const isBodyMethod = (method: string): boolean =>
  method !== "GET" && method !== "HEAD";

const createHeaders = (values: FirebaseRequestLike["headers"]): Headers => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    headers.set(key, typeof value === "string" ? value : value.join(", "));
  }
  return headers;
};

const exceedsDeclaredLength = (
  headers: Headers,
  maximumBodyBytes: number,
): boolean => {
  const contentLength = headers.get("content-length");
  return (
    contentLength !== null &&
    /^[0-9]+$/u.test(contentLength) &&
    BigInt(contentLength) > BigInt(maximumBodyBytes)
  );
};

export const createFirebaseWebRequest = (
  source: FirebaseRequestLike,
  maximumBodyBytes: number,
): FirebaseWebRequestResult => {
  const headers = createHeaders(source.headers);
  const method = source.method.toUpperCase();
  const requestPath = source.originalUrl || source.url;
  const fullUrl = new URL(requestPath, `https://${source.hostname}`).toString();

  if (!isBodyMethod(method)) {
    return {
      kind: "request",
      request: new Request(fullUrl, { headers, method }),
    };
  }
  if (exceedsDeclaredLength(headers, maximumBodyBytes)) {
    return { kind: "payload-too-large" };
  }

  const rawBody = source.rawBody ?? new Uint8Array();
  if (rawBody.byteLength > maximumBodyBytes) {
    return { kind: "payload-too-large" };
  }

  return {
    kind: "request",
    request: new Request(fullUrl, {
      body: rawBody.byteLength === 0 ? undefined : new Uint8Array(rawBody),
      headers,
      method,
    }),
  };
};

export const sendFirebasePayloadTooLarge = (
  response: FirebaseResponseLike,
): void => {
  response.status(413);
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Content-Type", "application/json");
  response.send(JSON.stringify({ error: "Request payload too large" }));
};
