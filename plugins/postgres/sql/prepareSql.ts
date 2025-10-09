import fs from "fs/promises";
import path from "path";

export const prepareSql = async () => {
  const files = await fs.readdir(__dirname);
  const sqlFiles = files.filter((file) => file.endsWith(".sql"));
  const contents = await Promise.all(
    sqlFiles.map((file) => fs.readFile(path.join(__dirname, file), "utf-8")),
  );
  return contents.join("\n");
};
