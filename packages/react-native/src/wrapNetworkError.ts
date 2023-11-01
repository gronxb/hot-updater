import { HotUpdaterError } from "./error";

export async function wrapNetworkError<T>(
  metadata: (() => Promise<T>) | (() => T)
): Promise<T> {
  try {
    return await metadata();
  } catch (error) {
    throw new HotUpdaterError("HotUpdater metadata is not defined");
  }
}
