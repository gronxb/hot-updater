import { describe, expect, it } from "vitest";

import { mockStorage } from "./mockStorage";

const stream = (value: string) => new Blob([value]).stream();

describe("mockStorage", () => {
  it("implements an exact stateful object lifecycle", async () => {
    const storage = mockStorage({});
    const sibling = await storage.put({
      key: "releases/bundle.zip.backup",
      body: stream("sibling"),
      contentType: "application/octet-stream",
    });
    const uploaded = await storage.put({
      key: "releases/한글 #%.zip",
      body: stream("bundle"),
      contentLength: 6,
      contentType: "application/zip",
    });

    expect(uploaded).toEqual({
      storageUri: "storage://my-app/releases/%ED%95%9C%EA%B8%80%20%23%25.zip",
    });
    await expect(storage.exists(uploaded)).resolves.toEqual({ exists: true });
    const { response } = await storage.get(uploaded);
    expect(response?.headers.get("content-type")).toBe("application/zip");
    expect(response?.headers.get("content-length")).toBe("6");
    await expect(response?.text()).resolves.toBe("bundle");

    await expect(storage.delete(uploaded)).resolves.toEqual({ deleted: true });
    await expect(storage.delete(uploaded)).resolves.toEqual({ deleted: true });
    await expect(storage.get(uploaded)).resolves.toEqual({ response: null });
    await expect(storage.exists(uploaded)).resolves.toEqual({ exists: false });
    await expect(storage.exists(sibling)).resolves.toEqual({ exists: true });
  });

  it("rejects storage URIs owned by another bucket", async () => {
    const storage = mockStorage({});
    const input = { storageUri: "storage://other/bundle.zip" };

    await expect(storage.get(input)).rejects.toThrow(
      'Bucket name mismatch: expected "my-app"',
    );
    await expect(storage.exists(input)).rejects.toThrow(
      'Bucket name mismatch: expected "my-app"',
    );
    await expect(storage.delete(input)).rejects.toThrow(
      'Bucket name mismatch: expected "my-app"',
    );
  });
});
