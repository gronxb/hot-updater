import { describe, expect, it, vi } from "vitest";

import { COMMENT_MARKER } from "./comment.mjs";
import { upsertComment } from "./github.mjs";

const github = (fetch: ReturnType<typeof vi.fn>) => ({
  fetch: fetch as unknown as typeof globalThis.fetch,
  apiUrl: "https://api.github.com",
  repository: "octo/app",
  token: "ghs_token",
});

describe("upsertComment", () => {
  it("edits the comment that starts with the marker, on a later page, ignoring one that quotes it", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          [
            { id: 1, body: "Looks good" },
            { id: 2, body: `> ${COMMENT_MARKER}\n> quoted` },
          ],
          {
            headers: {
              link: '<https://api.github.com/repositories/1/issues/12/comments?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/1/issues/12/comments?per_page=100&page=2>; rel="last"',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        Response.json([{ id: 3, body: `${COMMENT_MARKER}\n\nold` }]),
      )
      .mockResolvedValueOnce(Response.json({ id: 3 }));

    await expect(
      upsertComment(github(fetch), 12, `${COMMENT_MARKER}\n\nnew`),
    ).resolves.toEqual({ id: 3, created: false });

    expect(
      fetch.mock.calls.map(([url, init]) => [init?.method ?? "GET", url]),
    ).toEqual([
      [
        "GET",
        "https://api.github.com/repos/octo/app/issues/12/comments?per_page=100",
      ],
      [
        "GET",
        "https://api.github.com/repositories/1/issues/12/comments?per_page=100&page=2",
      ],
      ["PATCH", "https://api.github.com/repos/octo/app/issues/comments/3"],
    ]);
    expect(fetch.mock.calls[2]![1]).toMatchObject({
      body: JSON.stringify({ body: `${COMMENT_MARKER}\n\nnew` }),
      headers: expect.objectContaining({ authorization: "Bearer ghs_token" }),
    });
  });

  it("comments when the pull request has no comment of the action's", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json([{ id: 1, body: "Looks good" }]))
      .mockResolvedValueOnce(Response.json({ id: 7 }, { status: 201 }));

    await expect(upsertComment(github(fetch), 12, "body")).resolves.toEqual({
      id: 7,
      created: true,
    });
    expect(fetch).toHaveBeenLastCalledWith(
      "https://api.github.com/repos/octo/app/issues/12/comments",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("names the permission a refused write needs", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(
        new Response("Resource not accessible by integration", { status: 403 }),
      );

    await expect(upsertComment(github(fetch), 12, "body")).rejects.toThrow(
      "permissions: pull-requests: write",
    );
  });
});
