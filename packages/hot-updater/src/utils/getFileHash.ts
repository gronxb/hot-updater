import crypto from "node:crypto";
import fs from "node:fs/promises";

export const getFileHashFromUrl = async (url: string) => {
  try {
    // Fetch the file
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Failed to fetch ${url}: ${response.statusText}`);

    // Get the file as a buffer
    const buffer = await response.arrayBuffer();
    const fileBuffer = Buffer.from(buffer);

    // Calculate the hash
    const hash = crypto.createHash("sha256");
    hash.update(fileBuffer);
    const fileHash = hash.digest("hex");

    return fileHash;
  } catch (error) {
    console.error("Error fetching or processing the file:", error);
    throw error;
  }
};

export const getFileHashFromFile = async (filepath: string) => {
  try {
    // Read the file
    const fileBuffer = await fs.readFile(filepath).catch((error) => {
      console.error("Error reading the file:", error);
      throw error;
    });

    // Calculate the hash
    const hash = crypto.createHash("sha256");
    hash.update(fileBuffer);
    const fileHash = hash.digest("hex");

    return fileHash;
  } catch (error) {
    console.error("Error fetching or processing the file:", error);
    throw error;
  }
};
