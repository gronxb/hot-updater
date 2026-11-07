import crypto from "crypto";
import fs from "fs";

import {
  type CredentialRequest,
  type Credentials,
  p,
  registerSecretValue,
} from "@hot-updater/cli-tools";
import type { NativeBuildAndroidScheme } from "@hot-updater/plugin-core";
import { execa } from "execa";

const API_URL = "https://androidpublisher.googleapis.com";
/** Where Google serves resumable upload sessions, as its docs show both. */
const UPLOAD_ORIGINS = new Set([API_URL, "https://www.googleapis.com"]);
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";

/** Google accepts assertions that expire within an hour. */
const ASSERTION_LIFETIME_SECONDS = 60 * 60;
/** An access token is replaced well before it expires. */
const TOKEN_REUSE_MS = 45 * 60_000;

/** Google asks for multiples of 256 KiB; only one chunk is held in memory. */
const CHUNK_SIZE = 8 * 1024 * 1024;
/** Attempts per chunk, each resuming at the offset Google confirms. */
const CHUNK_ATTEMPTS = 3;
/** Commits while Google is still processing the uploaded bundle. */
const COMMIT_ATTEMPTS = 6;

/** The track `--submit play-internal` releases to. */
const INTERNAL_TRACK = "internal";

const BUNDLE_STILL_PROCESSING =
  "Some of the Android App Bundle uploads are not completed yet";
const NEEDS_CHANGES_NOT_SENT_FOR_REVIEW =
  "Please set the query parameter changesNotSentForReview to true";
const DRAFT_APP_ERRORS = [
  "Only releases with status draft may be created on draft app",
];

interface ServiceAccount {
  readonly clientEmail: string;
  readonly privateKey: crypto.KeyObject;
  readonly tokenUri: string;
}

/** A Google Play Developer API request that failed, with Google's message. */
export class GooglePlayError extends Error {
  readonly status: number;
  readonly apiMessage: string;

  constructor(action: string, status: number, apiMessage: string) {
    super(
      `${action} failed (HTTP ${status})${apiMessage ? `: ${apiMessage}` : "."}`,
    );
    this.name = "GooglePlayError";
    this.status = status;
    this.apiMessage = apiMessage;
  }
}

/**
 * Reads the service account JSON in memory: its private key never touches
 * the disk, and its contents are never echoed.
 */
const readServiceAccount = (json: string): ServiceAccount => {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error("The Play service account is not a JSON key file.");
  }
  const { client_email, private_key, token_uri } = parsed;
  if (typeof client_email !== "string" || typeof private_key !== "string") {
    throw new Error(
      "The Play service account has no client_email or private_key.\nUse the JSON key file Google Cloud creates for it.",
    );
  }
  registerSecretValue(private_key);
  let privateKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey(private_key);
  } catch {
    throw new Error(
      "The Play service account's private_key is no private key.",
    );
  }
  const tokenUri =
    typeof token_uri === "string" ? token_uri : DEFAULT_TOKEN_URI;
  if (new URL(tokenUri).protocol !== "https:") {
    throw new Error(
      "The Play service account's token_uri is not an https URL.",
    );
  }
  return { clientEmail: client_email, privateKey, tokenUri };
};

/** The RS256 JWT a service account exchanges for an access token. */
export const createServiceAccountAssertion = ({
  clientEmail,
  privateKey,
  tokenUri,
  issuedAtSeconds = Math.floor(Date.now() / 1000),
}: ServiceAccount & { issuedAtSeconds?: number }): string => {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: clientEmail,
    scope: SCOPE,
    aud: tokenUri,
    iat: issuedAtSeconds,
    exp: issuedAtSeconds + ASSERTION_LIFETIME_SECONDS,
  })}`;
  const signature = crypto.sign(
    "sha256",
    Buffer.from(signingInput),
    privateKey,
  );
  return `${signingInput}.${signature.toString("base64url")}`;
};

const readApiMessage = async (response: Response): Promise<string> => {
  const body = (await response.json().catch(() => undefined)) as
    | {
        error?: { message?: unknown } | string;
        error_description?: unknown;
      }
    | undefined;
  if (
    typeof body?.error === "object" &&
    typeof body.error.message === "string"
  ) {
    return body.error.message;
  }
  // The token endpoint answers OAuth errors.
  if (typeof body?.error_description === "string") {
    return body.error_description;
  }
  return typeof body?.error === "string" ? body.error : "";
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Google Play refused the upload: it already has a bundle or APK with the
 * `.aab`'s version code, from this or another upload, and takes each version
 * code once.
 */
export class PlayVersionCodeUsedError extends Error {
  override readonly name = "PlayVersionCodeUsedError";

  constructor(options?: ErrorOptions) {
    super(
      "Google Play already has this .aab's version code.\nRaise versionCode for every build you upload.",
      options,
    );
  }
}

/**
 * What Google's message means for the user, for the failures a release to
 * a track runs into.
 */
const explain = (error: unknown, packageName: string): unknown => {
  if (!(error instanceof GooglePlayError)) {
    return error;
  }
  const { status, apiMessage } = error;
  if (status === 401 || /does not have permission/i.test(apiMessage)) {
    return new Error(
      [
        `The Play service account can't release ${packageName}.`,
        "Invite its email in Play Console (Users and permissions) to release to",
        "testing tracks, and enable the Google Play Android Developer API.",
      ].join("\n"),
      { cause: error },
    );
  }
  if (/package not found/i.test(apiMessage)) {
    return new Error(
      `Google Play has no app ${packageName}.\nCreate it in Play Console and upload its first .aab there.`,
      { cause: error },
    );
  }
  if (/version code .*(already been used|already used)/i.test(apiMessage)) {
    return new PlayVersionCodeUsedError({ cause: error });
  }
  return error;
};

/** A Google Play Developer API request, which answers its JSON or throws. */
type PlayRequest = <T>(
  action: string,
  method: string,
  url: string,
  body?: object,
) => Promise<T>;

/**
 * Requests to the Google Play Developer API for `packageName`, as the
 * service account: each carries an access token, exchanged for a signed
 * assertion and replaced well before it expires. `checkPlayAccess`
 * checks a key's access with it too.
 */
export const createPlayClient = ({
  json,
  packageName,
  fetch,
}: {
  json: string;
  packageName: string;
  fetch: typeof globalThis.fetch;
}): {
  /** The app's path under the API. */
  app: string;
  authorization: () => Promise<string>;
  request: PlayRequest;
} => {
  const account = readServiceAccount(json);

  let token: { value: string; issuedAtMs: number } | undefined;
  const authorization = async () => {
    if (!token || Date.now() - token.issuedAtMs >= TOKEN_REUSE_MS) {
      const issuedAtMs = Date.now();
      const assertion = createServiceAccountAssertion(account);
      registerSecretValue(assertion);
      const response = await fetch(account.tokenUri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
      });
      if (!response.ok) {
        throw new Error(
          `Google refused the Play service account (HTTP ${response.status}).\n${(await readApiMessage(response)) || "Check that its key is current and the service account is enabled."}`,
        );
      }
      const { access_token } = (await response.json()) as {
        access_token?: unknown;
      };
      if (typeof access_token !== "string" || !access_token) {
        throw new Error(
          "Google answered the Play service account with no access token.",
        );
      }
      registerSecretValue(access_token);
      token = { value: access_token, issuedAtMs };
    }
    return `Bearer ${token.value}`;
  };

  const app = `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}`;
  const request: PlayRequest = async <T>(
    action: string,
    method: string,
    url: string,
    body?: object,
  ): Promise<T> => {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: await authorization(),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      throw new GooglePlayError(
        action,
        response.status,
        await readApiMessage(response),
      );
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  };

  return { app, authorization, request };
};

/**
 * Play Console's page that invites `email` as a user. `_` stands for the
 * developer account the browser is signed in to, so no ID is needed.
 */
export const playConsoleInviteUrl = (email: string) =>
  `https://play.google.com/console/u/0/developers/_/users-and-permissions?invite=${encodeURIComponent(email)}`;

/**
 * Whether a service account reaches an app in Google Play:
 * - `ready`: it opened an edit of the app;
 * - `denied`: Google Play refused it (401/403), so it needs a Play Console
 *   invite;
 * - `not-found`: Google Play has no such app it can see (404), as before
 *   the app's first `.aab` is uploaded in Play Console;
 * - `refused`: Google's token endpoint refused the key itself, such as a
 *   deleted key, with Google's reason.
 */
export type PlayAccess =
  | { readonly status: "ready" }
  | { readonly status: "denied"; readonly email: string }
  | { readonly status: "not-found"; readonly email: string }
  | {
      readonly status: "refused";
      readonly email: string;
      readonly reason: string;
    };

const readClientEmail = (json: string): string => {
  try {
    const { client_email } = JSON.parse(json) as { client_email?: unknown };
    return typeof client_email === "string" ? client_email : "";
  } catch {
    return "";
  }
};

/**
 * Checks once whether the service account's key reaches `packageName`: it
 * opens an edit of the app and deletes it again, which changes nothing.
 * Throws only for what says nothing about access, such as a network error.
 */
export const checkPlayAccess = async ({
  serviceAccount: { json },
  packageName,
  fetch = globalThis.fetch,
}: {
  serviceAccount: Credentials["play-service-account"];
  packageName: string;
  fetch?: typeof globalThis.fetch;
}): Promise<PlayAccess> => {
  const email = readClientEmail(json);
  const refused = (error: unknown): PlayAccess => ({
    status: "refused",
    email,
    reason: error instanceof Error ? error.message : String(error),
  });
  let play: ReturnType<typeof createPlayClient>;
  try {
    play = createPlayClient({ json, packageName, fetch });
  } catch (error) {
    return refused(error);
  }
  try {
    await play.authorization();
  } catch (error) {
    // No answer from Google says nothing about the key.
    if (error instanceof TypeError) throw error;
    return refused(error);
  }
  const edits = `${API_URL}${play.app}/edits`;
  try {
    const edit = await play.request<{ id?: string }>(
      `Opening an edit of ${packageName}`,
      "POST",
      edits,
      {},
    );
    if (edit?.id) {
      await play
        .request(
          "Deleting the edit",
          "DELETE",
          `${edits}/${encodeURIComponent(edit.id)}`,
        )
        .catch(() => {});
    }
    return { status: "ready" };
  } catch (error) {
    if (error instanceof GooglePlayError) {
      if (error.status === 401 || error.status === 403) {
        return { status: "denied", email };
      }
      if (error.status === 404) return { status: "not-found", email };
    }
    throw error;
  }
};

/**
 * Reads the app in an edit it then deletes, changing nothing.
 */
const readInEdit = async <T>(
  {
    packageName,
    serviceAccount: { json },
    fetch,
  }: {
    packageName: string;
    serviceAccount: Credentials["play-service-account"];
    fetch: typeof globalThis.fetch;
  },
  read: (request: PlayRequest, edit: string) => Promise<T>,
): Promise<T> => {
  const { app, request } = createPlayClient({ json, packageName, fetch });
  let editId: string;
  try {
    ({ id: editId } = await request<{ id: string }>(
      "Opening a Google Play edit",
      "POST",
      `${API_URL}${app}/edits`,
      {},
    ));
  } catch (error) {
    throw explain(error, packageName);
  }
  const edit = `${API_URL}${app}/edits/${encodeURIComponent(editId)}`;
  try {
    return await read(request, edit);
  } catch (error) {
    throw explain(error, packageName);
  } finally {
    await request("Deleting the Google Play edit", "DELETE", edit).catch(
      () => undefined,
    );
  }
};

/**
 * The status of the internal testing release holding `versionCode`, such as
 * `completed` or `draft`, or null when the track doesn't hold it: never
 * uploaded, or replaced by a newer release, which testers get instead.
 */
export const readPlayInternalRelease = ({
  versionCode,
  packageName,
  serviceAccount,
  fetch = globalThis.fetch,
}: {
  versionCode: number;
  /** The application ID the `.aab` was built with. */
  packageName: string;
  serviceAccount: Credentials["play-service-account"];
  fetch?: typeof globalThis.fetch;
}): Promise<string | null> =>
  readInEdit({ packageName, serviceAccount, fetch }, async (request, edit) => {
    const { releases = [] } = await request<{
      releases?: { status?: string; versionCodes?: string[] }[];
    }>("Reading the internal track", "GET", `${edit}/tracks/${INTERNAL_TRACK}`);
    const release = releases.find(({ versionCodes = [] }) =>
      versionCodes.includes(String(versionCode)),
    );
    return release ? (release.status ?? "completed") : null;
  });

/**
 * Whether Google Play's internal testing track already releases the
 * `.aab`'s version code, as when a reused native build was uploaded before.
 */
export const findPlayInternalRelease = async (options: {
  versionCode: number;
  /** The application ID the `.aab` was built with. */
  packageName: string;
  serviceAccount: Credentials["play-service-account"];
  fetch?: typeof globalThis.fetch;
}): Promise<boolean> => (await readPlayInternalRelease(options)) !== null;

/**
 * The highest version code Google Play has taken for the app, on any track,
 * or null with none: a new `.aab` needs one above it.
 */
export const readPlayHighestVersionCode = ({
  packageName,
  serviceAccount,
  fetch = globalThis.fetch,
}: {
  packageName: string;
  serviceAccount: Credentials["play-service-account"];
  fetch?: typeof globalThis.fetch;
}): Promise<number | null> =>
  readInEdit({ packageName, serviceAccount, fetch }, async (request, edit) => {
    const { bundles = [] } = await request<{
      bundles?: { versionCode?: number }[];
    }>("Reading the app's bundles", "GET", `${edit}/bundles`);
    const codes = bundles.flatMap(({ versionCode }) => versionCode ?? []);
    return codes.length > 0 ? Math.max(...codes) : null;
  });

/**
 * The link that opts a tester in to the app's testing tracks. A build on the
 * internal track installs through it, for the testers Play Console lists.
 */
export const playTestingUrl = (packageName: string) =>
  `https://play.google.com/apps/testing/${encodeURIComponent(packageName)}`;

/**
 * The common name of every Android debug certificate: Android Studio's and
 * the Android Gradle plugin's (`CN=Android Debug, O=Android, C=US`), and React
 * Native's template `debug.keystore` (`CN=Android Debug, OU=Android,
 * O=Unknown, …`), as `keytool` prints the owner, whatever the label's
 * language.
 */
const ANDROID_DEBUG_SIGNER = /:\s*CN=Android Debug\s*(?:,|$)/mu;

/**
 * Throws when the `.aab` is signed with the Android debug keystore, which
 * Google Play refuses: a release build type left on `signingConfigs.debug`,
 * as React Native's template ships it. It reads the signer with the JDK's
 * `keytool`, which Gradle needs too; without one it checks nothing.
 */
export const assertPlaySigned = async (aabPath: string): Promise<void> => {
  const { stdout, exitCode } = await execa(
    "keytool",
    // English labels, whatever the machine's locale.
    ["-J-Duser.language=en", "-printcert", "-jarfile", aabPath],
    { reject: false },
  );
  if (exitCode === 0 && ANDROID_DEBUG_SIGNER.test(String(stdout))) {
    throw new Error(
      [
        "Google Play refuses an .aab signed with the Android debug keystore.",
        "Set the scheme's signing.keystore, or a release signingConfig in",
        "android/app/build.gradle, then build again.",
      ].join("\n"),
    );
  }
};

export interface UploadToPlayResult {
  /** The version code Google Play read from the `.aab`. */
  versionCode: number;
  /** The release's status: `draft` on an app Play Console has not published. */
  status: "completed" | "draft";
}

/**
 * Uploads an `.aab` to Google Play's internal testing track with the Google
 * Play Developer API: it opens an edit, uploads the bundle, releases its
 * version code to the internal track, and commits the edit, which it
 * deletes again when any step fails. The service account stays in memory.
 */
export const uploadToPlay = async ({
  aabPath,
  packageName,
  serviceAccount: { json },
  fetch = globalThis.fetch,
  commitRetryDelayMs = 2_000,
}: {
  aabPath: string;
  /** The application ID the `.aab` was built with. */
  packageName: string;
  serviceAccount: Credentials["play-service-account"];
  fetch?: typeof globalThis.fetch;
  /** The first wait before committing again an edit Google is processing. */
  commitRetryDelayMs?: number;
}): Promise<UploadToPlayResult> => {
  const { app, authorization, request } = createPlayClient({
    json,
    packageName,
    fetch,
  });

  let editId: string;
  try {
    ({ id: editId } = await request<{ id: string }>(
      "Opening a Google Play edit",
      "POST",
      `${API_URL}${app}/edits`,
      {},
    ));
  } catch (error) {
    throw explain(error, packageName);
  }
  const edit = `${API_URL}${app}/edits/${encodeURIComponent(editId)}`;

  try {
    p.log.info(`Uploading ${packageName}'s .aab to Google Play`);
    const versionCode = await uploadBundle({
      aabPath,
      sessionUrl: `${API_URL}/upload${app}/edits/${encodeURIComponent(editId)}/bundles?uploadType=resumable`,
      authorization,
      fetch,
    });

    const release = async (status: UploadToPlayResult["status"]) => {
      await request(
        "Releasing to the internal track",
        "PUT",
        `${edit}/tracks/${INTERNAL_TRACK}`,
        {
          track: INTERNAL_TRACK,
          releases: [{ versionCodes: [String(versionCode)], status }],
        },
      );
      await commit({ request, edit, retryDelayMs: commitRetryDelayMs });
    };

    try {
      await release("completed");
      return { versionCode, status: "completed" };
    } catch (error) {
      if (
        !(error instanceof GooglePlayError) ||
        !DRAFT_APP_ERRORS.some((message) => error.apiMessage.includes(message))
      ) {
        throw error;
      }
      p.log.warn(
        `${packageName} isn't published yet, so version code ${versionCode} is a draft.\nRoll it out in Play Console.`,
      );
      await release("draft");
      return { versionCode, status: "draft" };
    }
  } catch (error) {
    // An open edit would hold the uploaded bundle; nothing is released.
    await request("Deleting the Google Play edit", "DELETE", edit).catch(
      () => undefined,
    );
    throw explain(error, packageName);
  }
};

/**
 * Commits the edit, again while Google is still processing the bundle, and
 * with `changesNotSentForReview` when the app's state asks for it. An
 * unanswered commit is reported as unconfirmed, since Google may have
 * applied it.
 */
const commit = async ({
  request,
  edit,
  retryDelayMs,
}: {
  request: <T>(
    action: string,
    method: string,
    url: string,
    body?: object,
  ) => Promise<T>;
  edit: string;
  retryDelayMs: number;
}) => {
  let changesNotSentForReview = false;
  for (let attempt = 1; ; attempt++) {
    try {
      await request(
        "Committing the Google Play edit",
        "POST",
        `${edit}:commit${changesNotSentForReview ? "?changesNotSentForReview=true" : ""}`,
      );
      if (changesNotSentForReview) {
        p.log.warn(
          "Google Play saved the release without sending it for review.\nSend the changes for review in Play Console.",
        );
      }
      return;
    } catch (error) {
      if (
        !(error instanceof GooglePlayError) ||
        error.status >= 500 ||
        error.status === 429
      ) {
        // Google may have applied a commit it did not answer.
        throw new Error(
          [
            "Google Play didn't confirm the release.",
            error instanceof Error ? error.message : String(error),
            "Check internal testing in Play Console before you upload it again.",
          ].join("\n"),
          { cause: error },
        );
      }
      if (error.status !== 400) {
        throw error;
      }
      if (
        !changesNotSentForReview &&
        error.apiMessage.includes(NEEDS_CHANGES_NOT_SENT_FOR_REVIEW)
      ) {
        changesNotSentForReview = true;
        continue;
      }
      if (
        error.apiMessage.includes(BUNDLE_STILL_PROCESSING) &&
        attempt < COMMIT_ATTEMPTS
      ) {
        await sleep(retryDelayMs * 2 ** (attempt - 1));
        continue;
      }
      throw error;
    }
  }
};

/**
 * Uploads the `.aab` in a resumable upload session, one chunk in memory at a
 * time. A chunk that fails without an answer resumes at the offset Google
 * confirms. Returns the bundle's version code.
 */
const uploadBundle = async ({
  aabPath,
  sessionUrl,
  authorization,
  fetch,
}: {
  aabPath: string;
  sessionUrl: string;
  authorization: () => Promise<string>;
  fetch: typeof globalThis.fetch;
}): Promise<number> => {
  const file = await fs.promises.open(aabPath, "r");
  try {
    const { size } = await file.stat();
    if (size === 0) {
      throw new Error("The .aab is empty.");
    }
    const started = await fetch(sessionUrl, {
      method: "POST",
      headers: {
        Authorization: await authorization(),
        "X-Upload-Content-Type": "application/octet-stream",
        "X-Upload-Content-Length": String(size),
      },
    });
    if (!started.ok) {
      throw new GooglePlayError(
        "Starting the .aab upload",
        started.status,
        await readApiMessage(started),
      );
    }
    const location = started.headers.get("location");
    // The session URL carries the upload's authority, so it is never echoed.
    if (!location || !UPLOAD_ORIGINS.has(new URL(location).origin)) {
      throw new Error("Google returned no upload session for the .aab.");
    }

    let offset = 0;
    let failures = 0;
    /**
     * Resumes at the offset Google confirms. Progress starts a new retry
     * budget; an attempt that keeps nothing counts against it.
     */
    const resumeAt = (confirmed: number, reason: string) => {
      if (confirmed > offset) {
        offset = confirmed;
        failures = 0;
        return;
      }
      offset = confirmed;
      if (++failures === CHUNK_ATTEMPTS) {
        throw new Error(`Uploading the .aab failed: ${reason}.`);
      }
    };

    for (;;) {
      const end = Math.min(offset + CHUNK_SIZE, size);
      const body = Buffer.alloc(end - offset);
      const { bytesRead } = await file.read(body, 0, body.length, offset);
      if (bytesRead !== body.length) {
        throw new Error("The .aab changed while it was uploading.");
      }
      const response = await fetch(location, {
        method: "PUT",
        headers: {
          "Content-Range": `bytes ${offset}-${end - 1}/${size}`,
          "Content-Type": "application/octet-stream",
        },
        body,
      }).catch((error: unknown) => error as Error);

      if (!(response instanceof Error) && response.ok) {
        return readVersionCode(response);
      }
      if (!(response instanceof Error) && response.status === 308) {
        resumeAt(confirmedOffset(response), "Google kept none of a chunk");
        if (failures > 0) {
          await sleep(1_000 * failures);
        }
        continue;
      }
      if (
        !(response instanceof Error) &&
        response.status < 500 &&
        response.status !== 429
      ) {
        throw new GooglePlayError(
          "Uploading the .aab",
          response.status,
          await readApiMessage(response),
        );
      }
      await sleep(1_000 * (failures + 1));
      // Ask Google how much it received, which may be all of it, before
      // counting the attempt as failed.
      const status = await fetch(location, {
        method: "PUT",
        headers: { "Content-Range": `bytes */${size}` },
      }).catch(() => undefined);
      if (status?.ok) {
        return readVersionCode(status);
      }
      resumeAt(
        status?.status === 308 ? confirmedOffset(status) : offset,
        response instanceof Error
          ? response.message
          : `HTTP ${response.status}`,
      );
    }
  } finally {
    await file.close();
  }
};

/** The version code of the bundle a finished upload answers with. */
const readVersionCode = async (response: Response): Promise<number> => {
  const { versionCode } = (await response.json()) as { versionCode?: unknown };
  if (typeof versionCode !== "number") {
    throw new Error("Google Play read no version code from the .aab.");
  }
  return versionCode;
};

/**
 * The next offset of a `308 Resume Incomplete`: past its `Range`, which
 * Google sends as `bytes=0-<last>` or `0-<last>`, and 0 without one.
 */
const confirmedOffset = (response: Response) => {
  const range = response.headers.get("range")?.match(/^(?:bytes=)?0-(\d+)$/);
  return range ? Number(range[1]) + 1 : 0;
};

/**
 * The Play service account a scheme's `.aab` uploads with: the
 * `play-service-account` item. It reads only the config, before the native
 * projects are written, and throws for a scheme whose build Google Play
 * would not take as a release: an `.apk`, which Play takes only as an `.aab`
 * from new apps, or a debug variant, which Play refuses.
 */
export const resolvePlayUploadServiceAccount = ({
  scheme,
  androidScheme,
}: {
  /** The scheme's name. */
  scheme: string;
  androidScheme: NativeBuildAndroidScheme;
}): CredentialRequest<"play-service-account"> => {
  if (androidScheme.aab === false) {
    throw new Error(
      `The scheme ${scheme} builds an .apk (aab: false); Google Play takes an .aab.`,
    );
  }
  const variant = androidScheme.variant ?? "Release";
  if (/debug$/i.test(variant)) {
    throw new Error(
      `The scheme ${scheme} builds ${variant}; Google Play takes a release build.`,
    );
  }
  return { kind: "play-service-account", name: "play-service-account" };
};
