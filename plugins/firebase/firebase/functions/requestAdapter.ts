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

export const createFirebaseWebRequest = (
  source: FirebaseRequestLike,
): Request => {
  const headers = createHeaders(source.headers);
  const method = source.method.toUpperCase();
  const requestPath = source.originalUrl || source.url;
  const fullUrl = new URL(requestPath, `https://${source.hostname}`).toString();

  if (!isBodyMethod(method)) {
    return new Request(fullUrl, { headers, method });
  }

  const init: RequestInit & { duplex: "half" } = {
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const rawBody = source.rawBody;
        if (rawBody !== undefined && rawBody.byteLength > 0) {
          controller.enqueue(rawBody);
        }
        controller.close();
      },
    }),
    duplex: "half",
    headers,
    method,
  };
  return new Request(fullUrl, init);
};
