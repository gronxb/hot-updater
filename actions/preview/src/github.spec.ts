import { describe, expect, it, vi } from "vitest";

import { COMMENT_MARKER } from "./comment.mjs";
import { findComment, upsertComment } from "./github.mjs";

type Comment = {
  id: number;
  body: string;
  user: { login: string; type: string };
};

const bot = { login: "github-actions[bot]", type: "Bot" };
const alice = { login: "alice", type: "User" };

/**
 * GitHub's comment API over `pages` of comments: `user` is who `GET /user`
 * names, or null for an app token, which it refuses.
 */
const fakeGitHub = ({
  pages,
  user = null,
  refuse,
}: {
  pages: Comment[][];
  user?: string | null;
  refuse?: "PATCH" | "POST";
}) => {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (method === refuse) {
      return new Response("Resource not accessible by integration", {
        status: 403,
      });
    }
    if (url === "https://api.github.com/user") {
      return user === null
        ? new Response("Resource not accessible by integration", {
            status: 403,
          })
        : Response.json({ login: user });
    }
    const page = /[?&]page=(\d+)/.exec(url)?.[1];
    if (method === "GET") {
      const index = page === undefined ? 0 : Number(page) - 1;
      return Response.json(pages[index] ?? [], {
        headers:
          index + 1 < pages.length
            ? {
                link: `<https://api.github.com/repositories/1/issues/12/comments?per_page=100&page=${index + 2}>; rel="next"`,
              }
            : {},
      });
    }
    return Response.json({ id: 99 }, { status: method === "POST" ? 201 : 200 });
  });
  return {
    calls,
    fetch,
    github: {
      fetch: fetch as unknown as typeof globalThis.fetch,
      apiUrl: "https://api.github.com",
      repository: "octo/app",
      token: "ghs_token",
    },
  };
};

describe("findComment", () => {
  it("finds the bot's marker comment on a later page, past a quote of it and another author's marker comment", async () => {
    const fake = fakeGitHub({
      pages: [
        [
          { id: 1, body: "Looks good", user: alice },
          { id: 2, body: `> ${COMMENT_MARKER}\n> quoted`, user: alice },
          { id: 3, body: `${COMMENT_MARKER}\n\nmine?`, user: alice },
        ],
        [{ id: 4, body: `${COMMENT_MARKER}\n\nold`, user: bot }],
      ],
    });

    await expect(findComment(fake.github, 12)).resolves.toEqual({ id: 4 });
    expect(fake.calls).toEqual([
      "GET https://api.github.com/user",
      "GET https://api.github.com/repos/octo/app/issues/12/comments?per_page=100",
      "GET https://api.github.com/repositories/1/issues/12/comments?per_page=100&page=2",
    ]);
  });

  it("finds a personal access token's own marker comment, not a bot's", async () => {
    const fake = fakeGitHub({
      user: "alice",
      pages: [
        [
          { id: 1, body: `${COMMENT_MARKER}\n\nother`, user: bot },
          { id: 2, body: `${COMMENT_MARKER}\n\nmine`, user: alice },
        ],
      ],
    });

    await expect(findComment(fake.github, 12)).resolves.toEqual({ id: 2 });
  });

  it("finds none when only another author's comments start with the marker", async () => {
    const fake = fakeGitHub({
      pages: [[{ id: 3, body: `${COMMENT_MARKER}\n\nhi`, user: alice }]],
    });

    await expect(findComment(fake.github, 12)).resolves.toBeNull();
  });
});

describe("upsertComment", () => {
  it("edits the action's comment", async () => {
    const fake = fakeGitHub({
      pages: [[{ id: 4, body: `${COMMENT_MARKER}\n\nold`, user: bot }]],
    });

    await expect(
      upsertComment(fake.github, 12, `${COMMENT_MARKER}\n\nnew`),
    ).resolves.toEqual({ id: 4, created: false });
    expect(fake.calls.at(-1)).toBe(
      "PATCH https://api.github.com/repos/octo/app/issues/comments/4",
    );
    expect(fake.fetch.mock.calls.at(-1)![1]).toMatchObject({
      body: JSON.stringify({ body: `${COMMENT_MARKER}\n\nnew` }),
      headers: expect.objectContaining({ authorization: "Bearer ghs_token" }),
    });
  });

  it("comments instead of editing another author's marker comment", async () => {
    const fake = fakeGitHub({
      pages: [[{ id: 3, body: `${COMMENT_MARKER}\n\nhi`, user: alice }]],
    });

    await expect(upsertComment(fake.github, 12, "body")).resolves.toEqual({
      id: 99,
      created: true,
    });
    expect(fake.calls).not.toContainEqual(expect.stringMatching(/^PATCH/));
    expect(fake.calls.at(-1)).toBe(
      "POST https://api.github.com/repos/octo/app/issues/12/comments",
    );
  });

  it("names the permission a refused write needs", async () => {
    const fake = fakeGitHub({ pages: [[]], refuse: "POST" });

    await expect(upsertComment(fake.github, 12, "body")).rejects.toThrow(
      "permissions: pull-requests: write",
    );
  });
});
