import { MongoClient } from "mongodb";

// Use TEST_MONGODB_URL for testing (from CI), otherwise use default local URL
const mongoUrl =
  process.env.TEST_MONGODB_URL ||
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
