import { BuildLogger } from "@hot-updater/cli-tools";

export const createGradleLogger = ({ logPrefix }: { logPrefix: string }) =>
  new BuildLogger({
    logPrefix,
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
