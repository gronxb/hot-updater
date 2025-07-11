import path from "node:path";
import fs from "node:fs";
import type {
  NativeBuildIosScheme,
  RequiredDeep,
} from "@hot-updater/plugin-core";
import { getCwd } from "@hot-updater/plugin-core";
import * as p from "@clack/prompts";
import { createXcodeBuilder } from "./builder/xcodeBuilder";
import { validateBuildOptions } from "./builder/buildOptions";
import type { BuildFlags } from "./builder/buildOptions";

/**
 * Creates an iOS native build with archive and export capabilities
 * @param schemeConfig - iOS build scheme configuration
 * @returns Build directory and artifact path information
 * 
 * @example
 * ```typescript
 * const result = await createIosNativeBuild({
 *   schemeConfig: {
 *     scheme: "MyApp",
 *     buildConfiguration: "Release",
 *     exportOptionsPlist: "./ExportOptions.plist"
 *   }
 * });
 * console.log(result.buildArtifactPath); // Path to IPA file
 * ```
 */
export const createIosNativeBuild = async ({
  schemeConfig,
}: {
  schemeConfig: RequiredDeep<NativeBuildIosScheme>;
}): Promise<{ buildDirectory: string; buildArtifactPath: string }> => {
  const iosProjectRoot = path.join(getCwd(), "ios");
  
  // Convert scheme config to build flags
  const buildFlags: BuildFlags = validateBuildOptions({
    scheme: schemeConfig.scheme,
    configuration: schemeConfig.buildConfiguration || "Release",
    archive: true, // Always create archive for distribution
    installPods: true,
    exportOptionsPlist: schemeConfig.exportOptionsPlist,
  });

  // Initialize builder
  const builder = createXcodeBuilder(iosProjectRoot, "ios");
  
  try {
    // Create archive
    p.log.info("Creating iOS archive...");
    const { archivePath } = await builder.archive({
      scheme: buildFlags.scheme || "Release",
      buildConfiguration: buildFlags.configuration || "Release",
      platform: "ios",
      extraParams: buildFlags.extraParams,
      buildFolder: buildFlags.buildFolder,
    });

    // Export archive to IPA
    if (buildFlags.exportOptionsPlist) {
      p.log.info("Exporting archive to IPA...");
      const { exportPath } = await builder.exportArchive({
        archivePath,
        exportOptionsPlist: buildFlags.exportOptionsPlist,
        exportExtraParams: buildFlags.exportExtraParams,
      });

      // Find the IPA file in export directory
      const files = fs.readdirSync(exportPath);
      const ipaFile = files.find(file => file.endsWith(".ipa"));
      
      if (ipaFile) {
        const ipaPath = path.join(exportPath, ipaFile);
        return { 
          buildDirectory: exportPath, 
          buildArtifactPath: ipaPath 
        };
      }
    }

    // If no export options or IPA not found, return archive path
    return { 
      buildDirectory: path.dirname(archivePath), 
      buildArtifactPath: archivePath 
    };
    
  } catch (error) {
    p.log.error(`iOS build failed: ${error}`);
    throw error;
  }
};

// TODO: Add advanced build features 
// - Build cache management to avoid unnecessary rebuilds
// - Parallel build support for multiple schemes/configurations
// - Build artifact signing verification
// - Build size analysis and optimization suggestions
// - Integration with React Native codegen for new architecture support