import { MongoClient } from "mongodb";
import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.hotupdater
config({ path: path.join(__dirname, ".env.hotupdater") });

// Use TEST_MONGODB_URL for testing, otherwise use default MONGODB_URL
const mongoUrl =
  process.env.TEST_MONGODB_URL ||
  process.env.MONGODB_URL ||
  "mongodb://hot_updater:hot_updater_dev@localhost:27018/hot_updater";

const client = new MongoClient(mongoUrl);

// Connect to MongoDB
await client.connect();

export const db = client.db();

// Cleanup function
export async function closeDatabase() {
  await client.close();
}
