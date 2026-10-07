import { handleNotifyAppReady } from "./appReady";
import type { InternalInitOptions } from "./init.types";

export type { HotUpdaterInitOptions, InternalInitOptions } from "./init.types";

export function init(options: InternalInitOptions): void {
  void handleNotifyAppReady(options);
}
