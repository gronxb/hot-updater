// @ts-check

import { COMMENT_MARKER } from "./comment.mjs";

/**
 * @typedef {object} GitHubContext
 * @property {typeof fetch} fetch
 * @property {string} apiUrl `GITHUB_API_URL`, such as https://api.github.com.
 * @property {string} repository `owner/name`.
 * @property {string} token A token that may write pull request comments.
 */

/**
 * @param {GitHubContext} github
 * @param {string} url
 * @param {RequestInit} [init]
 */
const request = async (github, url, init = {}) => {
  const response = await github.fetch(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${github.token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub answered ${response.status} to ${init.method ?? "GET"} ${url}${
        response.status === 403 || response.status === 404
          ? ": give the workflow `permissions: pull-requests: write`. A pull request from a fork gets a read-only token."
          : ""
      }\n${await response.text()}`,
    );
  }
  return response;
};

/** @param {string | null} link */
const nextPage = (link) => /<([^>]+)>;\s*rel="next"/.exec(link ?? "")?.[1];

/**
 * The action's comment on the pull request: the first one whose body starts
 * with the marker. A comment that quotes it starts with `>`.
 *
 * @param {GitHubContext} github
 * @param {number} issueNumber
 * @returns {Promise<{ id: number } | null>}
 */
export const findComment = async (github, issueNumber) => {
  /** @type {string | undefined} */
  let url = `${github.apiUrl}/repos/${github.repository}/issues/${issueNumber}/comments?per_page=100`;
  while (url !== undefined) {
    const response = await request(github, url);
    const comments = /** @type {{ id: number, body?: string }[]} */ (
      await response.json()
    );
    const found = comments.find(({ body }) => body?.startsWith(COMMENT_MARKER));
    if (found) return { id: found.id };
    url = nextPage(response.headers.get("link"));
  }
  return null;
};

/**
 * Replaces the body of the comment `id`.
 *
 * @param {GitHubContext} github
 * @param {number} id
 * @param {string} body
 */
export const updateComment = async (github, id, body) => {
  await request(
    github,
    `${github.apiUrl}/repos/${github.repository}/issues/comments/${id}`,
    { method: "PATCH", body: JSON.stringify({ body }) },
  );
};

/**
 * Writes `body` to the action's comment, or comments it when there is none.
 *
 * @param {GitHubContext} github
 * @param {number} issueNumber
 * @param {string} body
 * @returns {Promise<{ id: number, created: boolean }>}
 */
export const upsertComment = async (github, issueNumber, body) => {
  const existing = await findComment(github, issueNumber);
  if (existing) {
    await updateComment(github, existing.id, body);
    return { id: existing.id, created: false };
  }
  const response = await request(
    github,
    `${github.apiUrl}/repos/${github.repository}/issues/${issueNumber}/comments`,
    { method: "POST", body: JSON.stringify({ body }) },
  );
  const { id } = /** @type {{ id: number }} */ (await response.json());
  return { id, created: true };
};
