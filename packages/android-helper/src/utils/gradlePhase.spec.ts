import { describe, expect, it } from "vitest";

import { createGradlePhaseReader } from "./gradlePhase";

/** Lines of a real `./gradlew app:assembleRelease`, on Gradle's plain console. */
const ASSEMBLE = [
  "Starting a Gradle Daemon (subsequent builds will be faster)",
  "",
  "> Configure project :brownfieldlib",
  " react-brownfield :: creating configuration embed ⌛️",
  "> Task :gradle-plugin:settings-plugin:checkKotlinGradlePluginConfigurationErrors SKIPPED",
  "> Task :react-native-screens:configureCMakeRelWithDebInfo[x86_64]",
  "C/C++: Hard link from '/home/dev/.gradle/caches/transformed/prefab' failed",
  "> Task :app:createBundleReleaseJsAndAssets",
  "> Task :callstack_repack:stripReleaseDebugSymbols UP-TO-DATE",
  "w: file:///src/Lib.kt:3:1 'value' is deprecated.",
  "> Task :app:packageRelease",
  "",
  "BUILD SUCCESSFUL in 50s",
  "338 actionable tasks: 57 executed, 281 up-to-date",
];

describe("createGradlePhaseReader", () => {
  it("reads the task Gradle runs, with how many it has run", () => {
    const read = createGradlePhaseReader();

    expect(ASSEMBLE.flatMap((line) => read(line) ?? [])).toEqual([
      "Starting the Gradle daemon",
      "Configuring :brownfieldlib",
      "1 task · :gradle-plugin:settings-plugin:checkKotlinGradlePluginConfigurationErrors",
      "2 tasks · :react-native-screens:configureCMakeRelWithDebInfo[x86_64]",
      "3 tasks · :app:createBundleReleaseJsAndAssets",
      "4 tasks · :callstack_repack:stripReleaseDebugSymbols",
      "5 tasks · :app:packageRelease",
    ]);
  });

  it("says when the wrapper downloads Gradle", () => {
    expect(
      createGradlePhaseReader()(
        "Downloading https://services.gradle.org/distributions/gradle-9.3.1-bin.zip",
      ),
    ).toBe("Downloading Gradle");
  });
});
