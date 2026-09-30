import { describe, expect, it, vi } from "vitest";

import { checkSamplePlugin } from "./sample-plugin-check";

const sample = { id: "sample" };
const insights = { id: "insights" };

describe("checkSamplePlugin", () => {
  it("skips a server that runs no sample plugin, such as a self-hosted one", async () => {
    const write = vi.fn();
    const get = vi.fn();

    await expect(
      checkSamplePlugin({ plugins: undefined, write, get, id: "note-1" }),
    ).resolves.toEqual({
      skipped: "The server definition runs no sample plugin.",
    });
    await expect(
      checkSamplePlugin({ plugins: [insights], write, get, id: "note-1" }),
    ).resolves.toMatchObject({ skipped: expect.any(String) });
    expect(write).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("writes a note through the sample plugin alone and reads it back from the deployed endpoint", async () => {
    const notes = new Map<string, string>();
    const write = vi.fn(
      async (_plugins: readonly unknown[], id: string, text: string) => {
        notes.set(id, text);
      },
    );
    const get = vi
      .fn()
      // The first request lands before the deploy reaches the edge.
      .mockResolvedValueOnce(new Response("Not found", { status: 404 }))
      .mockImplementation(async (path: string) =>
        Response.json({ text: notes.get(path.split("/").pop()!) }),
      );

    await expect(
      checkSamplePlugin({
        plugins: [insights, sample],
        write,
        get,
        id: "note-1",
      }),
    ).resolves.toEqual({ plugin: "sample", id: "note-1", attempts: 2 });
    expect(write).toHaveBeenCalledWith(
      [sample],
      "note-1",
      "Written by the E2E run as note note-1",
    );
    expect(get).toHaveBeenCalledWith("/sample/notes/note-1");
  });

  it("fails when the endpoint answers another note, or never answers", async () => {
    await expect(
      checkSamplePlugin({
        plugins: [sample],
        write: async () => undefined,
        get: async () => Response.json({ text: "someone else's note" }),
        id: "note-1",
      }),
    ).rejects.toThrow(
      'GET /sample/notes/note-1 on the deployed server answered {"text":"someone else\'s note"}, not the note the sample plugin wrote.',
    );
    await expect(
      checkSamplePlugin({
        plugins: [sample],
        write: async () => undefined,
        get: async () => new Response("Forbidden", { status: 403 }),
        id: "note-1",
        attempts: 2,
      }),
    ).rejects.toThrow(
      "The deployed server never served the sample plugin's note: GET /sample/notes/note-1 last answered 403 Forbidden.",
    );
  });
});
