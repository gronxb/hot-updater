import { definePlugin, defineTable } from "@hot-updater/plugin-core";

/**
 * A plugin of the example's own, which every managed server here runs: a
 * redeploy bundles the server definition with it and creates its table,
 * and its client endpoint reads that table.
 */
export const sample = () =>
  definePlugin({
    id: "sample",
    schemaVersion: "1",
    schema: {
      notes: defineTable(
        { id: { type: "string", maxLength: 64 }, text: { type: "string" } },
        { key: ["id"] },
      ),
    },
    init: ({ db }) => ({
      api: {
        write: (id: string, text: string) =>
          db.transaction(async (tx) => {
            tx.create("notes", { id, text });
          }),
      },
      endpoints: [
        {
          method: "GET",
          path: "/sample/notes/:id",
          access: "client",
          handler: async (_request, params) => {
            const note = await db.findOne("notes", { id: params["id"]! });
            return note === null
              ? Response.json({ error: "Not found" }, { status: 404 })
              : Response.json({ text: note.text });
          },
        },
      ],
    }),
  });
