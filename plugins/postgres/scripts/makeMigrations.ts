import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dayjs from "dayjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sqlDir = path.resolve(__dirname, "../sql");
const files = fs.readdirSync(sqlDir);
const sqlFiles = files.filter((file) => file.endsWith(".sql"));

const migrationDir = path.resolve(__dirname, "../migrations");
const migrationFiles = fs
  .readdirSync(migrationDir)
  .filter((file) => file.startsWith("Migration_") && file.endsWith(".sql"))
  .sort();

const timestamp = dayjs().format("YYYYMMDDHHmmss");

// 이전 마이그레이션 파일들에서 이미 존재하는 SQL 내용 수집
const existingSql = new Set();
for (const file of migrationFiles) {
  const sep = "--HotUpdater.";
  const content = fs.readFileSync(path.resolve(migrationDir, file), "utf-8");
  for (const sql of content.split(sep)) {
    const trimmedSql = sql.trim();
    if (trimmedSql) {
      existingSql.add(`${sep}${trimmedSql}`);
    }
  }
}

console.log(existingSql);
// 새로운 SQL 파일들 중 아직 마이그레이션되지 않은 내용만 필터링
const newSqlContent = sqlFiles
  .map((file) => fs.readFileSync(path.resolve(sqlDir, file), "utf-8"))
  .filter((sql) => !existingSql.has(sql.trim()));

if (newSqlContent.length > 0) {
  const migrationFile = path.resolve(
    migrationDir,
    `Migration_${timestamp}.sql`,
  );
  fs.writeFileSync(migrationFile, newSqlContent.join("\n\n"));
  console.log(
    "새로운 마이그레이션이 생성되었습니다:",
    `Migration_${timestamp}.sql`,
  );
} else {
  console.log("변경사항이 없습니다.");
}
