import { BuildLogger } from "@hot-updater/plugin-core";

export const createGradleLogger = () =>
  new BuildLogger({
    failurePatterns: ["BUILD FAILED"],
    importantLogPatterns: [
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
      // React Native specific errors
      "Unable to load script",
      "Metro encountered an error",
      "React Native CLI",
      // Android specific build errors
      "Android resource compilation failed",
      "Duplicate class",
      "Program type already present",
      // Build completion
      "actionable tasks:",
    ],
    progressMapping: [
      /* Initial setup and code generation */ [
        [
          "buildKotlinToolingMetadata",
          "generateAutolinkingNewArchitectureFiles",
          "generateCodegenSchemaFromJavaScript",
        ],
        5,
      ],
      /* Bundle JS and assets creation (React Native specific) */ [
        [
          "createBundleReleaseJsAndAssets",
          "bundleReleaseJsAndAssets",
          "bundleDebugJsAndAssets",
        ],
        15,
      ],
      /* Resource processing */ [
        [
          "generateReleaseResValues",
          "generateReleaseResources",
          "mergeReleaseResources",
        ],
        25,
      ],
      /* Manifest and resource processing */ [
        [
          "processReleaseResources",
          "processReleaseManifest",
          "parseReleaseLocalResources",
        ],
        35,
      ],
      /* Kotlin compilation */ [
        ["compileReleaseKotlin", "compileDebugKotlin"],
        50,
      ],
      /* Java compilation */ [
        ["compileReleaseJavaWithJavac", "compileDebugJavaWithJavac"],
        60,
      ],
      /* DEX processing */ [
        ["dexBuilderRelease", "mergeDexRelease", "transformClassesWithDex"],
        75,
      ],
      /* Asset optimization and packaging */ [
        [
          "compressReleaseAssets",
          "optimizeReleaseResources",
          "mergeReleaseAssets",
        ],
        85,
      ],
      /* Final packaging and assembly */ [
        ["packageRelease", "packageDebug", "assembleRelease", "assembleDebug"],
        90,
      ],
      /* Bundle creation (AAB) */ [["bundleRelease", "bundleDebug"], 95],
      /* Build completion */ [[/\d+ actionable tasks:/], 100],
    ],
  });
