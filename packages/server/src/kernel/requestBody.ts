import type { HotUpdaterPayloadTooLargeResponse } from "./contracts";
import { payloadTooLargeResponse } from "./staticResponse";

export class HotUpdaterPayloadTooLargeError extends Error {
  readonly name = "HotUpdaterPayloadTooLargeError";

  constructor() {
    super("Request body exceeds its configured byte limit.");
  }
}

const validateMaximumBodyBytes = (maximumBodyBytes: number): void => {
  if (!Number.isSafeInteger(maximumBodyBytes) || maximumBodyBytes < 0) {
    throw new RangeError(
      "maximumBodyBytes must be a non-negative safe integer.",
    );
  }
};

export const checkDeclaredBodyLength = (
  headers: Headers,
  maximumBodyBytes: number,
  configuredResponse?: HotUpdaterPayloadTooLargeResponse,
): Response | undefined => {
  validateMaximumBodyBytes(maximumBodyBytes);
  const contentLength = headers.get("content-length");
  if (contentLength === null || !/^(0|[1-9]\d*)$/.test(contentLength)) {
    return undefined;
  }
  if (BigInt(contentLength) <= BigInt(maximumBodyBytes)) {
    return undefined;
  }
  return payloadTooLargeResponse(configuredResponse);
};

export const applyBoundedBody = (
  request: Request,
  maximumBodyBytes: number,
): Request => {
  validateMaximumBodyBytes(maximumBodyBytes);
  if (request.body === null) return request;

  const reader = request.body.getReader();
  let consumedBytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async cancel(reason) {
      await reader.cancel(reason);
    },
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          return;
        }
        consumedBytes += result.value.byteLength;
        if (consumedBytes > maximumBodyBytes) {
          const error = new HotUpdaterPayloadTooLargeError();
          try {
            await reader.cancel(error);
          } catch {
            controller.error(error);
            return;
          }
          controller.error(error);
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
  });
  const init: RequestInit & { readonly duplex: "half" } = {
    body,
    duplex: "half",
  };
  return new Request(request, init);
};
