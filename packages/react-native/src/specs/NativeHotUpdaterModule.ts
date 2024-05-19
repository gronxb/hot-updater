"use strict";
import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

interface Spec extends TurboModule {
  reload(): void;
  updateBundle(
    encodedURLs: string,
    prefix: string,
    callback: (success: boolean) => void
  ): Promise<boolean>;
  getAppVersionId(): Promise<string>;
}

export default TurboModuleRegistry.get<Spec>("HotUpdater");
