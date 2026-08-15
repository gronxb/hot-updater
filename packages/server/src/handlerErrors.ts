export class HandlerBadRequestError extends Error {
  readonly name = "HandlerBadRequestError";

  constructor(message: string) {
    super(message);
  }
}
