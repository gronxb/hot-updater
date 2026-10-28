import crypto from "node:crypto";

import { registerSecretValue } from "@hot-updater/cli-tools";
import { execa } from "execa";

import type {
  IssuedPlayServiceAccount,
  IssuePlayServiceAccountRequest,
} from "../playServiceAccount";
import { createPlayClient, GooglePlayError } from "../uploadToPlay";
import {
  createGoogleRequest,
  GoogleApiError,
  type GoogleOperation,
  type GoogleRequest,
  isServiceDisabled,
  waitForOperation,
} from "./googleApi";
import { PLAY_SERVICE_ACCOUNT_ID, PlayServiceAccountError } from "./types";

const PUBLISHER_API =
  "https://androidpublisher.googleapis.com/androidpublisher/v3";
const RESOURCE_MANAGER_API = "https://cloudresourcemanager.googleapis.com";
const SERVICE_USAGE_API = "https://serviceusage.googleapis.com";
const IAM_API = "https://iam.googleapis.com/v1";

const GCLOUD_INSTALL_URL = "https://cloud.google.com/sdk/docs/install";

/** The Google Play Android Developer API, which the service account calls. */
const PLAY_API = "androidpublisher.googleapis.com";

/** IAM creates the service account; the Play Developer API is what it calls. */
const SERVICES = ["iam.googleapis.com", PLAY_API];

const KEY_CREATION_CONSTRAINT =
  "constraints/iam.disableServiceAccountKeyCreation";

/** Retries while Google enables an API or creates a service account. */
const PROPAGATION_ATTEMPTS = 12;
const PROPAGATION_DELAY_MS = 10_000;

/** Checks of the key's access to the app, about ten minutes of them. */
const ACCESS_ATTEMPTS = 120;
const ACCESS_DELAY_MS = 5_000;

const sleepFor = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs a command and answers its stdout; `interactive` hands it the
 * terminal, as `gcloud auth login` needs.
 */
export type RunCommand = (
  file: string,
  args: readonly string[],
  options?: { interactive?: boolean },
) => Promise<string>;

const runWithExeca: RunCommand = async (file, args, options) =>
  (
    await execa(
      file,
      args,
      options?.interactive ? { stdio: "inherit" } : { stdin: "ignore" },
    )
  ).stdout ?? "";

/**
 * Play Console's page that invites `email` as a user. `_` stands for the
 * developer account the browser is signed in to, so no ID is needed.
 */
export const playConsoleInviteUrl = (email: string) =>
  `https://play.google.com/console/u/0/developers/_/users-and-permissions?invite=${encodeURIComponent(email)}`;

/** A project ID nobody has: Google Cloud's are global. */
const newProjectId = () =>
  `${PLAY_SERVICE_ACCOUNT_ID}-${crypto.randomBytes(3).toString("hex")}`;

const isNotFound = (error: unknown) =>
  error instanceof GoogleApiError && error.status === 404;
const isConflict = (error: unknown) =>
  error instanceof GoogleApiError && error.status === 409;
/** The API is disabled in another project than the one set up: waiting does not help. */
const consumerApiDisabled = (error: GoogleApiError) =>
  new PlayServiceAccountError(
    "api-not-enabled",
    `${error.apiMessage}\nEnable it in ${error.consumer ?? "that project"}, then run this again.`,
    { cause: error },
  );

const isDenied = (error: unknown) =>
  error instanceof GoogleApiError &&
  (error.status === 403 || error.apiStatus === "PERMISSION_DENIED");

/** The Google Account gcloud uses, if one is active. */
const activeAccount = async (run: RunCommand) =>
  (
    await run("gcloud", [
      "auth",
      "list",
      "--filter=status:ACTIVE",
      "--format=value(account)",
    ])
  )
    .trim()
    .split("\n")[0]
    ?.trim() || undefined;

/** Stops before anything else, a prompt included, when gcloud is not installed. */
const requireGcloud = async (run: RunCommand) => {
  try {
    await run("gcloud", ["--version"]);
  } catch (error) {
    throw new PlayServiceAccountError(
      "gcloud-not-installed",
      [
        "gcloud CLI is not installed.",
        "Install it, then run this again:",
        GCLOUD_INSTALL_URL,
      ].join("\n"),
      { cause: error },
    );
  }
};

/** gcloud's access token, after `gcloud auth login` when no account is active. */
const signInWithGcloud = async ({
  run,
  onStep,
}: {
  run: RunCommand;
  onStep: (message: string) => void;
}) => {
  let account = await activeAccount(run);
  if (account === undefined) {
    // A cancelled or failed sign-in leaves no account, named below.
    await run("gcloud", ["auth", "login"], { interactive: true }).catch(
      () => {},
    );
    account = await activeAccount(run);
    if (account === undefined) {
      throw new PlayServiceAccountError(
        "gcloud-not-signed-in",
        "gcloud has no active Google Account.\nRun gcloud auth login, then run this again.",
      );
    }
  }
  onStep(`Signed in to gcloud as ${account}`);
  const accessToken = (
    await run("gcloud", ["auth", "print-access-token"])
  ).trim();
  registerSecretValue(accessToken);
  return accessToken;
};

/**
 * `IssuePlayServiceAccount` with the gcloud CLI's sign-in and Google's own
 * APIs:
 *
 * 1. once gcloud is found, `askPackageName` names the app, and gcloud's
 *    Google Account, signed in with `gcloud auth login` when none is
 *    active, the access token the Google Cloud steps use;
 * 2. the account's only project with the Play Developer API, else the one
 *    `chooseProject` picks, else a new one, gets the IAM and Play Developer
 *    APIs enabled, and the service account `hot-updater-play` its JSON key;
 * 3. the developer invites the service account in Play Console, which
 *    `onInvite` opens: gcloud's token may not manage Google Play users;
 * 4. the key itself opens an edit of the app until Google Play lets it,
 *    and is deleted again when it never does.
 *
 * Each step reuses what an earlier run created: the project and the
 * service account.
 */
export const createGoogleKeyIssuer =
  ({
    fetch = globalThis.fetch,
    sleep = sleepFor,
    run = runWithExeca,
  }: {
    fetch?: typeof globalThis.fetch;
    sleep?: (ms: number) => Promise<void>;
    run?: RunCommand;
  } = {}) =>
  async (
    request: IssuePlayServiceAccountRequest,
  ): Promise<IssuedPlayServiceAccount> => {
    const { onStep = () => {} } = request;
    await requireGcloud(run);
    const packageName = await request.askPackageName();
    const accessToken = await signInWithGcloud({ run, onStep });
    const google = createGoogleRequest({ accessToken, fetch });

    const project = await chooseProject({ google, request, sleep, onStep });
    const { projectId } = project;
    onStep(`Enabling the APIs in ${projectId}`);
    await enableServices({ google, projectId, sleep });

    onStep(`Creating the service account in ${projectId}`);
    const email = await ensureServiceAccount({ google, project, sleep });

    onStep("Creating the service account's JSON key");
    const key = await createKey({ google, project, email, sleep });
    const revoke = async () => {
      try {
        await google("Deleting the key", "DELETE", `${IAM_API}/${key.name}`);
        return true;
      } catch (error) {
        return isNotFound(error);
      }
    };

    const inviteUrl = playConsoleInviteUrl(email);
    try {
      await request.onInvite(inviteUrl, email);
      onStep("Waiting for the Play Console invite");
      await waitForPlayAccess({
        json: key.json,
        packageName,
        fetch,
        sleep,
      });
    } catch (error) {
      const deleted = await revoke();
      throw new PlayServiceAccountError(
        "play-access-pending",
        [
          `The key can't release ${packageName} yet.`,
          "Invite the service account in Play Console with release access:",
          email,
          inviteUrl,
          "A new app needs its first .aab uploaded in Play Console.",
          // Not stored anywhere: the developer deletes it by hand.
          ...(deleted
            ? []
            : [
                `Delete its unused key ${key.keyId} in Google Cloud:`,
                `https://console.cloud.google.com/iam-admin/serviceaccounts?project=${encodeURIComponent(projectId)}`,
              ]),
          "Then run: npx hot-updater google-play login",
        ].join("\n"),
        { cause: error },
      );
    }
    return {
      json: key.json,
      keyId: key.keyId,
      email,
      projectId,
      revoke,
      // gcloud keeps its own sign-in: there is nothing to end here.
      dispose: async () => {},
    };
  };

/**
 * Waits until the key opens an edit of `packageName`, which Google Play
 * allows once the service account is a Play Console user with access to
 * the app, then deletes the edit, which changed nothing. Google may not
 * take a key just created for a while either.
 */
const waitForPlayAccess = async ({
  json,
  packageName,
  fetch,
  sleep,
}: {
  json: string;
  packageName: string;
  fetch: typeof globalThis.fetch;
  sleep: (ms: number) => Promise<void>;
}) => {
  const play = createPlayClient({ json, packageName, fetch });
  const edits = `${PUBLISHER_API}/applications/${encodeURIComponent(packageName)}/edits`;
  for (let attempt = 1; ; attempt++) {
    if (attempt > 1) await sleep(ACCESS_DELAY_MS);
    let ready = true;
    try {
      await play.authorization();
    } catch {
      // The key is not accepted yet.
      ready = false;
    }
    if (ready) {
      try {
        const edit = await play.request<{ id?: string }>(
          `Opening an edit of ${packageName}`,
          "POST",
          edits,
        );
        if (edit?.id) {
          await play
            .request("Deleting the edit", "DELETE", `${edits}/${edit.id}`)
            .catch(() => {});
        }
        return;
      } catch (error) {
        if (
          !(error instanceof GooglePlayError) ||
          ![401, 403, 404].includes(error.status)
        ) {
          throw error;
        }
      }
    }
    if (attempt >= ACCESS_ATTEMPTS) {
      throw new Error("Google Play did not let the key reach the app in time.");
    }
  }
};

/** The account's active projects, every page of them. */
const listProjects = async (google: GoogleRequest) => {
  const projects: CloudProject[] = [];
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

/** Service Usage reads of the projects' Play Developer API, at most this many at once. */
const API_CHECK_CONCURRENCY = 8;

/**
 * Whether each project has the Google Play Developer API enabled, by one
 * Service Usage read each; a project this account may not read counts as
 * without it.
 */
const withPlayApiState = async (
  google: GoogleRequest,
  projects: readonly CloudProject[],
): Promise<(CloudProject & { playApiEnabled: boolean })[]> => {
  const states: boolean[] = [];
  for (let start = 0; start < projects.length; start += API_CHECK_CONCURRENCY) {
    states.push(
      ...(await Promise.all(
        projects
          .slice(start, start + API_CHECK_CONCURRENCY)
          .map(({ projectId }) =>
            google<{ state?: string }>(
              "Reading the project's APIs",
              "GET",
              `${SERVICE_USAGE_API}/v1/projects/${encodeURIComponent(projectId)}/services/${PLAY_API}`,
            ).then(
              ({ state }) => state === "ENABLED",
              () => false,
            ),
          ),
      )),
    );
  }
  return projects.map((project, index) => ({
    ...project,
    playApiEnabled: states[index]!,
  }));
};

/** The display name of the project Hot Updater creates. */
const PROJECT_DISPLAY_NAME = "Hot Updater Play";

/**
 * The project the service account goes in: a new one for an account
 * without projects; the only project with the Play Developer API, without
 * asking; else the one the developer picks, or a new one.
 */
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
  const listed = await listProjects(google);
  if (listed.length === 0) return createProject({ google, sleep, onStep });
  const projects = await withPlayApiState(google, listed);
  const enabled = projects.filter(({ playApiEnabled }) => playApiEnabled);
  if (enabled.length === 1) {
    const [only] = enabled;
    onStep(`Using ${only!.projectId}, the project with the Play Developer API`);
    return only!;
  }
  const chosen = await request.chooseProject(
    projects.map(({ projectId, displayName, playApiEnabled }) => ({
      projectId,
      ...(displayName ? { displayName } : {}),
      playApiEnabled,
    })),
  );
  if (chosen === null) return createProject({ google, sleep, onStep });
  return (
    projects.find((project) => project.projectId === chosen) ?? {
      projectId: chosen,
    }
  );
};

/** A new project, `hot-updater-play-<random>`, once Google has created it. */
const createProject = async ({
  google,
  sleep,
  onStep,
}: {
  google: GoogleRequest;
  sleep: (ms: number) => Promise<void>;
  onStep: (message: string) => void;
}): Promise<CloudProject> => {
  const projectId = newProjectId();
  onStep(`Creating the Google Cloud project ${projectId}`);
  try {
    const operation = await google<GoogleOperation<{ name?: string }>>(
      "Creating the Google Cloud project",
      "POST",
      `${RESOURCE_MANAGER_API}/v3/projects`,
      { projectId, displayName: PROJECT_DISPLAY_NAME },
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
        [
          "Google Cloud has no project quota left for this account.",
          error.apiMessage || "Quota exceeded.",
          "Delete a project you no longer use, then run this again:",
          "https://console.cloud.google.com/cloud-resource-manager",
        ].join("\n"),
        { cause: error },
      );
    }
    if (/terms of service/iu.test(error.apiMessage)) {
      throw new PlayServiceAccountError(
        "project-create-denied",
        "This Google Account hasn't accepted the Google Cloud Terms of Service.\nAccept them at https://console.cloud.google.com, then run this again.",
        { cause: error },
      );
    }
    if (isDenied(error) || error.apiStatus === "FAILED_PRECONDITION") {
      throw new PlayServiceAccountError(
        "project-create-denied",
        [
          "This Google Account may not create Google Cloud projects.",
          error.apiMessage || "Permission denied.",
          "Ask an admin for the Project Creator role.",
        ].join("\n"),
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
        throw consumerApiDisabled(error);
      }
      if (
        (!disabled && !(notFound && isNotFound(error))) ||
        attempt >= PROPAGATION_ATTEMPTS
      ) {
        if (disabled) {
          throw new PlayServiceAccountError(
            "api-not-enabled",
            `Google is still enabling the APIs in ${project.projectId}.\n${error.apiMessage}\nWait a few minutes, then run this again.`,
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
  readonly displayName?: string;
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
        [
          `This Google Account may not enable APIs in ${projectId}.`,
          (error as GoogleApiError).apiMessage || "Permission denied.",
          "Pick a project you own, or ask its owner for the Editor role.",
        ].join("\n"),
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
        [
          `This Google Account may not create service accounts in ${projectId}.`,
          (error as GoogleApiError).apiMessage || "Permission denied.",
          "Pick a project you own, or ask for the Service Account Admin role.",
        ].join("\n"),
        { cause: error },
      );
    }
    throw error;
  }
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
        [
          `iam.disableServiceAccountKeyCreation forbids keys in ${projectId}.`,
          "Ask an organization policy admin to allow keys for this project,",
          "or run this again with a project outside the organization.",
        ].join("\n"),
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
