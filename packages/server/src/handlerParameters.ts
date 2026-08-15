import type { Platform } from "@hot-updater/core";

import { HandlerBadRequestError } from "./handlerErrors";

type PositiveIntegerBounds = {
  readonly defaultValue: number;
  readonly maxValue: number;
};

export const decodeMaybe = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const isPlatform = (value: string): value is Platform =>
  value === "ios" || value === "android";

export const requireRouteParam = (
  params: Record<string, string>,
  key: string,
): string => {
  const value = params[key];
  if (!value) {
    throw new HandlerBadRequestError(`Missing route parameter: ${key}`);
  }
  return value;
};

export const requirePlatformParam = (
  params: Record<string, string>,
): Platform => {
  const platform = requireRouteParam(params, "platform");
  if (!isPlatform(platform)) {
    throw new HandlerBadRequestError(
      `Invalid platform: ${platform}. Expected 'ios' or 'android'.`,
    );
  }
  return platform;
};

export const parseBooleanSearchParam = (
  url: URL,
  key: string,
): boolean | undefined => {
  const value = url.searchParams.get(key);
  if (value === null) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new HandlerBadRequestError(
    `The '${key}' query parameter must be 'true' or 'false'.`,
  );
};

export const parseNullableStringSearchParam = (
  url: URL,
  key: string,
): string | null | undefined => {
  const value = url.searchParams.get(key);
  if (value === null) return undefined;
  return value === "null" ? null : value;
};

export const parseStringArraySearchParam = (
  url: URL,
  key: string,
): string[] | undefined => {
  const values = url.searchParams.getAll(key);
  return values.length > 0 ? values : undefined;
};

export const parsePositiveIntegerSearchParam = (
  url: URL,
  key: string,
  bounds: PositiveIntegerBounds,
): number => {
  const value = url.searchParams.get(key);
  if (value === null) return bounds.defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > bounds.maxValue) {
    throw new HandlerBadRequestError(
      `The '${key}' query parameter must be a positive integer between 1 and ${bounds.maxValue}.`,
    );
  }
  return parsed;
};

export const parseNonNegativeIntegerSearchParam = (
  url: URL,
  key: string,
  defaultValue: number,
): number => {
  const value = url.searchParams.get(key);
  if (value === null) return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HandlerBadRequestError(
      `The '${key}' query parameter must be a non-negative integer.`,
    );
  }
  return parsed;
};
