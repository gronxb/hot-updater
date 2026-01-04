import plist from "plist";
import * as bplistParser from "./bplistParser";

/**
 * Checks if a buffer contains a binary plist file
 * @param buffer - The buffer to check
 * @returns true if the buffer starts with "bplist" header
 */
export function isBinaryPlist(buffer: Buffer): boolean {
  return buffer.length >= 6 && buffer.toString("utf8", 0, 6) === "bplist";
}

/**
 * Parses a plist file (binary or XML format) from a buffer
 * @param buffer - The buffer containing the plist data
 * @returns The parsed plist object
 */
export function parsePlist(buffer: Buffer): Record<string, any> {
  if (isBinaryPlist(buffer)) {
    // Parse binary plist using inline implementation
    const result = bplistParser.parseBuffer(buffer);
    return result[0] as Record<string, any>;
  } else {
    // Parse XML plist
    const xmlString = buffer.toString("utf-8");
    return plist.parse(xmlString) as Record<string, any>;
  }
}
