import { createHash } from "node:crypto";

import { vi } from "vitest";

import { COMMENT_MARKER } from "../comment.mjs";

/** Git's object ID of a blob. */
export const gitBlobSha = (content: Buffer) =>
  createHash("sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");

type Tree = Map<string, string>;

/**
 * The parts of GitHub's REST API the preview action calls, in memory: the Git
 * Data API over one repository's refs, trees, and blobs, and the pull request
 * comments. `refuse` answers 403 to every write, as a token without
 * `contents: write` gets. `beforeRefWrite` runs once before the action's ref
 * write lands, as another job's push would. `headSha` is the pull request's
 * head now. `failCommentWrites` answers 502 to every comment write, from the
 * start or from when the returned `failCommentWrites()` is called.
 */
export const fakeGitHub = ({
  apiUrl = "https://api.github.com",
  serverUrl = "https://github.com",
  repository = "octo/app",
  refuse = false,
  beforeRefWrite,
  headSha = "0123456789abcdef",
  failCommentWrites = false,
}: {
  apiUrl?: string;
  serverUrl?: string;
  repository?: string;
  refuse?: boolean;
  beforeRefWrite?: (git: FakeGit) => void;
  headSha?: string;
  failCommentWrites?: boolean;
} = {}) => {
  const git = new FakeGit();
  const calls: string[] = [];
  const comments: { id: number; body: string }[] = [];
  const base = `${apiUrl}/repos/${repository}`;
  let pendingRace = beforeRefWrite;
  let commentWritesFail = failCommentWrites;

  const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.replace(base, "")}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === `${apiUrl}/user`) {
      return new Response("Resource not accessible by integration", {
        status: 403,
      });
    }
    if (url.startsWith(`${base}/pulls/`)) {
      return Response.json({ head: { sha: headSha } });
    }
    if (url.startsWith(`${base}/issues/`)) {
      if (method !== "GET" && commentWritesFail) {
        return new Response("Bad Gateway", { status: 502 });
      }
      if (method === "GET") {
        return Response.json(
          comments.map(({ id, body }) => ({
            id,
            body,
            user: { login: "github-actions[bot]", type: "Bot" },
          })),
        );
      }
      if (method === "POST") {
        comments.push({ id: comments.length + 1, body: body.body });
        return Response.json({ id: comments.length }, { status: 201 });
      }
      const id = Number(url.split("/").pop());
      comments[id - 1]!.body = body.body;
      return Response.json({ id });
    }
    if (method !== "GET" && refuse) {
      return new Response(
        JSON.stringify({ message: "Resource not accessible by integration" }),
        { status: 403 },
      );
    }
    const path = url.slice(`${base}/git/`.length);
    if (method === "GET" && path.startsWith("ref/heads/")) {
      const sha = git.refs.get(path.slice("ref/".length));
      return sha
        ? Response.json({ object: { sha, type: "commit" } })
        : Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (method === "GET" && path.startsWith("commits/")) {
      const sha = path.slice("commits/".length);
      return Response.json({ sha, tree: { sha: git.commits.get(sha)!.tree } });
    }
    if (method === "GET" && path.startsWith("trees/")) {
      // GitHub echoes the SHA it was asked for, a commit's too.
      const sha = path.slice("trees/".length).split("?")[0]!;
      const tree = git.trees.get(git.commits.get(sha)?.tree ?? sha)!;
      return Response.json({
        sha,
        truncated: false,
        tree: [...tree].map(([path, sha]) => ({
          path,
          mode: "100644",
          type: "blob",
          sha,
        })),
      });
    }
    if (method === "POST" && path === "blobs") {
      const content = Buffer.from(body.content, body.encoding);
      const sha = gitBlobSha(content);
      git.blobs.set(sha, content);
      return Response.json({ sha }, { status: 201 });
    }
    if (method === "POST" && path === "trees") {
      const tree: Tree = new Map(
        body.base_tree ? git.trees.get(body.base_tree) : [],
      );
      for (const entry of body.tree) {
        if (entry.sha === null) tree.delete(entry.path);
        else tree.set(entry.path, entry.sha);
      }
      return Response.json({ sha: git.putTree(tree) }, { status: 201 });
    }
    if (method === "POST" && path === "commits") {
      const sha = git.putCommit(body.tree, body.parents, body.message);
      return Response.json({ sha }, { status: 201 });
    }
    if (path.startsWith("refs")) {
      if (pendingRace) {
        const race = pendingRace;
        pendingRace = undefined;
        race(git);
      }
      const ref =
        method === "POST"
          ? String(body.ref).slice("refs/".length)
          : path.slice("refs/".length);
      const current = git.refs.get(ref);
      if (method === "POST" && current) {
        return Response.json(
          { message: "Reference already exists" },
          { status: 422 },
        );
      }
      if (
        method === "PATCH" &&
        !git.commits.get(body.sha)?.parents.includes(current!)
      ) {
        return Response.json(
          { message: "Update is not a fast forward" },
          { status: 422 },
        );
      }
      git.refs.set(ref, body.sha);
      return Response.json({ object: { sha: body.sha } });
    }
    throw new Error(`unexpected ${method} ${url}`);
  });

  return {
    git,
    calls,
    comments,
    github: {
      fetch: fetch as unknown as typeof globalThis.fetch,
      apiUrl,
      serverUrl,
      repository,
      token: "ghs_token",
    },
    /** The files of the branch's head, path to content. */
    files: (branch = "hot-updater-preview") => {
      const head = git.refs.get(`heads/${branch}`);
      if (!head) return null;
      const tree = git.trees.get(git.commits.get(head)!.tree)!;
      return Object.fromEntries(
        [...tree].map(([path, sha]) => [path, git.blobs.get(sha)!]),
      );
    },
    /** Fails every later comment write. */
    failCommentWrites: () => {
      commentWritesFail = true;
    },
    /** Runs `race` once before the next ref write lands. */
    onNextRefWrite: (race: (git: FakeGit) => void) => {
      pendingRace = race;
    },
    /** The action's comment. */
    comment: () =>
      comments.find(({ body }) => body.startsWith(COMMENT_MARKER))?.body,
  };
};

export class FakeGit {
  refs = new Map<string, string>();
  trees = new Map<string, Tree>();
  blobs = new Map<string, Buffer>();
  commits = new Map<
    string,
    { tree: string; parents: string[]; message: string }
  >();

  putTree(tree: Tree) {
    const sha = createHash("sha1")
      .update(JSON.stringify([...tree].sort()))
      .digest("hex");
    this.trees.set(sha, new Map([...tree].sort()));
    return sha;
  }

  putCommit(tree: string, parents: string[], message: string) {
    const sha = createHash("sha1")
      .update(JSON.stringify([tree, parents, message, this.commits.size]))
      .digest("hex");
    this.commits.set(sha, { tree, parents, message });
    return sha;
  }

  /** Another job's push: `files` added on top of the branch's head. */
  push(branch: string, files: Record<string, Buffer>) {
    const head = this.refs.get(`heads/${branch}`)!;
    const tree: Tree = new Map(this.trees.get(this.commits.get(head)!.tree));
    for (const [path, content] of Object.entries(files)) {
      const sha = gitBlobSha(content);
      this.blobs.set(sha, content);
      tree.set(path, sha);
    }
    this.refs.set(
      `heads/${branch}`,
      this.putCommit(this.putTree(tree), [head], "another job"),
    );
  }
}
