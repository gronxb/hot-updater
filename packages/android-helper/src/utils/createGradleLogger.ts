import { BuildLogger } from "@hot-updater/cli-tools";

export const createGradleLogger = ({ logPrefix }: { logPrefix: string }) =>
  new BuildLogger({
    logPrefix,
    importantLogPatterns: [
      // Keep high-signal failure and project setup issues.
      "error:",
      "Error:",
      "ERROR:",
      "> Task :",
      "BUILD FAILED",
      "BUILD SUCCESSFUL",
      "FAILURE: Build failed with an exception.",
      "* What went wrong:",
      "Execution failed for task",
      "Could not resolve",
      "Failed to",
      "Unable to load script",
      "Metro encountered an error",
      "React Native CLI",
      "Android resource compilation failed",
      "Duplicate class",
      "Program type already present",
      "actionable tasks:",
      "Deprecated Gradle features were used",
      // Keep milestone Gradle transitions for readable progress during long builds.
      ":app:configureCMake",
      ":app:buildCMake",
      ":app:compileDebugKotlin",
      ":app:compileReleaseKotlin",
      ":app:compileDebugJavaWithJavac",
      ":app:compileReleaseJavaWithJavac",
      ":app:mergeDebugResources",
      ":app:mergeReleaseResources",
      ":app:processDebugResources",
      ":app:processReleaseResources",
      ":app:packageDebug",
      ":app:packageRelease",
      ":app:assembleDebug",
      ":app:assembleRelease",
    ],
    progressStages: [
      /* Initial setup and code generation */
      [
        "buildKotlinToolingMetadata",
        "generateAutolinkingNewArchitectureFiles",
        "generateAutolinkingPackageList",
        "generateCodegenSchemaFromJavaScript",
        "generateCodegenArtifactsFromSchema",
        "generateReactNativeEntryPoint",
      ],
      /* Bundle JS and assets creation (React Native specific) */
      [
        "createBundleReleaseJsAndAssets",
        "bundleReleaseJsAndAssets",
        "bundleDebugJsAndAssets",
      ],
      /* Resource processing */
      [
        "generateReleaseResValues",
        "generateDebugResValues",
        "generateReleaseResources",
        "generateDebugResources",
        "mergeReleaseResources",
        "mergeDebugResources",
      ],
      /* Manifest and resource processing */
      [
        "processReleaseResources",
        "processDebugResources",
        "processReleaseManifest",
        "processDebugManifest",
        "processDebugMainManifest",
        "parseReleaseLocalResources",
        "parseDebugLocalResources",
      ],
      /* Kotlin compilation */
      ["compileReleaseKotlin", "compileDebugKotlin"],
      /* Java compilation */
      ["compileReleaseJavaWithJavac", "compileDebugJavaWithJavac"],
      /* Native build (CMake/JNI) */
      [
        /configureCMake\w+\[/,
        /buildCMake\w+\[/,
        "mergeReleaseJniLibFolders",
        "mergeDebugJniLibFolders",
        "mergeReleaseNativeLibs",
        "mergeDebugNativeLibs",
      ],
      /* DEX processing */
      [
        "desugarReleaseFileDependencies",
        "desugarDebugFileDependencies",
        "dexBuilderRelease",
        "dexBuilderDebug",
        "mergeDexRelease",
        "mergeExtDexRelease",
        "mergeExtDexDebug",
        "mergeProjectDexRelease",
        "mergeProjectDexDebug",
        "mergeLibDexRelease",
        "mergeLibDexDebug",
        "mergeDebugGlobalSynthetics",
        "mergeReleaseGlobalSynthetics",
        "transformClassesWithDex",
      ],
      /* Asset optimization and packaging */
      [
        "compressReleaseAssets",
        "compressDebugAssets",
        "optimizeReleaseResources",
        "mergeReleaseAssets",
        "mergeDebugAssets",
      ],
      /* Final packaging and assembly */
      ["packageRelease", "packageDebug", "assembleRelease", "assembleDebug"],
      /* Bundle creation (AAB) */
      ["bundleRelease", "bundleDebug"],
      /* Build completion */
      ["BUILD SUCCESSFUL", /\d+ actionable tasks:/],
    ],
  });
