export class HandlerBadRequestError extends Error {
  readonly name = "HandlerBadRequestError";

  constructor(message: string) {
    super(message);
  }
}

export class HandlerPayloadTooLargeError extends Error {
  readonly name = "HandlerPayloadTooLargeError";

  constructor() {
    super("Event payload exceeds 16384 bytes");
  }
}
