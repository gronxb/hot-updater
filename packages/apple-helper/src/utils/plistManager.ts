import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execa } from "execa";

const execFileAsync = promisify(execFile);

/**
 * Options for PListBuddy operations
 */
interface PListBuddyOptions {
  /** Output as XML format */
  xml?: boolean;
}

/**
 * Reads a key value from a plist file as string
 * @param plistPath - Path to the plist file
 * @param key - Key to read from the plist
 * @param options - Additional options for PListBuddy
 * @returns The value of the key as string
 * @throws Error if key cannot be read
 *
 * @example
 * ```typescript
 * const bundleId = await readKeyFromPlist("Info.plist", "CFBundleIdentifier");
 * console.log(bundleId); // "com.example.app"
 * ```
 */
export const readKeyFromPlist = async (
  plistPath: string,
  key: string,
  options: PListBuddyOptions = {},
): Promise<string> => {
  try {
    const result = await plistBuddy(plistPath, `Print:${key}`, options);
    return result.stdout.trim();
  } catch (error) {
    throw new Error(`Error reading key ${key} from ${plistPath}: ${error}`);
  }
};

/**
 * Reads a key value from a plist file as Buffer
 * @param plistPath - Path to the plist file
 * @param key - Key to read from the plist
 * @returns The value of the key as Buffer
 * @throws Error if key cannot be read
 *
 * @example
 * ```typescript
 * const data = await readBufferFromPlist("profile.mobileprovision", "DeveloperCertificates:0");
 * console.log(data.length); // Buffer length
 * ```
 */
export const readBufferFromPlist = async (
  plistPath: string,
  key: string,
): Promise<Buffer> => {
  try {
    const result = await binaryPlistBuddy(plistPath, `Print:${key}`);
    return Buffer.from(result.stdout, "binary");
  } catch (error) {
    throw new Error(
      `Error reading buffer key ${key} from ${plistPath}: ${error}`,
    );
  }
};

/**
 * Sets a key value in a plist file
 * @param plistPath - Path to the plist file
 * @param key - Key to set in the plist
 * @param value - Value to set
 * @param type - Type of the value (string, bool, integer, etc.)
 *
 * @example
 * ```typescript
 * await setKeyInPlist("Info.plist", "CFBundleVersion", "1.0.0", "string");
 * ```
 */
export const setKeyInPlist = async (
  plistPath: string,
  key: string,
  value: string,
  type: string = "string",
): Promise<void> => {
  try {
    await plistBuddy(plistPath, `Set:${key} ${value}`, {});
  } catch (error) {
    // If key doesn't exist, try to add it
    try {
      await plistBuddy(plistPath, `Add:${key} ${type} ${value}`, {});
    } catch (addError) {
      throw new Error(`Error setting key ${key} in ${plistPath}: ${addError}`);
    }
  }
};

/**
 * Executes PListBuddy command
 * @param path - Path to the plist file
 * @param command - PListBuddy command to execute
 * @param options - Additional options
 * @returns Command execution result
 */
const plistBuddy = async (
  path: string,
  command: string,
  options?: PListBuddyOptions,
): Promise<{ stdout: string; stderr: string }> => {
  const args = ["-c", command, path];
  if (options?.xml) {
    args.unshift("-x");
  }

  const result = await execa("/usr/libexec/PlistBuddy", args);
  return { stdout: result.stdout, stderr: result.stderr };
};

/**
 * Special version of plistBuddy that reads the output as binary
 * Uses execFile instead of execa for binary output support
 * @param path - Path to the plist file
 * @param command - PListBuddy command to execute
 * @returns Command execution result with binary stdout
 */
const binaryPlistBuddy = async (
  path: string,
  command: string,
): Promise<{ stdout: string; stderr: string }> => {
  const args = ["-c", command, path];
  const result = await execFileAsync("/usr/libexec/PlistBuddy", args, {
    encoding: "binary",
  });

  return result;
};

/**
 * Checks if a plist file exists and is readable
 * @param plistPath - Path to the plist file
 * @returns True if plist exists and is readable
 */
export const isPlistReadable = async (plistPath: string): Promise<boolean> => {
  try {
    await plistBuddy(plistPath, "Print", {});
    return true;
  } catch {
    return false;
  }
};
