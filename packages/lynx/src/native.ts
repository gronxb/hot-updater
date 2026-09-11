import type { HotUpdaterLynxNative, NativeReply } from "./types";

declare const NativeModules:
  | { HotUpdaterLynx?: HotUpdaterLynxNative }
  | undefined;

/** Native rejection codes, including INCOMPATIBLE, are preserved unchanged. */
export class LynxUpdaterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LynxUpdaterError";
  }
}

export function callNative<T>(
  method: keyof HotUpdaterLynxNative,
  params?: object,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const module =
      typeof NativeModules === "undefined"
        ? undefined
        : NativeModules?.HotUpdaterLynx;
    const operation = module?.[method];
    if (typeof operation !== "function") {
      reject(
        new LynxUpdaterError(
          "NATIVE_MODULE_UNAVAILABLE",
          `HotUpdaterLynx.${method} is unavailable. Register the native module and call the SDK from background scripting.`,
        ),
      );
      return;
    }
    const callback = (reply: NativeReply<T>) => {
      if (reply?.ok === true) resolve(reply.data);
      else if (
        reply?.ok === false &&
        typeof reply.error?.code === "string" &&
        typeof reply.error?.message === "string"
      ) {
        reject(new LynxUpdaterError(reply.error.code, reply.error.message));
      } else {
        reject(
          new LynxUpdaterError(
            "INVALID_NATIVE_REPLY",
            `HotUpdaterLynx.${method} returned an invalid reply.`,
          ),
        );
      }
    };
    // Lynx methods use either (callback) or (params, callback).
    const invoke = operation as (...args: unknown[]) => void;
    invoke.apply(
      module,
      params === undefined ? [callback] : [params, callback],
    );
  });
}
