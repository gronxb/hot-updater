/** The repository an adapter keeps its data in, and how it reaches GitHub. */
export interface GithubRepositoryOptions {
  readonly owner: string;
  readonly repo: string;
  /**
   * A token that reads the repository's contents, and writes them where the
   * adapter uploads or commits. A fine-grained token limited to this one
   * repository keeps a leaked token from reading anything else.
   */
  readonly token: string;
  /** GitHub's REST API; set it for GitHub Enterprise Server. */
  readonly apiUrl?: string;
  /** GitHub's upload host for release assets; set it for GitHub Enterprise Server. */
  readonly uploadUrl?: string;
  /** The fetch every request uses. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

/** A GitHub response the adapter cannot continue from. */
export class GithubRequestError extends Error {
  readonly name = "GithubRequestError";

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface GithubRequestInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: RequestInit["body"];
  readonly redirect?: RequestInit["redirect"];
}

export interface GithubClient {
  /** `owner.repo`, the bucket of the repository's storage URIs. */
  readonly bucket: string;
  /** The URL of a REST path below the repository, such as `/releases`. */
  repoUrl(path: string): string;
  /** The URL of a path below the repository on the upload host. */
  uploadUrl(path: string): string;
  /** A request that carries the token. */
  request(url: string, init?: GithubRequestInit): Promise<Response>;
  /** A request without the token, for URLs GitHub has already signed. */
  fetch(url: string): Promise<Response>;
}

const trimSlash = (url: string) => url.replace(/\/+$/u, "");

export const createGithubClient = (
  options: GithubRepositoryOptions,
): GithubClient => {
  const { owner, repo, token } = options;
  if (!owner || !repo || !token) {
    throw new Error("GitHub owner, repo, and token are required.");
  }
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const api = trimSlash(options.apiUrl ?? "https://api.github.com");
  const uploads = trimSlash(options.uploadUrl ?? "https://uploads.github.com");
  // Read per call, so a global `fetch` replaced after startup is the one used.
  const fetchImpl: typeof fetch = (input, init) =>
    (options.fetch ?? fetch)(input, init);

  return {
    bucket: `${owner}.${repo}`,
    repoUrl: (path) => `${api}${repoPath}${path}`,
    uploadUrl: (path) => `${uploads}${repoPath}${path}`,
    request: (url, init = {}) =>
      fetchImpl(url, {
        method: init.method ?? "GET",
        redirect: init.redirect,
        body: init.body,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...init.headers,
          authorization: `Bearer ${token}`,
        },
      }),
    fetch: (url) => fetchImpl(url),
  };
};

/** The error of a response GitHub refused, with GitHub's own message. */
export const githubError = async (
  response: Response,
  action: string,
): Promise<GithubRequestError> => {
  let detail = response.statusText;
  try {
    const body: unknown = await response.json();
    const message = (body as { message?: unknown } | null)?.message;
    if (typeof message === "string" && message.length > 0) detail = message;
  } catch {
    // The status alone names a response without a JSON body.
  }
  return new GithubRequestError(
    `GitHub could not ${action}: ${response.status} ${detail}`.trim(),
    response.status,
  );
};

/** Each path segment encoded on its own, so `/` keeps separating them. */
export const encodePath = (path: string): string =>
  path.split("/").map(encodeURIComponent).join("/");
