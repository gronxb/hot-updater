import crypto from "crypto";
import fs from "fs";
import path from "path";

import {
  type CredentialRequest,
  type Credentials,
  getCwd,
  p,
  parseSecretReference,
  registerSecretValue,
} from "@hot-updater/cli-tools";
import type { NativeBuildIosScheme } from "@hot-updater/plugin-core";

import type { EnrichedNativeBuildIosScheme } from "./utils/enrichNativeBuildIosScheme";
import { readIpaInfo } from "./utils/readIpaInfo";
import {
  APP_STORE_EXPORT_METHODS,
  readExportMethod,
} from "./utils/xcodeSigning";

const API_URL = "https://api.appstoreconnect.apple.com";

/** Apple accepts tokens that expire within 20 minutes. */
const TOKEN_LIFETIME_SECONDS = 20 * 60;
/** A token is replaced well before it expires, so no request carries a stale one. */
const TOKEN_REUSE_SECONDS = 10 * 60;

/** The parts of an `.ipa` sent at once. */
const UPLOAD_CONCURRENCY = 4;
/** Attempts to create the build upload and to commit the uploaded `.ipa`. */
const COMMIT_ATTEMPTS = 3;
/** Attempts per part: a part is a plain PUT, safe to repeat. */
const UPLOAD_ATTEMPTS = 3;

const IN_PROGRESS_STATES = new Set(["AWAITING_UPLOAD", "PROCESSING"]);

/** The error App Store Connect answers with when a build number is taken. */
const DUPLICATE_ERROR_CODE = "ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE";

type AppStoreConnectApiKey = Credentials["asc-api-key"];

interface ApiError {
  readonly status?: string;
  readonly code?: string;
  readonly title?: string;
  readonly detail?: string;
}

interface StateDetail {
  readonly code?: string;
  readonly description?: string;
}

interface UploadOperation {
  readonly method: string;
  readonly url: string;
  readonly offset: number;
  readonly length: number;
  readonly requestHeaders?: readonly { name: string; value: string }[];
}

interface BuildUploadState {
  readonly state?: string;
  readonly errors?: readonly StateDetail[];
  readonly warnings?: readonly StateDetail[];
  readonly infos?: readonly StateDetail[];
}

/** An App Store Connect API request that failed, with the errors it answered. */
export class AppStoreConnectError extends Error {
  readonly status: number;
  readonly errors: readonly ApiError[];
  /** The answer's `Retry-After` header, for a rate limit. */
  readonly retryAfter: string | null;

  constructor(
    action: string,
    status: number,
    errors: readonly ApiError[],
    retryAfter: string | null = null,
  ) {
    const details = errors
      .map((error) => error.detail ?? error.title ?? error.code)
      .filter(Boolean);
    super(
      `${action} failed (HTTP ${status})${details.length > 0 ? `: ${details.join(" ")}` : "."}`,
    );
    this.name = "AppStoreConnectError";
    this.status = status;
    this.errors = errors;
    this.retryAfter = retryAfter;
  }
}

/**
 * An App Store Connect API token: an ES256 JWT, whose signature JWS encodes
 * as the raw 64-byte r || s, not the DER Node signs by default.
 */
export const createAppStoreConnectToken = ({
  privateKey,
  keyId,
  issuerId,
  issuedAtSeconds = Math.floor(Date.now() / 1000),
}: {
  privateKey: crypto.KeyObject;
  keyId: string;
  issuerId: string;
  issuedAtSeconds?: number;
}): string => {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "ES256", kid: keyId, typ: "JWT" })}.${encode(
    {
      iss: issuerId,
      iat: issuedAtSeconds,
      exp: issuedAtSeconds + TOKEN_LIFETIME_SECONDS,
      aud: "appstoreconnect-v1",
    },
  )}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
};

const readPrivateKey = async (keyPath: string) => {
  try {
    return crypto.createPrivateKey(
      await fs.promises.readFile(keyPath, "utf-8"),
    );
  } catch {
    // The key's contents are not echoed.
    throw new Error("The App Store Connect API key is not a .p8 private key.");
  }
};

const readApiErrors = async (response: Response): Promise<ApiError[]> => {
  const body = (await response.json().catch(() => undefined)) as
    | { errors?: unknown }
    | undefined;
  return Array.isArray(body?.errors) ? (body.errors as ApiError[]) : [];
};

const describeDetails = (details: readonly StateDetail[]) =>
  details.map(
    (detail) =>
      `${detail.description ?? "(no description)"}${detail.code ? ` (${detail.code})` : ""}`,
  );

/** Answers a request may outlive: a timeout, a rate limit, a server error. */
const isRetryableStatus = (status: number) =>
  status === 408 || status === 429 || status >= 500;

/**
 * Whether a request may succeed when sent again: a retryable answer, or a
 * network failure, which fetch rejects with a TypeError. A refused key or
 * request is not.
 */
const isRetryable = (error: unknown) =>
  error instanceof AppStoreConnectError
    ? isRetryableStatus(error.status)
    : error instanceof TypeError;

/** Whether App Store Connect refused a request for its rate limit only. */
const isRateLimited = (error: unknown) =>
  error instanceof AppStoreConnectError && error.status === 429;

/**
 * Runs `request`, again after a failure `retryable` accepts, up to the
 * attempts.
 */
const retrying = async <T>(
  request: () => Promise<T>,
  retryable: (error: unknown) => boolean = isRetryable,
): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      if (!retryable(error) || attempt === COMMIT_ATTEMPTS) {
        throw error;
      }
      await sleep(retryDelayMs(error, attempt));
    }
  }
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The longest wait before a retry, so a run stays bounded. */
const MAX_RETRY_DELAY_MS = 60_000;
/**
 * The first wait after a rate limit without `Retry-After`: App Store Connect
 * limits a key per rolling hour, so a retry within seconds meets it again.
 */
const RATE_LIMIT_DELAY_MS = 15_000;

/**
 * How long to wait before sending a request again after `failure`, an
 * answer or the error it raised: the `Retry-After` seconds it asks for, a
 * longer backoff for a rate limit without one, and else a growing backoff,
 * all within a bound.
 */
const retryDelayMs = (failure: unknown, attempt: number) => {
  const { status, retryAfter } =
    failure instanceof Response
      ? {
          status: failure.status,
          retryAfter: failure.headers.get("retry-after"),
        }
      : failure instanceof AppStoreConnectError
        ? failure
        : { status: 0, retryAfter: null };
  const seconds =
    retryAfter === null || retryAfter.trim() === ""
      ? Number.NaN
      : Number(retryAfter);
  const delay =
    Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1_000
      : status === 429
        ? RATE_LIMIT_DELAY_MS * attempt
        : 1_000 * attempt;
  return Math.min(delay, MAX_RETRY_DELAY_MS);
};

/**
 * Runs `run` over `items`, at most `concurrency` at a time. After the first
 * failure no item starts, and it throws that failure once every running item
 * has settled, so nothing is still sending when the caller cleans up.
 */
const runConcurrently = async <T>(
  items: readonly T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<void>,
) => {
  let next = 0;
  let failure: { error: unknown } | undefined;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!failure && next < items.length) {
        const index = next++;
        try {
          await run(items[index]!, index);
        } catch (error) {
          failure ??= { error };
        }
      }
    }),
  );
  if (failure) {
    throw failure.error;
  }
};

/**
 * A signing build setting's assignment: the key, any conditions such as
 * `[sdk=iphoneos*]`, and the value, without a trailing comment.
 */
const SIGNING_SETTING =
  /^\s*(CODE_SIGNING_ALLOWED|CODE_SIGNING_REQUIRED)((?:\[[^\]]*\])*)\s*=\s*([^\s/]*)\s*(?:\/\/.*)?$/u;

/**
 * Each signing setting's last unconditional value and where it was set,
 * and the settings some condition also sets, whose value for the device
 * archive the config alone can't tell.
 */
interface SigningSettings {
  readonly values: Map<string, { value: string; where: string }>;
  readonly conditional: Set<string>;
}

/** A scheme's `exportOptionsPlist`, which resolves from the project's root. */
const schemeFile = (file: string) =>
  path.isAbsolute(file) ? file : path.resolve(getCwd(), file);

/** Applies one assignment, as Xcode does: the last unconditional one wins. */
const applySetting = (
  settings: SigningSettings,
  line: string,
  label: string,
) => {
  const [, key, conditions, value] = line.match(SIGNING_SETTING) ?? [];
  if (!key) return;
  if (conditions) settings.conditional.add(key);
  else
    settings.values.set(key, {
      value: value!,
      where: `${line.trim()} in ${label}`,
    });
};

/**
 * Applies an xcconfig's signing settings over `settings`, in order,
 * following its `#include`s, which resolve from the including file, as
 * Xcode reads it. A file included again applies again; only an include
 * cycle (`including`) stops.
 */
const applyXcconfig = async (
  file: string,
  label: string,
  settings: SigningSettings,
  including: Set<string>,
) => {
  if (including.has(file)) return;
  including.add(file);
  const text = await fs.promises.readFile(file, "utf-8").catch(() => undefined);
  for (const line of text?.split("\n") ?? []) {
    const include = line.match(/^\s*#include\??\s*"([^"]+)"/u)?.[1];
    if (include) {
      await applyXcconfig(
        path.resolve(path.dirname(file), include),
        include,
        settings,
        including,
      );
    } else {
      applySetting(settings, line, label);
    }
  }
  including.delete(file);
};

/**
 * Where the scheme turns code signing off, after every override the build
 * applies: the `extraParams` settings first, then the xcconfigs the build
 * xcconfig includes over them, in order, its `xcconfig` and each
 * `-xcconfig` in `extraParams`, which resolve from `ios/`, where xcodebuild
 * runs (`writeBuildXcconfig`). Undefined when it signs, or when a
 * conditional setting, such as `[sdk=iphoneos*]`, may decide: the build
 * does.
 */
const codeSigningOff = async (iosScheme: NativeBuildIosScheme) => {
  const extraParams = iosScheme.extraParams ?? [];
  const settings: SigningSettings = {
    values: new Map(),
    conditional: new Set(),
  };
  for (const entry of extraParams) applySetting(settings, entry, "extraParams");
  const xcconfigs = [
    ...(iosScheme.xcconfig ? [iosScheme.xcconfig] : []),
    ...extraParams.flatMap((entry, index) =>
      entry === "-xcconfig" && index + 1 < extraParams.length
        ? [extraParams[index + 1]!]
        : [],
    ),
  ];
  for (const xcconfig of xcconfigs) {
    await applyXcconfig(
      path.resolve(getCwd(), "ios", xcconfig),
      xcconfig,
      settings,
      new Set(),
    );
  }
  for (const [key, { value, where }] of settings.values) {
    if (/^no$/iu.test(value) && !settings.conditional.has(key)) return where;
  }
  return undefined;
};

/**
 * The App Store Connect API key a scheme's `.ipa` uploads with: the
 * `signing.ascApiKey` it signs with, or else the `asc-api-key` item. It reads
 * the config, and the scheme's files that exist before the native projects
 * are written, and throws, saying why, for a scheme whose build App Store
 * Connect would not take: a simulator `.app`, a Debug configuration, which
 * loads its JavaScript from Metro, code signing turned off, an
 * `.xcarchive` it cannot export, or export options of another method. An
 * `exportOptionsPlist` the adapter's prebuild writes later is checked after
 * it (`assertTestFlightExportOptions`).
 */
export const resolveTestFlightUploadKey = async ({
  scheme,
  iosScheme,
}: {
  /** The scheme's name. */
  scheme: string;
  iosScheme: NativeBuildIosScheme;
}): Promise<CredentialRequest<"asc-api-key">> => {
  if (iosScheme.simulator) {
    throw new Error(
      `TestFlight takes an .ipa, and the scheme ${scheme} builds a simulator .app.`,
    );
  }
  const configuration = iosScheme.configuration ?? "Release";
  if (/debug$/i.test(configuration)) {
    throw new Error(
      `TestFlight takes a release build, and the scheme ${scheme} builds the ${configuration} configuration, which loads its JavaScript from Metro.`,
    );
  }
  const unsigned = await codeSigningOff(iosScheme);
  if (unsigned) {
    throw new Error(
      `TestFlight takes a signed .ipa, and the scheme ${scheme} turns code signing off (${unsigned}).`,
    );
  }
  if (!iosScheme.exportOptionsPlist && !iosScheme.signing) {
    throw new Error(
      `The scheme ${scheme} archives without exporting an .ipa. Set signing.ascApiKey, or an exportOptionsPlist with the method app-store-connect.`,
    );
  }
  if (
    iosScheme.exportOptionsPlist &&
    fs.existsSync(schemeFile(iosScheme.exportOptionsPlist))
  ) {
    const method = await readExportMethod(
      schemeFile(iosScheme.exportOptionsPlist),
    );
    if (!APP_STORE_EXPORT_METHODS.has(method)) {
      throw new Error(
        `TestFlight takes an .ipa exported for App Store Connect, and the scheme ${scheme}'s exportOptionsPlist exports with the method ${method || "(none)"}. Set its method to app-store-connect.`,
      );
    }
  }
  return {
    kind: "asc-api-key",
    name: iosScheme.signing
      ? parseSecretReference(iosScheme.signing.ascApiKey, "signing.ascApiKey")
      : "asc-api-key",
  };
};

/**
 * Throws when the scheme's `exportOptionsPlist` exports with another method
 * than App Store Connect's, whose `.ipa` App Store Connect refuses. It reads
 * the file, which an adapter's prebuild may write, so it runs after it.
 */
export const assertTestFlightExportOptions = async (
  schemeConfig: EnrichedNativeBuildIosScheme,
): Promise<void> => {
  if (!schemeConfig.exportOptionsPlist) {
    return;
  }
  const method = await readExportMethod(schemeConfig.exportOptionsPlist);
  if (!APP_STORE_EXPORT_METHODS.has(method)) {
    throw new Error(
      `TestFlight takes an .ipa exported for App Store Connect, and the scheme ${schemeConfig.hotUpdaterSchemeName}'s exportOptionsPlist exports with the method ${method || "(none)"}. Set its method to app-store-connect.`,
    );
  }
};

export interface UploadToTestFlightResult {
  /** The App Store Connect app the build went to. */
  appId: string;
  buildUploadId: string;
  /**
   * `COMPLETE` once App Store Connect accepted the build, or `PROCESSING`
   * when it was still processing it after `processingTimeoutMs`.
   */
  state: "COMPLETE" | "PROCESSING";
  /** The app's TestFlight page, where the build appears once processed. */
  testFlightUrl: string;
}

/** An App Store Connect API request, which answers its JSON or throws. */
type AppStoreConnectRequest = <T>(
  action: string,
  method: string,
  pathname: string,
  body?: object,
) => Promise<T>;

/**
 * Requests to the App Store Connect API with `apiKey`: each carries a token
 * signed with its private key, replaced well before it expires.
 */
const createAppStoreConnectRequest = ({
  apiKey,
  privateKey,
  fetch,
}: {
  apiKey: AppStoreConnectApiKey;
  privateKey: crypto.KeyObject;
  fetch: typeof globalThis.fetch;
}): AppStoreConnectRequest => {
  let token: { value: string; issuedAtSeconds: number } | undefined;
  const authorization = () => {
    const now = Math.floor(Date.now() / 1000);
    if (!token || now - token.issuedAtSeconds >= TOKEN_REUSE_SECONDS) {
      token = {
        value: createAppStoreConnectToken({
          privateKey,
          keyId: apiKey.keyId,
          issuerId: apiKey.issuerId,
          issuedAtSeconds: now,
        }),
        issuedAtSeconds: now,
      };
      registerSecretValue(token.value);
    }
    return `Bearer ${token.value}`;
  };

  return async <T>(
    action: string,
    method: string,
    pathname: string,
    body?: object,
  ): Promise<T> => {
    const response = await fetch(`${API_URL}${pathname}`, {
      method,
      headers: {
        Authorization: authorization(),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const error = new AppStoreConnectError(
        action,
        response.status,
        await readApiErrors(response),
        response.headers.get("retry-after"),
      );
      if (response.status === 401) {
        throw new Error(
          "App Store Connect refused the API key: check its key ID and issuer ID, and that the key is not revoked.",
          { cause: error },
        );
      }
      if (response.status === 403) {
        throw new Error(
          `${error.message} An API key with the Admin, App Manager, or Developer role uploads builds.`,
          { cause: error },
        );
      }
      throw error;
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  };
};

/** The App Store Connect app of `bundleId`, and its TestFlight page. */
const findApp = async (request: AppStoreConnectRequest, bundleId: string) => {
  const { data: apps } = await retrying(() =>
    request<{
      data: { id: string; attributes?: { bundleId?: string } }[];
    }>(
      "Finding the App Store Connect app",
      "GET",
      `/v1/apps?${new URLSearchParams({
        "filter[bundleId]": bundleId,
        "fields[apps]": "bundleId",
      })}`,
    ),
  );
  const app = apps.find((app) => app.attributes?.bundleId === bundleId);
  if (!app) {
    throw new Error(
      `App Store Connect has no app with the bundle ID ${bundleId} that this API key can see. Create the app in App Store Connect, or use a key of its team.`,
    );
  }
  const testFlightUrl = `https://appstoreconnect.apple.com/apps/${app.id}/testflight/ios`;
  return { app, testFlightUrl };
};

/**
 * Whether App Store Connect already has the `.ipa`'s build: a build of its
 * version with its build number, which TestFlight lists or is processing,
 * as when a reused native build was uploaded before. A build upload that
 * never finished is no build, so uploading again fails as it would without
 * this check.
 */
export const findTestFlightBuild = async ({
  ipaPath,
  apiKey,
  fetch = globalThis.fetch,
}: {
  ipaPath: string;
  apiKey: AppStoreConnectApiKey;
  fetch?: typeof globalThis.fetch;
}): Promise<{
  found: boolean;
  testFlightUrl: string;
  shortVersion: string;
  bundleVersion: string;
}> => {
  const [info, privateKey] = await Promise.all([
    readIpaInfo(ipaPath),
    readPrivateKey(apiKey.keyPath),
  ]);
  const request = createAppStoreConnectRequest({ apiKey, privateKey, fetch });
  const { app, testFlightUrl } = await findApp(request, info.bundleId);
  const { data: builds } = await retrying(() =>
    request<{ data: { id: string }[] }>(
      "Finding the build in App Store Connect",
      "GET",
      `/v1/builds?${new URLSearchParams({
        "filter[app]": app.id,
        "filter[version]": info.bundleVersion,
        "filter[preReleaseVersion.version]": info.shortVersion,
        "fields[builds]": "version",
        limit: "1",
      })}`,
    ),
  );
  return {
    found: builds.length > 0,
    testFlightUrl,
    shortVersion: info.shortVersion,
    bundleVersion: info.bundleVersion,
  };
};

/**
 * Uploads an `.ipa` to App Store Connect, which lists it in TestFlight, with
 * the App Store Connect API's build uploads: it finds the app by the
 * `.ipa`'s bundle ID, reserves the build's version and build number, sends
 * the file in the parts App Store Connect asks for, commits it, and waits
 * for App Store Connect to accept or reject the build.
 */
export const uploadToTestFlight = async ({
  ipaPath,
  apiKey,
  fetch = globalThis.fetch,
  pollIntervalMs = 5_000,
  processingTimeoutMs = 30 * 60_000,
}: {
  ipaPath: string;
  apiKey: AppStoreConnectApiKey;
  fetch?: typeof globalThis.fetch;
  /** How often to check whether App Store Connect accepted the build. */
  pollIntervalMs?: number;
  /** How long to wait for App Store Connect to accept the build. */
  processingTimeoutMs?: number;
}): Promise<UploadToTestFlightResult> => {
  const ipaName = path.basename(ipaPath);
  const [info, privateKey, { size: fileSize }] = await Promise.all([
    readIpaInfo(ipaPath),
    readPrivateKey(apiKey.keyPath),
    fs.promises.stat(ipaPath),
  ]);

  const request = createAppStoreConnectRequest({ apiKey, privateKey, fetch });
  const { app, testFlightUrl } = await findApp(request, info.bundleId);

  // A create App Store Connect did not answer is sent again. The API has no
  // way to tell which reservation a request made, so a duplicate after an
  // unanswered create may be this upload's own: the upload never adopts,
  // uploads into, or removes a reservation it cannot show is its own.
  let buildUploadId: string | undefined;
  let unanswered = false;
  for (let attempt = 1; buildUploadId === undefined; attempt++) {
    try {
      ({
        data: { id: buildUploadId },
      } = await request<{ data: { id: string } }>(
        "Creating the build upload",
        "POST",
        "/v1/buildUploads",
        {
          data: {
            type: "buildUploads",
            attributes: {
              platform: "IOS",
              cfBundleShortVersionString: info.shortVersion,
              cfBundleVersion: info.bundleVersion,
            },
            relationships: { app: { data: { type: "apps", id: app.id } } },
          },
        },
      ));
    } catch (error) {
      if (
        error instanceof AppStoreConnectError &&
        error.status === 409 &&
        error.errors.some((apiError) => apiError.code === DUPLICATE_ERROR_CODE)
      ) {
        throw new Error(
          unanswered
            ? `App Store Connect already has build ${info.bundleVersion} of version ${info.shortVersion}, which a request of this upload it did not answer may have reserved. Upload with a new build number (CFBundleVersion).`
            : `App Store Connect already has build ${info.bundleVersion} of version ${info.shortVersion}. Each build of a version needs a new build number (CFBundleVersion).`,
          { cause: error },
        );
      }
      if (!isRetryable(error) || attempt === COMMIT_ATTEMPTS) {
        throw error;
      }
      // A rate limit refused the create; anything else may have made it.
      if (!isRateLimited(error)) {
        unanswered = true;
      }
      await sleep(retryDelayMs(error, attempt));
    }
  }

  p.log.info(
    `Uploading ${ipaName} (version ${info.shortVersion}, build ${info.bundleVersion}) to App Store Connect`,
  );
  // An unfinished upload would keep the build number reserved.
  const removeUpload = async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        await request(
          "Removing the build upload",
          "DELETE",
          `/v1/buildUploads/${buildUploadId}`,
        );
        return;
      } catch (error) {
        // An earlier attempt removed it, though its answer was lost.
        if (error instanceof AppStoreConnectError && error.status === 404) {
          return;
        }
        if (!isRetryable(error) || attempt === COMMIT_ATTEMPTS) {
          p.log.warn(
            `App Store Connect kept the unfinished build upload ${buildUploadId}, which reserves build ${info.bundleVersion} of version ${info.shortVersion}: ${(error as Error).message} Upload with a new build number (CFBundleVersion).`,
          );
          return;
        }
        await sleep(retryDelayMs(error, attempt));
      }
    }
  };

  let fileId: string;
  try {
    // Only a rate limit is retried: another failure may have made the
    // reservation, and a second one would not be this upload's.
    const { data } = await retrying(
      () =>
        request<{
          data: {
            id: string;
            attributes?: { uploadOperations?: UploadOperation[] };
          };
        }>("Reserving the .ipa upload", "POST", "/v1/buildUploadFiles", {
          data: {
            type: "buildUploadFiles",
            attributes: {
              assetType: "ASSET",
              fileName: ipaName,
              fileSize,
              uti: "com.apple.ipa",
            },
            relationships: {
              buildUpload: {
                data: { type: "buildUploads", id: buildUploadId },
              },
            },
          },
        }),
      isRateLimited,
    );
    fileId = data.id;
    const operations = data.attributes?.uploadOperations ?? [];
    if (operations.length === 0) {
      throw new Error("App Store Connect returned no upload operations.");
    }

    await uploadParts({ ipaPath, operations, fetch });
  } catch (error) {
    await removeUpload();
    throw error;
  }

  // A commit App Store Connect may have applied is never undone: an
  // unanswered one is checked against the file's state, then sent again,
  // and the upload is removed only when no commit may have taken.
  let commitUnanswered = false;
  for (let attempt = 1; ; attempt++) {
    try {
      await request(
        "Committing the .ipa upload",
        "PATCH",
        `/v1/buildUploadFiles/${fileId}`,
        {
          data: {
            type: "buildUploadFiles",
            id: fileId,
            attributes: { uploaded: true },
          },
        },
      );
      break;
    } catch (error) {
      const unconfirmed = () =>
        new Error(
          `App Store Connect did not confirm the upload of build ${info.bundleVersion}: ${(error as Error).message} Check the build in TestFlight before you upload it again: ${testFlightUrl}`,
          { cause: error },
        );
      if (!isRetryable(error)) {
        // After an unanswered commit, a refusal may mean it took.
        if (commitUnanswered) {
          throw unconfirmed();
        }
        // App Store Connect refused the commit, so nothing is processing.
        await removeUpload();
        throw error;
      }
      commitUnanswered = true;
      const fileState = await retrying(() =>
        request<{
          data: {
            attributes?: { assetDeliveryState?: { state?: string } };
          };
        }>(
          "Reading the .ipa upload",
          "GET",
          `/v1/buildUploadFiles/${fileId}?fields[buildUploadFiles]=assetDeliveryState`,
        ),
      )
        .then(({ data }) => data.attributes?.assetDeliveryState?.state)
        .catch(() => undefined);
      if (fileState && fileState !== "AWAITING_UPLOAD") {
        break;
      }
      if (attempt === COMMIT_ATTEMPTS) {
        throw unconfirmed();
      }
      await sleep(retryDelayMs(error, attempt));
    }
  }

  const deadline = Date.now() + processingTimeoutMs;
  // Whether App Store Connect reported the build processing, and the last
  // failed read: a timeout without it is a failure.
  let reportedProcessing = false;
  let lastError: unknown;
  for (let failedReads = 0; ; ) {
    // The build is uploaded: a failed read is retried until the deadline.
    let readError: unknown;
    const read = await request<{
      data: { attributes?: { state?: BuildUploadState } };
    }>(
      "Reading the build upload",
      "GET",
      `/v1/buildUploads/${buildUploadId}`,
    ).catch((error: unknown) => {
      if (!isRetryable(error)) {
        throw error;
      }
      lastError = readError = error;
      return undefined;
    });
    failedReads = read ? 0 : failedReads + 1;
    const state = read ? (read.data.attributes?.state ?? {}) : {};
    // AWAITING_UPLOAD only waits for the file, which the commit sent.
    if (state.state === "PROCESSING") {
      reportedProcessing = true;
    }
    if (!state.state || IN_PROGRESS_STATES.has(state.state)) {
      if (Date.now() >= deadline) {
        if (!reportedProcessing) {
          throw new Error(
            `App Store Connect did not report build ${info.bundleVersion} processing${lastError instanceof Error ? `: ${lastError.message}` : state.state ? ` (${state.state}).` : "."} Check the build in TestFlight: ${testFlightUrl}`,
            { cause: lastError },
          );
        }
        p.log.warn(
          `App Store Connect is still processing build ${info.bundleVersion}. It appears in TestFlight once processing finishes: ${testFlightUrl}`,
        );
        return {
          appId: app.id,
          buildUploadId,
          state: "PROCESSING",
          testFlightUrl,
        };
      }
      // A rate-limited read waits as long as App Store Connect asks.
      await sleep(
        readError === undefined
          ? pollIntervalMs
          : Math.max(pollIntervalMs, retryDelayMs(readError, failedReads)),
      );
      continue;
    }

    for (const warning of describeDetails(state.warnings ?? [])) {
      p.log.warn(warning);
    }
    if (state.state !== "COMPLETE") {
      const errors = describeDetails(state.errors ?? []);
      throw new Error(
        [
          `App Store Connect rejected build ${info.bundleVersion} of version ${info.shortVersion} (${state.state}).`,
          ...errors.map((error) => `- ${error}`),
        ].join("\n"),
      );
    }
    return { appId: app.id, buildUploadId, state: "COMPLETE", testFlightUrl };
  }
};

/**
 * Sends each part App Store Connect asked for: the bytes at its offset, with
 * only the headers it lists, since the URLs are presigned: another header,
 * or the App Store Connect token, would break their signature.
 */
const uploadParts = async ({
  ipaPath,
  operations,
  fetch,
}: {
  ipaPath: string;
  operations: readonly UploadOperation[];
  fetch: typeof globalThis.fetch;
}) => {
  const file = await fs.promises.open(ipaPath, "r");
  try {
    await runConcurrently(
      operations,
      UPLOAD_CONCURRENCY,
      async (operation, index) => {
        const body = Buffer.alloc(operation.length);
        const { bytesRead } = await file.read(
          body,
          0,
          operation.length,
          operation.offset,
        );
        if (bytesRead !== operation.length) {
          throw new Error(
            `${path.basename(ipaPath)} changed while it was uploading.`,
          );
        }
        const headers: Record<string, string> = {};
        for (const { name, value } of operation.requestHeaders ?? []) {
          headers[name] = value;
        }

        for (let attempt = 1; ; attempt++) {
          const response = await fetch(operation.url, {
            method: operation.method,
            headers,
            body,
          }).catch((error: unknown) => error as Error);
          if (!(response instanceof Error) && response.ok) {
            return;
          }
          const retryable =
            response instanceof Error || isRetryableStatus(response.status);
          if (!retryable || attempt === UPLOAD_ATTEMPTS) {
            throw new Error(
              `Uploading part ${index + 1} of ${operations.length} failed: ${
                response instanceof Error
                  ? response.message
                  : `HTTP ${response.status}`
              }.`,
            );
          }
          await sleep(retryDelayMs(response, attempt));
        }
      },
    );
  } finally {
    await file.close();
  }
};
