export type HdiffErrorCode =
  | "INVALID_HBC"
  | "NON_EXECUTION_FORM"
  | "BYTECODE_VERSION_MISMATCH"
  | "PATCH_FAILED";

export class HdiffError extends Error {
  public readonly code: HdiffErrorCode;

  public constructor(
    code: HdiffErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HdiffError";
    this.code = code;
  }
}
