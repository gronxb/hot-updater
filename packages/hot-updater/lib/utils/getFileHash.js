import crypto from "crypto";
import fs from "fs/promises";
export const getFileHashFromFile = async (filepath) => {
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
    }
    catch (error) {
        console.error("Error fetching or processing the file:", error);
        throw error;
    }
};
