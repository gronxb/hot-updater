import { encodePath, type GithubClient, githubError } from "./githubApi";

/** Where a JSON file lives in the repository. */
export interface GithubJsonFileLocation {
  /** The file's path in the repository. */
  readonly path: string;
  /** The branch that holds the file. Defaults to the repository's default branch. */
  readonly branch?: string;
  /**
   * How long a read may answer from the copy this process last fetched, in
   * milliseconds. 0, the default, revalidates every read with GitHub; a
   * write always starts from a fresh copy.
   */
  readonly cacheTtlMs?: number;
}

export interface GithubJsonFileOptions<T> extends GithubJsonFileLocation {
  readonly client: GithubClient;
  /** The state of a file that does not exist yet. */
  readonly empty: () => T;
  /** Checks a parsed file's data, and throws when it is not this file's. */
  readonly parse: (data: unknown) => T;
}

/** What a mutation makes of a state: `next` when it changes it, and its result. */
export interface JsonFileMutation<T, R> {
  readonly next?: T;
  readonly result: R;
}

/**
 * One JSON file in a repository, read with conditional requests and written
 * with the Contents API's `sha`, GitHub's compare-and-swap: a write names the
 * blob it replaces, and GitHub refuses it when the file has changed since.
 */
export interface GithubJsonFile<T> {
  read(): Promise<T>;
  /**
   * Applies `mutate` to the file's current state and commits what it
   * returns. Mutations queued while a commit is in flight share the next
   * commit. `mutate` runs again on a fresh state when another writer
   * committed first, so it must not change the state it receives.
   */
  update<R>(mutate: (state: T) => JsonFileMutation<T, R>): Promise<R>;
  /** Creates the file when it does not exist. */
  ensure(): Promise<void>;
}

/** Every attempt of a write lost to another writer. */
export class GithubWriteConflictError extends Error {
  readonly name = "GithubWriteConflictError";
}

interface Snapshot<T> {
  readonly state: T;
  /** The file's text; null when the file does not exist. */
  readonly text: string | null;
  /** Rises by one with every commit, so an older copy is told apart. */
  readonly revision: number;
  readonly etag?: string;
  readonly sha?: string;
  readonly at: number;
}

interface Job<T> {
  readonly mutate: (state: T) => JsonFileMutation<T, unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

const MAX_ATTEMPTS = 8;

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
};

/** The SHA-1 git names a blob of `text` by, which a Contents API write compares. */
const gitBlobSha = async (text: string): Promise<string> => {
  const utf8 = new TextEncoder();
  const content = utf8.encode(text);
  const header = utf8.encode(`blob ${content.length}\0`);
  const blob = new Uint8Array(header.length + content.length);
  blob.set(header);
  blob.set(content, header.length);
  const digest = await crypto.subtle.digest("SHA-1", blob);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export const createGithubJsonFile = <T>(
  options: GithubJsonFileOptions<T>,
): GithubJsonFile<T> => {
  const { client, path, branch, empty, parse } = options;
  const cacheTtlMs = options.cacheTtlMs ?? 0;
  const url = client.repoUrl(`/contents/${encodePath(path)}`);
  const readUrl =
    branch === undefined ? url : `${url}?ref=${encodeURIComponent(branch)}`;

  let snapshot: Snapshot<T> | undefined;
  let loading: Promise<Snapshot<T>> | undefined;
  const queue: Job<T>[] = [];
  let flushing = false;

  const fetchSnapshot = async (): Promise<Snapshot<T>> => {
    const known = snapshot;
    const response = await client.request(readUrl, {
      headers: {
        accept: "application/vnd.github.raw+json",
        ...(known?.etag === undefined ? {} : { "if-none-match": known.etag }),
      },
    });
    const at = Date.now();
    if (response.status === 304 && known !== undefined) {
      return { ...known, at };
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return { state: empty(), text: null, revision: 0, at };
    }
    if (!response.ok) throw await githubError(response, `read ${path}`);
    const text = await response.text();
    let file: { revision?: unknown; data?: unknown };
    try {
      file = JSON.parse(text);
    } catch {
      throw new Error(`${path} in ${client.bucket} is not valid JSON.`);
    }
    if (typeof file?.revision !== "number") {
      throw new Error(`${path} in ${client.bucket} is not a Hot Updater file.`);
    }
    // GitHub can answer with the file as it was before this process's last
    // commit for a moment. The copy with the higher revision is the newer.
    if (known !== undefined && file.revision < known.revision) {
      return { ...known, at };
    }
    return {
      state: parse(file.data),
      text,
      revision: file.revision,
      etag: response.headers.get("etag") ?? undefined,
      at,
    };
  };

  const load = (fresh: boolean): Promise<Snapshot<T>> => {
    if (
      !fresh &&
      snapshot !== undefined &&
      Date.now() - snapshot.at < cacheTtlMs
    ) {
      return Promise.resolve(snapshot);
    }
    loading ??= fetchSnapshot()
      .then((next) => {
        snapshot = next;
        return next;
      })
      .finally(() => {
        loading = undefined;
      });
    return loading;
  };

  /** Commits `state` over `base`; false when another writer committed first. */
  const commit = async (base: Snapshot<T>, state: T): Promise<boolean> => {
    const revision = base.revision + 1;
    const text = JSON.stringify({ revision, data: state });
    const sha =
      base.text === null
        ? undefined
        : (base.sha ?? (await gitBlobSha(base.text)));
    const response = await client.request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: `chore(hot-updater): update ${path}`,
        content: toBase64(new TextEncoder().encode(text)),
        ...(sha === undefined ? {} : { sha }),
        ...(branch === undefined ? {} : { branch }),
      }),
    });
    // 409: the file changed since `sha`. 422 without a `sha`: the file was
    // created since this process read that it was missing.
    if (
      response.status === 409 ||
      (response.status === 422 && sha === undefined)
    ) {
      await response.body?.cancel();
      return false;
    }
    if (!response.ok) throw await githubError(response, `write ${path}`);
    const body = (await response.json()) as {
      content?: { sha?: unknown } | null;
    };
    const written = body.content?.sha;
    snapshot = {
      state,
      text,
      revision,
      sha: typeof written === "string" ? written : undefined,
      at: Date.now(),
    };
    return true;
  };

  /** Runs one batch of mutations to a commit, or to their errors. */
  const run = async (jobs: readonly Job<T>[]): Promise<void> => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(Math.random() * 50 * 2 ** attempt);
      const base = await load(true);
      let state = base.state;
      const settle: (() => void)[] = [];
      for (const job of jobs) {
        try {
          const { next, result } = job.mutate(state);
          if (next !== undefined) state = next;
          settle.push(() => job.resolve(result));
        } catch (error) {
          settle.push(() => job.reject(error));
        }
      }
      if (state === base.state || (await commit(base, state))) {
        for (const done of settle) done();
        return;
      }
    }
    throw new GithubWriteConflictError(
      `${path} in ${client.bucket} kept changing; the write was not applied.`,
    );
  };

  const flush = async (): Promise<void> => {
    if (flushing) return;
    flushing = true;
    try {
      while (queue.length > 0) {
        const jobs = queue.splice(0);
        try {
          await run(jobs);
        } catch (error) {
          for (const job of jobs) job.reject(error);
        }
      }
    } finally {
      flushing = false;
    }
  };

  return {
    read: async () => (await load(false)).state,
    update: <R>(mutate: (state: T) => JsonFileMutation<T, R>) =>
      new Promise<R>((resolve, reject) => {
        queue.push({
          mutate,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        void flush();
      }),
    async ensure() {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const base = await load(true);
        if (base.text !== null || (await commit(base, base.state))) return;
      }
      throw new GithubWriteConflictError(
        `${path} in ${client.bucket} could not be created.`,
      );
    },
  };
};
