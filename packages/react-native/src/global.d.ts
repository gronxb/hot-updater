/**
 * Global type definitions for HotUpdater
 */
declare global {
  /**
   * Gets the base URL for the current active bundle directory.
   * Returns the file:// URL to the bundle directory with trailing slash.
   *
   * This function is globally available for use in Expo DOM components
   * and Babel plugin generated code without requiring an import.
   *
   * @returns {string} Base URL string (e.g., "file:///data/.../bundle-store/abc123/")
   *
   * @example
   * ```ts
   * const baseURL = globalThis.HotUpdaterGetBaseURL();
   * const htmlPath = baseURL + "www.bundle/index.html";
   * ```
   */
  var HotUpdaterGetBaseURL: () => string | null;
}

export {};
