import type { MiddlewareHandler } from "hono";

const MAX_LOG_BODY_SIZE = 8 * 1024;
const MAX_LOG_BODY_LENGTH = 2_000;

export function requestLogger(): MiddlewareHandler {
  return async (c, next) => {
    const startedAt = Date.now();
    const body = await readRequestBody(c.req.raw);

    try {
      await next();
    } catch (error) {
      logRequest({
        body,
        durationMs: Date.now() - startedAt,
        method: c.req.method,
        status: 500,
        url: c.req.url,
      });
      throw error;
    }

    logRequest({
      body,
      durationMs: Date.now() - startedAt,
      method: c.req.method,
      status: c.res.status,
      url: c.req.url,
    });
  };
}

function logRequest({
  body,
  durationMs,
  method,
  status,
  url,
}: {
  body?: string;
  durationMs: number;
  method: string;
  status: number;
  url: string;
}) {
  const message = `<-- ${method} ${url} ${status} ${durationMs}ms`;
  console.log(body === undefined ? message : `${message} body=${body}`);
}

async function readRequestBody(request: Request): Promise<string | undefined> {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength === "0") {
    return undefined;
  }

  const contentType = request.headers.get("content-type") ?? "";
  const normalizedContentType = contentType.toLowerCase();

  if (!isLoggableContentType(normalizedContentType)) {
    return contentType ? JSON.stringify(`[omitted ${contentType}]`) : undefined;
  }

  const bodySize = Number(contentLength);
  if (Number.isFinite(bodySize) && bodySize > MAX_LOG_BODY_SIZE) {
    return JSON.stringify(`[omitted body larger than ${MAX_LOG_BODY_SIZE} bytes]`);
  }

  const text = await request.clone().text();
  if (!text) {
    return undefined;
  }

  if (normalizedContentType.includes("application/json")) {
    return truncateBody(serializeJson(text));
  }

  return truncateBody(JSON.stringify(text));
}

function isLoggableContentType(contentType: string) {
  return (
    contentType.includes("application/json") ||
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.startsWith("text/")
  );
}

function serializeJson(text: string) {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return JSON.stringify(text);
  }
}

function truncateBody(body: string) {
  if (body.length <= MAX_LOG_BODY_LENGTH) {
    return body;
  }

  return `${body.slice(0, MAX_LOG_BODY_LENGTH)}...<truncated>`;
}
