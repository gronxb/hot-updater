import type { Platform } from "@hot-updater/protocol";

import { HandlerBadRequestError } from "./handlerErrors";

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
