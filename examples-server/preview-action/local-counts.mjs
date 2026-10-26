// Counts native_builds rows and stored objects on the local backend.
import { execFileSync } from "node:child_process";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
const rows = execFileSync("docker", ["exec", "nbc-check-pg", "psql", "-U", "postgres", "-tAc", "select count(*) from native_builds"]).toString().trim();
const s3 = new S3Client({ region: process.env.HOT_UPDATER_S3_REGION, endpoint: process.env.HOT_UPDATER_S3_ENDPOINT, forcePathStyle: true, credentials: { accessKeyId: process.env.HOT_UPDATER_S3_ACCESS_KEY_ID, secretAccessKey: process.env.HOT_UPDATER_S3_SECRET_ACCESS_KEY } });
let objects = 0, token;
do { const r = await s3.send(new ListObjectsV2Command({ Bucket: process.env.HOT_UPDATER_S3_BUCKET_NAME, ContinuationToken: token })); objects += r.KeyCount ?? 0; token = r.NextContinuationToken; } while (token);
console.log(`native_builds rows: ${rows}, stored objects: ${objects}`);
