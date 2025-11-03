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
  "mongodb://hot_updater:hot_updater_dev@localhost:27018/hot_updater?authSource=admin";

export const client = new MongoClient(mongoUrl);

export const db = client.db();

// Ensure MongoDB connection is established
export async function ensureConnected() {
  try {
    await client.connect();
    console.log("MongoDB connected successfully");
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error);
    throw error;
  }
}

// Cleanup function
export async function closeDatabase() {
  await client.close();
}
