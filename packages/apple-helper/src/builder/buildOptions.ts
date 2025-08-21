import type {
  ApplePlatform,
  NativeBuildIosScheme,
} from "@hot-updater/plugin-core";

/**
 * Build result information
 */
export interface BuildResult {
  /** Path to the built app (.app file) */
  appPath: string;
  /** Path to the Info.plist file */
  infoPlistPath: string;
  /** Archive path (if archive was created) */
  archivePath?: string;
  /** Export path (if IPA was exported) */
  exportPath?: string;
  /** Scheme used for building */
  scheme: string;
  /** Configuration used for building */
  configuration: string;
}

export interface ArchiveOptions {
  schemeConfig: NativeBuildIosScheme;
  outputPath: string;
  platform: ApplePlatform;
}

export interface ExportOptions {
  schemeConfig: NativeBuildIosScheme;
  archivePath: string;
}
