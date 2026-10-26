import crypto from "node:crypto";

import { registerSecretValue } from "@hot-updater/cli-tools";

import type {
  GoogleCloudProject,
  IssuedPlayServiceAccount,
  IssuePlayServiceAccountRequest,
} from "../playServiceAccount";
import {
  createGoogleRequest,
  GoogleApiError,
  type GoogleOperation,
  type GoogleRequest,
  isServiceDisabled,
  waitForOperation,
} from "./googleApi";
import { revokeGoogleToken, signInWithGoogle } from "./googleSignIn";
import {
  GOOGLE_OAUTH_CLIENT_ENV_NAMES,
  PLAY_CONSOLE_URL,
  PLAY_SERVICE_ACCOUNT_ID,
  PlayServiceAccountError,
} from "./types";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const ANDROID_PUBLISHER_SCOPE =
  "https://www.googleapis.com/auth/androidpublisher";
const SCOPES = [CLOUD_PLATFORM_SCOPE, ANDROID_PUBLISHER_SCOPE];

const PUBLISHER_API =
  "https://androidpublisher.googleapis.com/androidpublisher/v3";
const RESOURCE_MANAGER_API = "https://cloudresourcemanager.googleapis.com";
const SERVICE_USAGE_API = "https://serviceusage.googleapis.com";
const IAM_API = "https://iam.googleapis.com/v1";

/** IAM creates the service account; the Play Developer API is what it calls. */
const SERVICES = ["iam.googleapis.com", "androidpublisher.googleapis.com"];

/**
 * What the service account may do in Play Console, for the app only: read
 * it, and release to testing tracks, which `--submit play-internal` does.
 */
const APP_PERMISSIONS = [
  "CAN_VIEW_NON_FINANCIAL_DATA",
  "CAN_MANAGE_TRACK_APKS",
];

const KEY_CREATION_CONSTRAINT =
  "constraints/iam.disableServiceAccountKeyCreation";

/** Retries while Google enables an API or creates a service account. */
const PROPAGATION_ATTEMPTS = 12;
const PROPAGATION_DELAY_MS = 10_000;

const sleepFor = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The developer account ID in `input`, a number or a Play Console URL. */
export const parseDeveloperId = (input: string): string | undefined => {
  const trimmed = input.trim();
  if (/^\d+$/u.test(trimmed)) return trimmed;
  return trimmed.match(/\/developers\/(\d+)(?:[/?#]|$)/u)?.[1];
};

/** A project ID nobody has: Google Cloud's are global. */
const newProjectId = () =>
  `${PLAY_SERVICE_ACCOUNT_ID}-${crypto.randomBytes(3).toString("hex")}`;

const isNotFound = (error: unknown) =>
  error instanceof GoogleApiError && error.status === 404;
const isConflict = (error: unknown) =>
  error instanceof GoogleApiError && error.status === 409;
/** The API is disabled in the OAuth client's own project: waiting does not help. */
const clientApiDisabled = (error: GoogleApiError) =>
  new PlayServiceAccountError(
    "api-not-enabled",
    `${error.apiMessage} The Google OAuth client Hot Updater signs in with belongs to that project, which must enable the API (see ${GOOGLE_OAUTH_CLIENT_ENV_NAMES.clientId}).`,
    { cause: error },
  );

/** Google's own words, after a message that names the likely cause. */
const googleSays = (error: unknown) =>
  error instanceof GoogleApiError && error.apiMessage
    ? ` (Google: ${error.apiMessage})`
    : "";

/** A Play Console refusal, as `not-play-admin`. */
const notPlayAdmin = (developerId: string, error: unknown) =>
  new PlayServiceAccountError(
    "not-play-admin",
    `The Google Account you signed in with is not an admin of the Play Console developer account ${developerId}. Sign in with an account that has the Admin permission there (Users and permissions in ${PLAY_CONSOLE_URL})${googleSays(error)}.`,
    { cause: error },
  );

const isDenied = (error: unknown) =>
  error instanceof GoogleApiError &&
  (error.status === 403 || error.apiStatus === "PERMISSION_DENIED");

/**
 * `IssuePlayServiceAccount` with Google's own APIs, after a sign-in on
 * Google's consent screen (OAuth for installed apps, with PKCE and a
 * loopback redirect):
 *
 * 1. the Play Console side is checked first, with no change anywhere: the
 *    developer account answers to the account as its admin, and has the app;
 * 2. the chosen Google Cloud project, or a new one, gets the IAM and Play
 *    Developer APIs enabled, and the service account `hot-updater-play`;
 * 3. the service account becomes a Play Console user that may release the
 *    app to testing tracks;
 * 4. only then is its JSON key created, the last step, so a failure before
 *    it leaves no key behind.
 *
 * Each step reuses what an earlier run created: the project, the service
 * account, and its Play Console access.
 */
export const createGoogleKeyIssuer =
  ({
    fetch = globalThis.fetch,
    sleep = sleepFor,
  }: {
    fetch?: typeof globalThis.fetch;
    sleep?: (ms: number) => Promise<void>;
  } = {}) =>
  async (
    request: IssuePlayServiceAccountRequest,
  ): Promise<IssuedPlayServiceAccount> => {
    const { packageName, oauthClient, onStep = () => {} } = request;
    if (!oauthClient?.clientId) {
      throw new PlayServiceAccountError(
        "sign-in-not-configured",
        `This build of Hot Updater has no Google OAuth client to sign in with. Set ${GOOGLE_OAUTH_CLIENT_ENV_NAMES.clientId} and ${GOOGLE_OAUTH_CLIENT_ENV_NAMES.clientSecret} to a "Desktop app" OAuth client.`,
      );
    }
    const signIn = await signInWithGoogle({
      client: oauthClient,
      scopes: SCOPES,
      onUrl: request.onSignInUrl,
      fetch,
    });
    const dispose = async () => {
      await revokeGoogleToken(signIn.accessToken, fetch);
    };
    try {
      const missing = SCOPES.filter((scope) => !signIn.scopes.includes(scope));
      if (missing.length > 0) {
        throw new PlayServiceAccountError(
          "scope-not-granted",
          `The sign-in did not allow ${missing.map((scope) => (scope === ANDROID_PUBLISHER_SCOPE ? "managing Google Play" : "managing Google Cloud")).join(" or ")}. Run this again and keep every box on Google's consent screen ticked.`,
        );
      }
      const google = createGoogleRequest({
        accessToken: signIn.accessToken,
        fetch,
      });

      const developerInput = await request.askDeveloperId();
      const developerId = parseDeveloperId(developerInput);
      if (developerId === undefined) {
        throw new PlayServiceAccountError(
          "developer-not-found",
          `"${developerInput.trim()}" is no developer account ID. Open ${PLAY_CONSOLE_URL}: it is the number after /developers/ in the address.`,
        );
      }
      onStep("Checking the Play Console developer account");
      await checkPlayConsole({ google, developerId, packageName });

      const project = await chooseProject({ google, request, sleep, onStep });
      const { projectId } = project;
      onStep(`Enabling the Google Play Developer API in ${projectId}`);
      await enableServices({ google, projectId, sleep });

      onStep(`Creating the service account in ${projectId}`);
      const email = await ensureServiceAccount({ google, project, sleep });

      onStep(`Giving ${email} release access to ${packageName}`);
      await grantPlayAccess({ google, developerId, email, packageName });

      onStep("Creating the service account's JSON key");
      const key = await createKey({ google, project, email, sleep });
      return {
        json: key.json,
        keyId: key.keyId,
        email,
        projectId,
        developerId,
        revoke: async () => {
          try {
            await google(
              "Deleting the key",
              "DELETE",
              `${IAM_API}/${key.name}`,
            );
            return true;
          } catch (error) {
            return isNotFound(error);
          }
        },
        dispose,
      };
    } catch (error) {
      await dispose();
      throw error;
    }
  };

/**
 * Whether the signed-in account administers `developerId`, and Google Play
 * has `packageName` there, asked without changing anything: listing the
 * account's users takes the admin permission, and an edit opened on the app
 * is deleted again.
 */
const checkPlayConsole = async ({
  google,
  developerId,
  packageName,
}: {
  google: GoogleRequest;
  developerId: string;
  packageName: string;
}) => {
  try {
    await google(
      "Listing the Play Console users",
      "GET",
      `${PUBLISHER_API}/developers/${developerId}/users?pageSize=1`,
    );
  } catch (error) {
    // No project of the developer's is involved yet: a disabled API is the
    // OAuth client's.
    if (isServiceDisabled(error)) throw clientApiDisabled(error);
    if (isNotFound(error)) {
      throw new PlayServiceAccountError(
        "developer-not-found",
        `Play Console has no developer account ${developerId}. Open ${PLAY_CONSOLE_URL}: the developer account ID is the number after /developers/ in the address${googleSays(error)}.`,
        { cause: error },
      );
    }
    if (isDenied(error)) throw notPlayAdmin(developerId, error);
    throw error;
  }

  let edit: { id?: string };
  try {
    edit = await google<{ id?: string }>(
      `Opening an edit of ${packageName}`,
      "POST",
      `${PUBLISHER_API}/applications/${encodeURIComponent(packageName)}/edits`,
    );
  } catch (error) {
    if (isServiceDisabled(error)) throw clientApiDisabled(error);
    if (isNotFound(error) || isDenied(error)) {
      throw appNotFound(packageName, developerId, error);
    }
    throw error;
  }
  if (edit.id) {
    // Nothing was changed in it; an edit left open expires on its own.
    await google(
      "Deleting the edit",
      "DELETE",
      `${PUBLISHER_API}/applications/${encodeURIComponent(packageName)}/edits/${edit.id}`,
    ).catch(() => {});
  }
};

const appNotFound = (
  packageName: string,
  developerId: string,
  cause: unknown,
) =>
  new PlayServiceAccountError(
    "app-not-found",
    `Google Play has no app ${packageName} in the developer account ${developerId}. Google takes the first .aab of a new app only in Play Console: create the app there, upload one .aab by hand (for example to internal testing), then run this again${googleSays(cause)}.`,
    { cause },
  );

/** The account's active projects, every page of them. */
const listProjects = async (google: GoogleRequest) => {
  const projects: (GoogleCloudProject & CloudProject)[] = [];
  let pageToken: string | undefined;
  do {
    const page = await google<{
      projects?: { name?: string; projectId?: string; displayName?: string }[];
      nextPageToken?: string;
    }>(
      "Listing the Google Cloud projects",
      "GET",
      `${RESOURCE_MANAGER_API}/v3/projects:search?${new URLSearchParams({
        query: "state:ACTIVE",
        ...(pageToken ? { pageToken } : {}),
      })}`,
    );
    for (const project of page.projects ?? []) {
      if (project.projectId) {
        projects.push({
          projectId: project.projectId,
          ...(project.displayName ? { displayName: project.displayName } : {}),
          ...projectNumberOf(project.name),
        });
      }
    }
    pageToken = page.nextPageToken || undefined;
  } while (pageToken);
  return projects;
};

/** The project the developer picks, or a new one when there is none or they ask. */
const chooseProject = async ({
  google,
  request,
  sleep,
  onStep,
}: {
  google: GoogleRequest;
  request: IssuePlayServiceAccountRequest;
  sleep: (ms: number) => Promise<void>;
  onStep: (message: string) => void;
}): Promise<CloudProject> => {
  const projects = await listProjects(google);
  const chosen =
    projects.length > 0
      ? await request.chooseProject(
          projects.map(({ projectId, displayName }) => ({
            projectId,
            ...(displayName ? { displayName } : {}),
          })),
        )
      : undefined;
  if (chosen !== undefined) {
    return (
      projects.find((project) => project.projectId === chosen) ?? {
        projectId: chosen,
      }
    );
  }

  const projectId = newProjectId();
  onStep(`Creating the Google Cloud project ${projectId}`);
  try {
    const operation = await google<GoogleOperation<{ name?: string }>>(
      "Creating the Google Cloud project",
      "POST",
      `${RESOURCE_MANAGER_API}/v3/projects`,
      { projectId, displayName: "Hot Updater Play" },
    );
    const created = await waitForOperation<{ name?: string }>({
      request: google,
      origin: `${RESOURCE_MANAGER_API}/v3`,
      operation,
      action: "Creating the Google Cloud project",
      sleep,
    });
    return { projectId, ...projectNumberOf(created?.name) };
  } catch (error) {
    if (!(error instanceof GoogleApiError)) throw error;
    if (
      error.status === 429 ||
      error.apiStatus === "RESOURCE_EXHAUSTED" ||
      /quota/iu.test(error.apiMessage)
    ) {
      throw new PlayServiceAccountError(
        "project-quota",
        `Google Cloud has no project quota left for this account: ${error.apiMessage || "quota exceeded"}. Delete a project you no longer use (https://console.cloud.google.com/cloud-resource-manager), or run this again and pick an existing project.`,
        { cause: error },
      );
    }
    if (/terms of service/iu.test(error.apiMessage)) {
      throw new PlayServiceAccountError(
        "project-create-denied",
        "This Google Account has not accepted the Google Cloud Terms of Service. Open https://console.cloud.google.com once to accept them, then run this again.",
        { cause: error },
      );
    }
    if (isDenied(error) || error.apiStatus === "FAILED_PRECONDITION") {
      throw new PlayServiceAccountError(
        "project-create-denied",
        `This Google Account may not create Google Cloud projects: ${error.apiMessage || "permission denied"}. Ask your organization's admin for the Project Creator role, or run this again and pick an existing project.`,
        { cause: error },
      );
    }
    throw error;
  }
};

/** `projectNumber` from a resource name `projects/<number>`. */
const projectNumberOf = (name: string | undefined) => {
  const number = name?.match(/^projects\/(\d+)$/u)?.[1];
  return number === undefined ? {} : { projectNumber: number };
};

/**
 * Runs `run` again while Google is still enabling an API in `project`,
 * or, with `notFound`, still creating what it reads.
 */
const whilePropagating = async <T>({
  run,
  project,
  sleep,
  notFound = false,
}: {
  run: () => Promise<T>;
  project: CloudProject;
  sleep: (ms: number) => Promise<void>;
  notFound?: boolean;
}): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const disabled = isServiceDisabled(error);
      if (disabled && !consumerIs(error, project)) {
        throw clientApiDisabled(error);
      }
      if (
        (!disabled && !(notFound && isNotFound(error))) ||
        attempt >= PROPAGATION_ATTEMPTS
      ) {
        if (disabled) {
          throw new PlayServiceAccountError(
            "api-not-enabled",
            `Google is still enabling the APIs in ${project.projectId}: ${error.apiMessage} Wait a few minutes, then run this again.`,
            { cause: error },
          );
        }
        throw error;
      }
      await sleep(PROPAGATION_DELAY_MS);
    }
  }
};

/**
 * Whether a disabled-service error is about `project` itself, which waiting
 * fixes: Google names the consumer by number, and an error naming none
 * counts as the project's own.
 */
const consumerIs = (error: GoogleApiError, project: CloudProject) =>
  error.consumer === undefined ||
  error.consumer === `projects/${project.projectId}` ||
  (project.projectNumber === undefined
    ? true
    : error.consumer === `projects/${project.projectNumber}`);

/** A project as the steps after choosing it name it. */
interface CloudProject {
  readonly projectId: string;
  /** Its number, as Google names it in errors, when Resource Manager said. */
  readonly projectNumber?: string;
}

const enableServices = async ({
  google,
  projectId,
  sleep,
}: {
  google: GoogleRequest;
  projectId: string;
  sleep: (ms: number) => Promise<void>;
}) => {
  try {
    const operation = await google<GoogleOperation>(
      "Enabling the APIs",
      "POST",
      `${SERVICE_USAGE_API}/v1/projects/${projectId}/services:batchEnable`,
      { serviceIds: SERVICES },
    );
    await waitForOperation({
      request: google,
      origin: `${SERVICE_USAGE_API}/v1`,
      operation,
      action: "Enabling the APIs",
      sleep,
    });
  } catch (error) {
    if (isDenied(error) && !isServiceDisabled(error)) {
      throw new PlayServiceAccountError(
        "project-access-denied",
        `This Google Account may not enable APIs in ${projectId}: ${(error as GoogleApiError).apiMessage || "permission denied"}. Pick a project you own, or ask its owner for the Editor role.`,
        { cause: error },
      );
    }
    throw error;
  }
};

/** The `hot-updater-play` service account's email, created unless it exists. */
const ensureServiceAccount = async ({
  google,
  project,
  sleep,
}: {
  google: GoogleRequest;
  project: CloudProject;
  sleep: (ms: number) => Promise<void>;
}): Promise<string> => {
  const { projectId } = project;
  const email = `${PLAY_SERVICE_ACCOUNT_ID}@${projectId}.iam.gserviceaccount.com`;
  try {
    const created = await whilePropagating({
      project,
      sleep,
      run: () =>
        google<{ email?: string }>(
          "Creating the service account",
          "POST",
          `${IAM_API}/projects/${projectId}/serviceAccounts`,
          {
            accountId: PLAY_SERVICE_ACCOUNT_ID,
            serviceAccount: {
              displayName: "Hot Updater Play uploads",
              description:
                "Uploads Android App Bundles to Google Play for hot-updater native-build android --submit play-internal.",
            },
          },
        ),
    });
    return created.email ?? email;
  } catch (error) {
    if (isConflict(error)) return email;
    if (isDenied(error) && !isServiceDisabled(error)) {
      throw new PlayServiceAccountError(
        "project-access-denied",
        `This Google Account may not create service accounts in ${projectId}: ${(error as GoogleApiError).apiMessage || "permission denied"}. Pick a project you own, or ask its owner for the Service Account Admin role.`,
        { cause: error },
      );
    }
    throw error;
  }
};

/**
 * Makes `email` a Play Console user that may release `packageName`, keeping
 * any permission it has: the user and the app's grant are created, or the
 * grant gains the release permissions.
 */
const grantPlayAccess = async ({
  google,
  developerId,
  email,
  packageName,
}: {
  google: GoogleRequest;
  developerId: string;
  email: string;
  packageName: string;
}) => {
  const developer = `${PUBLISHER_API}/developers/${developerId}`;
  const user = `${developer}/users/${encodeURIComponent(email)}`;
  try {
    await google("Adding the Play Console user", "POST", `${developer}/users`, {
      name: `developers/${developerId}/users/${email}`,
      email,
    });
  } catch (error) {
    if (isDenied(error)) throw notPlayAdmin(developerId, error);
    if (!isConflict(error)) throw error;
  }
  try {
    await google("Granting access to the app", "POST", `${user}/grants`, {
      name: `developers/${developerId}/users/${email}/grants/${packageName}`,
      packageName,
      appLevelPermissions: APP_PERMISSIONS,
    });
    return;
  } catch (error) {
    if (isNotFound(error)) throw appNotFound(packageName, developerId, error);
    if (isDenied(error)) throw notPlayAdmin(developerId, error);
    if (!isConflict(error)) throw error;
  }
  const granted = await findGrant({ google, developer, email, packageName });
  const missing = APP_PERMISSIONS.filter(
    (permission) => !granted.includes(permission),
  );
  if (missing.length === 0) return;
  await google(
    "Granting access to the app",
    "PATCH",
    `${user}/grants/${encodeURIComponent(packageName)}?updateMask=appLevelPermissions`,
    { appLevelPermissions: [...granted, ...missing] },
  );
};

/** The app permissions `email` holds on `packageName`, from the user list. */
const findGrant = async ({
  google,
  developer,
  email,
  packageName,
}: {
  google: GoogleRequest;
  developer: string;
  email: string;
  packageName: string;
}): Promise<string[]> => {
  let pageToken: string | undefined;
  do {
    const page = await google<{
      users?: {
        email?: string;
        grants?: { packageName?: string; appLevelPermissions?: string[] }[];
      }[];
      nextPageToken?: string;
    }>(
      "Listing the Play Console users",
      "GET",
      `${developer}/users?${new URLSearchParams({
        pageSize: "100",
        ...(pageToken ? { pageToken } : {}),
      })}`,
    );
    const found = page.users?.find((candidate) => candidate.email === email);
    if (found) {
      return (
        found.grants?.find((grant) => grant.packageName === packageName)
          ?.appLevelPermissions ?? []
      );
    }
    pageToken = page.nextPageToken || undefined;
  } while (pageToken);
  return [];
};

/** A new JSON key of the service account, checked and masked in the CLI's output. */
const createKey = async ({
  google,
  project,
  email,
  sleep,
}: {
  google: GoogleRequest;
  project: CloudProject;
  email: string;
  sleep: (ms: number) => Promise<void>;
}): Promise<{ json: string; name: string; keyId: string }> => {
  const { projectId } = project;
  let key: { name?: string; privateKeyData?: string };
  try {
    key = await whilePropagating({
      project,
      sleep,
      // A service account just created may not be found yet.
      notFound: true,
      run: () =>
        google<{ name?: string; privateKeyData?: string }>(
          "Creating the key",
          "POST",
          `${IAM_API}/projects/${projectId}/serviceAccounts/${email}/keys`,
          {
            privateKeyType: "TYPE_GOOGLE_CREDENTIALS_FILE",
            keyAlgorithm: "KEY_ALG_RSA_2048",
          },
        ),
    });
  } catch (error) {
    if (
      error instanceof GoogleApiError &&
      (error.violations.includes(KEY_CREATION_CONSTRAINT) ||
        /disableServiceAccountKeyCreation/u.test(error.apiMessage))
    ) {
      throw new PlayServiceAccountError(
        "key-creation-disabled",
        `An organization policy (iam.disableServiceAccountKeyCreation) forbids service account keys in ${projectId}; organizations created since 2024 enforce it by default. Ask an organization policy admin to allow keys for this project, or run this again with a project outside the organization. The service account ${email} and its Play Console access remain for the next run.`,
        { cause: error },
      );
    }
    throw error;
  }
  if (!key.name || !key.privateKeyData) {
    throw new Error("Google Cloud created the key without its JSON file.");
  }
  registerSecretValue(key.privateKeyData);
  const json = Buffer.from(key.privateKeyData, "base64").toString("utf-8");
  registerSecretValue(json);
  let parsed: { private_key?: unknown; client_email?: unknown };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    parsed = {};
  }
  if (typeof parsed.private_key !== "string") {
    await google("Deleting the key", "DELETE", `${IAM_API}/${key.name}`).catch(
      () => {},
    );
    throw new Error("Google Cloud created a key that is no JSON key file.");
  }
  registerSecretValue(parsed.private_key);
  return { json, name: key.name, keyId: key.name.split("/").pop()! };
};
