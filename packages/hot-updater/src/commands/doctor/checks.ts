export interface DoctorCheck {
  code: string;
  status: "pass" | "fail" | "blocked";
  message: string;
  paths?: string[];
  fixability?: "auto" | "command" | "blocked";
  resolution?: string;
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
