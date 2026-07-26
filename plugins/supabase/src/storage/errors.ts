import {
  StoragePluginError,
  type StoragePluginErrorCode,
} from "@hot-updater/plugin-core/storage";

type SupabaseStorageErrorDetail = Readonly<{
  code: StoragePluginErrorCode;
  status: number;
  message: string;
  providerCode?: string;
}>;

export class SupabaseStorageError extends StoragePluginError {
  readonly status: number;
  readonly providerCode?: string;

  constructor(detail: SupabaseStorageErrorDetail) {
    super(detail.code, detail.message);
    this.name = "SupabaseStorageError";
    this.status = detail.status;
    this.providerCode = detail.providerCode;
  }
}

const codeForStatus = (status: number): StoragePluginErrorCode => {
  if (status === 401) {
    return "unauthorized";
  }
  if (status === 403) {
    return "forbidden";
  }
  if (status === 408 || status === 504) {
    return "timeout";
  }
  if (status === 429) {
    return "rate-limited";
  }
  return "provider";
};

const readErrorBody = async (
  response: Response,
): Promise<Readonly<{ message: string; providerCode?: string }>> => {
  const value: unknown = await response.json().catch(() => undefined);
  if (typeof value !== "object" || value === null) {
    return { message: `Supabase Storage request failed (${response.status}).` };
  }
  const message =
    "message" in value && typeof value.message === "string"
      ? value.message
      : "error" in value && typeof value.error === "string"
        ? value.error
        : `Supabase Storage request failed (${response.status}).`;
  const providerCode =
    "statusCode" in value &&
    (typeof value.statusCode === "string" ||
      typeof value.statusCode === "number")
      ? String(value.statusCode)
      : "code" in value && typeof value.code === "string"
        ? value.code
        : undefined;
  return providerCode === undefined ? { message } : { message, providerCode };
};

export const toSupabaseStorageError = async (
  response: Response,
): Promise<SupabaseStorageError> => {
  const detail = await readErrorBody(response);
  return new SupabaseStorageError({
    code: codeForStatus(response.status),
    status: response.status,
    message: detail.message,
    ...(detail.providerCode === undefined
      ? {}
      : { providerCode: detail.providerCode }),
  });
};
