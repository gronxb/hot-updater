import crypto from "crypto";
import { createReadStream } from "fs";

export const getFileHashFromFile = async (filepath: string) => {
  const hash = crypto.createHash("sha256");
  const stream = createReadStream(filepath);

  return new Promise<string>((resolve, reject) => {
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });

    stream.on("error", reject);
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
};
