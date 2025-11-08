import { expo } from "@hot-updater/expo";
import { supabaseDatabase } from "@hot-updater/supabase";
import { config } from "dotenv";
import { defineConfig, createStoragePlugin } from "hot-updater";

config({ path: ".env.hotupdater" });

/**
 * A simple in-memory mock storage class to demonstrate `createStoragePlugin`.
 * In a real application, this would typically interface with a platform-specific storage
 * like AsyncStorage in React Native or localStorage in the web.
 *
 * By defining methods as arrow functions, we ensure `this` is always bound to the
 * class instance, simplifying its use with `createStoragePlugin`.
 */
class MockAsyncStorage {
  private readonly _data = new Map<string, string>();

  getItem = async (key: string): Promise<string | null> => {
    console.log(`[MockAsyncStorage] getItem: ${key}`);
    return this._data.get(key) || null;
  };

  setItem = async (key: string, value: string): Promise<void> => {
    console.log(`[MockAsyncStorage] setItem: ${key}, ${value}`);
    this._data.set(key, value);
  };

  removeItem = async (key: string): Promise<void> => {
    console.log(`[MockAsyncStorage] removeItem: ${key}`);
    this._data.delete(key);
  };

  getAllKeys = async (): Promise<string[]> => {
    console.log("[MockAsyncStorage] getAllKeys");
    return Array.from(this._data.keys());
  };
}

const mockStorage = new MockAsyncStorage();

export default defineConfig({
  build: expo(),
  // Demonstrate using `createStoragePlugin` with a custom storage solution.
  // We pass methods from our `mockStorage` instance directly. Since they are
  // defined as arrow functions in the class, `this` is already correctly bound.
  storage: createStoragePlugin({
    getItem: mockStorage.getItem,
    setItem: mockStorage.setItem,
    removeItem: mockStorage.removeItem,
    getAllKeys: mockStorage.getAllKeys,
  }),
  database: supabaseDatabase({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
  }),
  updateStrategy: "fingerprint",
  compressStrategy: "zip", // or "tar.br" for better compression
  fingerprint: {
    debug: true,
  },
});