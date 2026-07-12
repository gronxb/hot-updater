export type DatabaseConnectorErrorCodeV2 =
  | "INVALID_SCOPE"
  | "INVALID_CHANGE_SET"
  | "INVALID_CURSOR"
  | "INVALID_MANIFEST"
  | "CANONICALIZATION_FAILED"
  | "DIGEST_UNAVAILABLE"
  | "CONCURRENT_COMMIT"
  | "SESSION_POISONED"
  | "SESSION_CLOSING"
  | "SESSION_CLOSED"
  | "CONNECTION_CLOSING"
  | "CONNECTION_CLOSED"
  | "CONNECTOR_PROTOCOL_VIOLATION";

export class DatabaseConnectorErrorV2 extends Error {
  override readonly name = "DatabaseConnectorErrorV2";
  readonly code: DatabaseConnectorErrorCodeV2;
  override readonly cause?: unknown;

  constructor(
    code: DatabaseConnectorErrorCodeV2,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.code = code;
    this.cause = options?.cause;
  }
}
