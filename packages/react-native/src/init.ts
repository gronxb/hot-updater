import { handleNotifyAppReady } from "./appReady";
import type { InternalInitOptions } from "./init.types";

export type { HotUpdaterInitOptions, InternalInitOptions } from "./init.types";

/** Reads this launch; the promise settles once it is read, and never rejects. */
export function init(options: InternalInitOptions): Promise<unknown> {
  return handleNotifyAppReady(options);
}
