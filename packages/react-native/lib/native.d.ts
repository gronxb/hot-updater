/**
 * Fetches the current bundle version id.
 *
 * @async
 * @returns {Promise<number>} Resolves with the current version id or null if not available.
 */
export declare const getBundleVersion: () => Promise<number>;
/**
 * Downloads files from given URLs.
 *
 * @async
 * @param {string} bundleVersion - identifier for the bundle version.
 * @param {string | null} zipUrl - zip file URL.
 * @returns {Promise<boolean>} Resolves with true if download was successful, otherwise rejects with an error.
 */
export declare const updateBundle: (bundleVersion: number, zipUrl: string | null) => Promise<boolean>;
/**
 * Fetches the current app version.
 */
export declare const getAppVersion: () => Promise<string | null>;
/**
 * Reloads the app.
 */
export declare const reload: () => void;
/**
 * Initializes the HotUpdater.
 */
export declare const initializeOnAppUpdate: () => void;
