import path from "path";
import fs from "fs/promises";

export const prepareSql = async () => {
  const postgresPath = path.dirname(
    require.resolve("@hot-updater/postgres/sql"),
  );

  const files = await fs.readdir(postgresPath);
  const sqlFiles = files.filter((file) => file.endsWith(".sql"));
  const contents = await Promise.all(
    sqlFiles.map((file) => fs.readFile(path.join(postgresPath, file), "utf-8")),
  );
  return contents.join("\n");
};
