// @ts-check

import { createHash } from "node:crypto";

import { qrCodePng } from "../../shared/qrCode.mjs";
import { request } from "./github.mjs";

/**
 * The branch that holds the comments' QR codes, an orphan branch with one
 * folder per pull request. GitHub fetches a comment's images from the
 * internet, so a Console behind a VPN can't serve them; the repository can,
 * to anyone who can read it.
 */
export const QR_BRANCH = "hot-updater-preview";

const REF = `heads/${QR_BRANCH}`;

const README = `# ${QR_BRANCH}

The QR codes of pull request previews, which the hot-updater preview action
writes for its comments. Each \`pr-<number>\` folder holds one pull request's,
and goes when the pull request closes.
`;

const PERMISSION = `give the workflow "permissions: contents: write", and let it create the ${QR_BRANCH} branch.`;

/** Ref writes another job can beat, each followed by a fresh read. */
const ATTEMPTS = 10;

/**
 * @typedef {import("./github.mjs").GitHubContext} GitHubContext
 * @typedef {{ sleep?: (ms: number) => Promise<void> }} Options
 */

/** @param {number} ms */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {string} value */
const fileName = (value) =>
  `${createHash("sha256").update(value).digest("hex").slice(0, 16)}.png`;

/** @param {Buffer} content */
const blobSha = (content) =>
  createHash("sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");

/**
 * @param {GitHubContext} github
 * @param {string} path
 * @param {unknown} [body]
 * @param {{ method?: string, allow?: number[] }} [options]
 */
const git = async (github, path, body, { method, allow } = {}) => {
  const response = await request(
    github,
    `${github.apiUrl}/repos/${github.repository}/git/${path}`,
    {
      method: method ?? (body === undefined ? "GET" : "POST"),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { permission: PERMISSION, allow },
  );
  /** @type {any} GitHub's JSON, which the Git Data API documents. */
  const json = await response.json();
  return { status: response.status, json };
};

/**
 * Makes the pull request's folder hold exactly `files`, on top of the
 * branch's head, or as the branch's first commit. A ref write that another
 * job's push beat reads the branch again and tries again, so jobs of
 * different pull requests keep each other's folders.
 *
 * @param {GitHubContext} github
 * @param {number} number
 * @param {Map<string, Buffer>} files Name to content.
 * @param {Options} options
 */
const syncFolder = async (github, number, files, { sleep = wait }) => {
  const folder = `pr-${number}`;
  /** @type {Map<string, Buffer>} */
  const wanted = new Map(
    [...files].map(([name, content]) => [`${folder}/${name}`, content]),
  );
  for (let attempt = 1; ; attempt++) {
    const ref = await git(github, `ref/${REF}`, undefined, { allow: [404] });
    const head = ref.status === 404 ? null : String(ref.json.object.sha);
    /** @type {Map<string, string>} */
    const current = new Map();
    let baseTree = null;
    if (head !== null) {
      const commit = await git(github, `commits/${head}`);
      baseTree = String(commit.json.tree.sha);
      const tree = await git(github, `trees/${baseTree}?recursive=1`);
      for (const { path, type, sha } of tree.json.tree) {
        if (type === "blob" && path.startsWith(`${folder}/`)) {
          current.set(path, sha);
        }
      }
    }
    /** @type {{ path: string, mode: "100644", type: "blob", sha: string | null }[]} */
    const entries = [...current.keys()]
      .filter((path) => !wanted.has(path))
      .map((path) => ({ path, mode: "100644", type: "blob", sha: null }));
    const added = [...wanted].filter(
      ([path, content]) => current.get(path) !== blobSha(content),
    );
    if (head === null) added.push(["README.md", Buffer.from(README)]);
    if (
      entries.length === 0 &&
      (head === null ? wanted.size === 0 : added.length === 0)
    ) {
      return;
    }
    for (const [path, content] of added) {
      const blob = await git(github, "blobs", {
        content: content.toString("base64"),
        encoding: "base64",
      });
      entries.push({ path, mode: "100644", type: "blob", sha: blob.json.sha });
    }
    const tree = await git(github, "trees", {
      ...(baseTree === null ? {} : { base_tree: baseTree }),
      tree: entries,
    });
    const commit = await git(github, "commits", {
      message: `Preview QR codes of #${number}`,
      tree: tree.json.sha,
      parents: head === null ? [] : [head],
    });
    const sha = String(commit.json.sha);
    const allow = attempt < ATTEMPTS ? [422] : [];
    const written =
      head === null
        ? await git(github, "refs", { ref: `refs/${REF}`, sha }, { allow })
        : await git(
            github,
            `refs/${REF}`,
            { sha, force: false },
            {
              method: "PATCH",
              allow,
            },
          );
    if (written.status !== 422) return;
    await sleep(attempt * 200 + Math.floor(Math.random() * 300));
  }
};

/**
 * Writes the QR code of each value to the pull request's folder on
 * {@link QR_BRANCH}, which then holds only these, and returns each value's
 * image URL, which GitHub shows to anyone who can read the repository.
 *
 * @param {GitHubContext} github
 * @param {number} number The pull request's.
 * @param {string[]} values What each QR code holds.
 * @param {Options} [options]
 * @returns {Promise<Record<string, string>>}
 */
export const writeQrCodes = async (github, number, values, options = {}) => {
  const names = new Map(values.map((value) => [value, fileName(value)]));
  await syncFolder(
    github,
    number,
    new Map([...names].map(([value, name]) => [name, qrCodePng(value)])),
    options,
  );
  const base = `${github.serverUrl.replace(/\/+$/, "")}/${github.repository}/raw/${QR_BRANCH}/pr-${number}`;
  return Object.fromEntries(
    [...names].map(([value, name]) => [value, `${base}/${name}`]),
  );
};

/**
 * Removes the pull request's folder from {@link QR_BRANCH}.
 *
 * @param {GitHubContext} github
 * @param {number} number
 * @param {Options} [options]
 */
export const removeQrCodes = (github, number, options = {}) =>
  syncFolder(github, number, new Map(), options);
