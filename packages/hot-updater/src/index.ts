#!/usr/bin/env node
import {
  Argument,
  Command,
  InvalidArgumentError,
  Option,
} from "@commander-js/extra-typings";
import { banner, CREDENTIAL_LOGIN_GROUPS, p } from "@hot-updater/cli-tools";
import isPortReachable from "is-port-reachable";
import { normalizeRange } from "verkit";

import {
  interactiveCommandOption,
  nativeBuildDryRunCommandOption,
  nativeBuildNoCacheCommandOption,
  nativeBuildOutputCommandOption,
  nativeBuildJsonCommandOption,
  nativeBuildSchemeCommandOption,
  platformCommandOption,
  playSubmitCommandOption,
  testFlightGroupCommandOption,
  testFlightSubmitCommandOption,
  whatToTestCommandOption,
} from "@/commandOptions";
import { handleAgentInfra } from "@/commands/agent/infra";
import { handleAppVersion } from "@/commands/appVersion";
import {
  handleNativeBuildCreate,
  type NativeBuildCreateOptions,
} from "@/commands/buildNative";
import {
  getConsolePort,
  withConsoleSession,
  openConsole,
} from "@/commands/console";
import {
  type DeployOptions,
  deploy,
  normalizeRolloutPercentage,
} from "@/commands/deploy";
import { handleInfraScaffold } from "@/commands/infra/scaffold";
import { init } from "@/commands/init";
import { initHelp } from "@/commands/initHelp";
import { INIT_PROVIDER_NAMES } from "@/commands/initProviders";
import { type PatchOptions, createPatch } from "@/commands/patch";
import {
  handleGooglePlayUpload,
  handleTestFlight,
  type StoreUploadOptions,
} from "@/commands/storeUpload";
import { version } from "@/packageJson";
import { ensureNoConflicts } from "@/utils/conflictDetection";
import { printBanner } from "@/utils/printBanner";

import {
  handleApiKeyCreate,
  handleApiKeyList,
  handleApiKeyRevoke,
} from "./commands/apiKey";
import {
  handleBundleDelete,
  handleBundleEnablement,
  handleBundleList,
  handleBundleShow,
  handleBundleUpdate,
} from "./commands/bundle";
import { handleChannelDelete, handleSetChannel } from "./commands/channel";
import { handleDoctor } from "./commands/doctor";
import {
  handleCreateFingerprint,
  handleFingerprintHash,
} from "./commands/fingerprint";
import { generate } from "./commands/generate";
import {
  handleInsightsEvents,
  handleInsightsFailures,
  handleInsightsInstallations,
  handleInsightsOverview,
  INSIGHTS_OUTCOMES,
  INSIGHTS_WINDOWS,
} from "./commands/insights";
import { keysExportPublic, keysRemove } from "./commands/keys";
import { migrate } from "./commands/migrate";
import {
  handleNativeBuildDelete,
  handleNativeBuildDownload,
  handleNativeBuildFind,
  handleNativeBuildTestFlightGroup,
  handleNativeBuildInstall,
} from "./commands/nativeBuild";
import { handleNativeBuildImport } from "./commands/nativeBuildImport";
import { handlePromote } from "./commands/promote";
import {
  handleRemoteConfigPreview,
  handleRemoteConfigPublish,
  handleRemoteConfigRollback,
  handleRemoteConfigShow,
  handleRemoteConfigVersions,
} from "./commands/remoteConfig";
import {
  handleSecretsImport,
  handleSecretsIssue,
  handleSecretsPut,
  ISSUED_KINDS,
  SECRET_KINDS,
} from "./commands/secrets";
import {
  DEFAULT_PULL_FILE,
  handleSecretsPull,
  type SecretsPullOptions,
} from "./commands/secretsPull";
import { handleSigningKeyIssue } from "./commands/signingKey";
import {
  DEFAULT_STORAGE_PRUNE_PROTECTION_MS,
  handleStoragePrune,
  parseStoragePruneProtection,
} from "./commands/storage";
import { handleUploadKeyIssue } from "./commands/uploadKey";
import { ui } from "./utils/cli-ui";

const DEFAULT_CHANNEL = "production";
const parseBooleanOption = (value: string) => {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new InvalidArgumentError("must be true or false");
};

const parseRolloutCohortCount = (value: string) => {
  const count = Number.parseInt(value, 10);
  if (!Number.isInteger(count) || count < 0 || count > 1000) {
    throw new InvalidArgumentError("must be an integer between 0 and 1000");
  }
  return count;
};

const program = new Command();

program
  .name("hot-updater")
  .description(banner(version))
  .version(version as string);

const infraCommand = program
  .command("infra")
  .description("Infrastructure templates");
infraCommand
  .command("scaffold")
  .description("Extract server templates for deployment with provider tools")
  .addOption(
    new Option("--provider <provider>", "infrastructure provider")
      .choices(INIT_PROVIDER_NAMES)
      .makeOptionMandatory(),
  )
  .option(
    "--output <directory>",
    "scaffold destination; preserves existing files",
  )
  .option("--json", "output scaffold paths as JSON")
  .action((options) => handleInfraScaffold("scaffold", options));

const agentCommand = program
  .command("agent")
  .description("Instructions and scaffolds for AI agents");
const agentInfraCommand = agentCommand
  .command("infra")
  .description("Prepare infrastructure templates for agents to apply");

for (const operation of ["setup", "upgrade"] as const) {
  agentInfraCommand
    .command(operation)
    .description(
      `Generate infrastructure ${operation} templates and agent instructions`,
    )
    .addOption(
      new Option("--provider <provider>", "infrastructure provider").choices(
        INIT_PROVIDER_NAMES,
      ),
    )
    .addOption(
      new Option("--build <adapter>", "app build adapter").choices([
        "bare",
        "rock",
        "expo",
      ]),
    )
    .option(
      "--output <directory>",
      "scaffold destination; preserves existing files",
    )
    .option("--json", "output instructions or scaffold paths as JSON")
    .action((options) => handleAgentInfra(operation, options));
}

program
  .command("init")
  .description("Initialize Hot Updater")
  .addOption(
    new Option(
      "--provider <provider>",
      "provider to use; skips the prompt",
    ).choices(INIT_PROVIDER_NAMES),
  )
  .addOption(
    new Option(
      "--build <adapter>",
      "build adapter to use; skips the prompt",
    ).choices(["bare", "rock", "expo"]),
  )
  .option(
    "--from-env-file <path>",
    "load saved init inputs and fail if any are missing",
  )
  .addHelpText("after", initHelp)
  .action(({ fromEnvFile, ...options }) =>
    init({ ...options, envFile: fromEnvFile }),
  );

program
  .command("doctor")
  .description("Check the health of Hot Updater")
  .option(
    "--server-base-url <url>",
    "server base URL used by update checks (doctor appends /version)",
  )
  .addOption(
    new Option("--scope <scope>", "required verification scope").choices([
      "scaffold",
      "infrastructure",
    ]),
  )
  .option("--infra-dir <directory>", "exact scaffold directory to verify")
  .addOption(
    new Option("--platform <platform>", "catalog platform to verify").choices([
      "ios",
      "android",
    ]),
  )
  .option("--channel <channel>", "catalog channel to verify")
  .option("--app-version <version>", "app-version catalog target")
  .option("--fingerprint <hash>", "fingerprint catalog target")
  .option("--json", "output machine-readable doctor result")
  .action(handleDoctor);

const fingerprintCommand = program
  .command("fingerprint")
  .description("Manage fingerprint.json for the fingerprint update strategy");

fingerprintCommand
  .command("create")
  .description(
    "Create fingerprint.json, which native builds read to embed each platform's fingerprint",
  )
  .action(handleCreateFingerprint);

fingerprintCommand
  .command("hash")
  .description(
    "Print the fingerprint a native build embeds, from the inputs fingerprint.json records",
  )
  .addOption(
    new Option("-p, --platform <platform>", "the platform to fingerprint")
      .choices(["ios", "android"])
      .makeOptionMandatory(),
  )
  .action(handleFingerprintHash);

const channelCommand = program
  .command("channel")
  .description("Manage channels");

channelCommand
  .command("set")
  .description(
    "Set the native default channel for Android (AndroidManifest.xml) and iOS (Info.plist)",
  )
  .argument("<channel>", "the channel to set")
  .action(handleSetChannel);

channelCommand
  .command("delete")
  .description(
    "Delete a channel and its bundles, such as a closed pull request's",
  )
  .argument("<channel>", "the channel to delete")
  .option(
    "--native-builds",
    "also delete the native builds that embed the channel, with their artifacts",
  )
  .option("--json", "output the result as JSON")
  .option("-y, --yes", "skip confirmation prompt")
  .action(handleChannelDelete);

const nativeBuildCommand = program
  .command("native-build")
  .description(
    "Build native apps, and find, download, install and delete the builds Hot Updater tracks",
  );

nativeBuildCommand
  .command("find")
  .description(
    "Find the newest registered native build a build of this project would match, such as before a pull request's preview build",
  )
  .addOption(
    new Option("-p, --platform <platform>", "the build's platform")
      .choices(["ios", "android"])
      .makeOptionMandatory(),
  )
  .option(
    "-c, --channel <channel>",
    "the channel the build embeds (default: the native project's default channel)",
  )
  .option(
    "-s, --scheme <scheme>",
    "the nativeBuild scheme, whose app's version the build has with the appVersion strategy",
  )
  .option(
    "--store-status",
    "ask the store what a build this project submitted is doing there (takes --scheme)",
  )
  .option(
    "--json",
    "output the scope, the build or null, and the storage's download URL or null, as JSON",
  )
  .action(handleNativeBuildFind);

nativeBuildCommand
  .command("download")
  .description(
    "Download a registered native build's artifact through the config's storage, such as in a script",
  )
  .argument("<id>", "the native build's ID, as native-build find prints it")
  .option(
    "-o, --output <path>",
    "the file or directory to write (default: the artifact's name in the current directory)",
  )
  .option("--json", "output the file's path and size as JSON")
  .action(handleNativeBuildDownload);

nativeBuildCommand
  .command("install")
  .description(
    "Download a registered simulator .app or .apk, install it on a booted iOS Simulator or a connected Android device, and open it",
  )
  .argument("<id>", "the native build's ID, as native-build find prints it")
  .option(
    "--simulator <udid>",
    "the booted iOS Simulator (default: the only one booted)",
  )
  .option(
    "--device <serial>",
    "the Android device or emulator, as adb devices lists it (default: ANDROID_SERIAL, or the only one connected)",
  )
  .option("--json", "output the device and the app as JSON")
  .action(handleNativeBuildInstall);

nativeBuildCommand
  .command("testflight-group")
  .description(
    "Add a sandbox build already on TestFlight to an internal group, with no new upload",
  )
  .argument("<id>", "the native build's ID, as native-build find prints it")
  .argument("<group>", "the internal TestFlight group")
  .requiredOption(
    "-s, --scheme <scheme>",
    "the sandbox nativeBuild scheme, whose app and key it reads",
  )
  .option("--json", "output what App Store Connect says of the build as JSON")
  .action(handleNativeBuildTestFlightGroup);

nativeBuildCommand
  .command("delete")
  .description(
    "Delete a registered native build and its stored artifact, such as a finished QA build's",
  )
  .argument("<id>", "the native build's ID, as native-build find prints it")
  .option("--json", "output the result as JSON")
  .option("-y, --yes", "skip confirmation prompt")
  .action(handleNativeBuildDelete);

nativeBuildCommand
  .command("import")
  .description(
    "Track an .ipa, .aab, .apk or simulator .app built elsewhere, such as by another build service or an earlier release, as an OTA patch base: OTAs deployed after it patch from its built-in bundle. Importing the same build again succeeds and changes nothing",
  )
  .argument(
    "<file>",
    "the release build's .ipa, .aab or .apk, or a simulator .app (or its .app.zip)",
  )
  .option(
    "-c, --channel <channel>",
    "the channel the app reports, when its code sets one or it switches to one at runtime (default: the channel the build compiled in)",
  )
  .option("--dry-run", "read and check the artifact, and record nothing")
  .option(
    "--json",
    "print what was read, and the registered build or why it can't be imported, as JSON on the last line of the output",
  )
  .action(handleNativeBuildImport);

nativeBuildCommand
  .command("ios")
  .description(
    "Build an iOS .ipa, or a simulator .app, and track it in Hot Updater as an OTA patch base and preview build",
  )
  .addOption(nativeBuildSchemeCommandOption)
  .addOption(nativeBuildOutputCommandOption)
  .addOption(testFlightSubmitCommandOption)
  .addOption(testFlightGroupCommandOption)
  .addOption(whatToTestCommandOption)
  .addOption(nativeBuildDryRunCommandOption)
  .addOption(nativeBuildNoCacheCommandOption)
  .addOption(nativeBuildJsonCommandOption)
  .action(async (options: NativeBuildCreateOptions) => {
    await handleNativeBuildCreate("ios", options);
  });

nativeBuildCommand
  .command("android")
  .description(
    "Build an Android .aab or .apk, and track it in Hot Updater as an OTA patch base and preview build",
  )
  .addOption(nativeBuildSchemeCommandOption)
  .addOption(nativeBuildOutputCommandOption)
  .addOption(playSubmitCommandOption)
  .addOption(nativeBuildDryRunCommandOption)
  .addOption(nativeBuildNoCacheCommandOption)
  .addOption(nativeBuildJsonCommandOption)
  .action(async (options: NativeBuildCreateOptions) => {
    await handleNativeBuildCreate("android", options);
  });

const SERVER_PATH_HELP =
  "path to the server definition that exports hotUpdater (default: database and plugins in hot-updater.config.ts, else src/hotUpdater.ts or src/db.ts)";

const apiKeyCommand = program.command("api-key").description("Manage API keys");

apiKeyCommand
  .command("create")
  .description("Create an API key")
  .requiredOption("--name <name>", "name used to identify the API key")
  .argument("[serverPath]", SERVER_PATH_HELP)
  .action((serverPath: string | undefined, options: { name: string }) =>
    handleApiKeyCreate(options.name, { serverPath }),
  );

apiKeyCommand
  .command("list")
  .description("List API keys")
  .option("--json", "output API key metadata as JSON")
  .argument("[serverPath]", SERVER_PATH_HELP)
  .action((serverPath: string | undefined, options: { json?: boolean }) =>
    handleApiKeyList({ ...options, serverPath }),
  );

apiKeyCommand
  .command("revoke")
  .description("Revoke an API key")
  .argument("<id>", "API key id")
  .argument("[serverPath]", SERVER_PATH_HELP)
  .option("-y, --yes", "skip confirmation prompt")
  .action(
    (id: string, serverPath: string | undefined, options: { yes?: boolean }) =>
      handleApiKeyRevoke(id, { ...options, serverPath }),
  );

/** An option's whole number from `min` to `max`. */
const integerFrom =
  (min: number, max = Number.MAX_SAFE_INTEGER) =>
  (value: string): number => {
    const n = Number(value);
    if (
      !/^\d+$/u.test(value) ||
      !Number.isSafeInteger(n) ||
      n < min ||
      n > max
    ) {
      throw new InvalidArgumentError(
        max === Number.MAX_SAFE_INTEGER
          ? `must be an integer of at least ${min}`
          : `must be an integer from ${min} to ${max}`,
      );
    }
    return n;
  };

/** A comma-separated option, which may also repeat. */
const commaSeparated = (value: string, previous: readonly string[] = []) => [
  ...previous,
  ...value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
];

const secretsCommand = program
  .command("secrets")
  .description(
    "Store build credentials in the secrets adapter, or pull deploy credentials to a local env file",
  );

secretsCommand
  .command("put")
  .description(
    'Store a credential you have as the value secret("<name>") resolves',
  )
  .argument("<name>", "the secret's name, such as release-keystore")
  .argument(
    "[file]",
    "the file to store: the service account's JSON key, the keystore, the .p8 key, or the signing key's PEM",
  )
  .addOption(
    new Option(
      "--kind <kind>",
      "what the secret holds (default: the name, when it is a kind)",
    ).choices(SECRET_KINDS),
  )
  .option("--p8 <file>", "asc-api-key: the .p8 key file")
  .option("--key-id <id>", "asc-api-key: the key ID")
  .option("--issuer-id <id>", "asc-api-key: the issuer ID")
  .option(
    "--keystore <file>",
    "android-keystore: the keystore file; its passwords come from HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD and HOT_UPDATER_ANDROID_KEY_PASSWORD, or a prompt",
  )
  .option("--key-alias <alias>", "android-keystore: the key's alias")
  .option(
    "--service-account <file>",
    "play-service-account: the service account's JSON key file",
  )
  .addHelpText(
    "after",
    [
      "",
      "Google Play:",
      "  secrets put play-service-account <key.json>",
      "  secrets put android-keystore <upload.jks>",
      "At a terminal, a keystore without --key-alias asks for its passwords.",
      "",
      "Bundle signing, with a key you have:",
      "  secrets put bundle-signing-key <key.pem>",
      "To sign in and issue an App Store Connect API key, run apple login.",
    ].join("\n"),
  )
  .action((name: string, file: string | undefined, options) =>
    handleSecretsPut(name, { ...options, ...(file ? { file } : {}) }),
  );

secretsCommand
  .command("import")
  .description(
    "Store the deploy credentials an env file sets in the team secrets adapter",
  )
  .argument("[env-file]", "the env file to read (default: .env.hotupdater)")
  .addHelpText(
    "after",
    "\nIt reads only the file, reads each value back, and deletes nothing: where the file is loaded, its lines still override the adapter.",
  )
  .action((envFile?: string) => handleSecretsImport(envFile));

secretsCommand
  .command("pull")
  .description(
    "Write the deploy credentials the team secrets adapter holds to a local env file",
  )
  .option("--out <file>", "the env file to write", DEFAULT_PULL_FILE)
  .option(
    "--only <names>",
    "pull exactly these secrets, comma-separated, whether the config names them or not",
    commaSeparated,
  )
  .option("--force", "replace a value the file holds without asking")
  .addHelpText(
    "after",
    [
      "",
      "Stores are read by name, with no list of what they hold. Without --only",
      "it pulls the names the config's secret()s read for its adapters, and",
      "HOT_UPDATER_API_KEY. It is not for the app's runtime env.",
      "",
      "Build credentials stay in the store, where builds read them.",
      "The file's lines override the store on this machine.",
    ].join("\n"),
  )
  .action((options: SecretsPullOptions) => handleSecretsPull(options));

secretsCommand
  .command("issue")
  .description(
    "Sign in, at a terminal, and store the App Store Connect API key Hot Updater issues, or create an Android upload key or a bundle signing key",
  )
  .addArgument(
    new Argument("<kind>", "what to issue").choices([
      ...ISSUED_KINDS,
      "android-keystore",
      "bundle-signing-key",
    ]),
  )
  .argument(
    "[name]",
    "the secret's name, which builds resolve (default: the kind)",
  )
  .option(
    "--replace",
    "issue a new key even when one is stored; the old key stays valid until you revoke it",
  )
  .option(
    "--pem <file>",
    "android-keystore: write the upload key's certificate, for Play Console's upload key reset",
  )
  .addHelpText(
    "after",
    [
      "",
      "asc-api-key signs in to your Apple Account in Hot Updater's own prompts.",
      "",
      "A key already stored, or set by the environment, is kept. --replace never",
      "revokes the old key: it names the key and where to revoke it.",
      "In CI or without a terminal it never signs in; store a key you have with",
      "secrets put instead.",
      "",
      "android-keystore creates a new upload key with the JDK's keytool. It fits",
      "only an app with no .aab on Google Play yet: Play keeps the first key.",
      "A stored keystore is kept; --replace overwrites it, so back it up first.",
      "",
      "bundle-signing-key creates an RSA key and sets signing in the config.",
      "A stored key is kept: apps already shipped reject a new key's bundles.",
    ].join("\n"),
  )
  .action(async (kind, name, options) => {
    if (kind === "android-keystore") {
      await handleUploadKeyIssue(name ?? kind, options);
      return;
    }
    if (options.pem !== undefined) {
      p.log.error(`--pem is for android-keystore, not ${kind}.`);
      process.exitCode = 1;
      return;
    }
    if (kind === "bundle-signing-key") {
      await handleSigningKeyIssue(name ?? kind, { replace: options.replace });
      return;
    }
    await handleSecretsIssue(kind, name ?? kind, { replace: options.replace });
  });

/**
 * `apple login`: the shortcut of `secrets issue` people meet first, with
 * its handler and options. Hot Updater keeps no session, so there is no
 * logout or whoami.
 */
const LOGIN_COMMANDS = [
  {
    kind: "asc-api-key",
    group:
      "Sign in to your Apple Account and store the App Store Connect API key Hot Updater issues",
    description:
      "Sign in to your Apple Account and store the App Store Connect API key Hot Updater issues",
    signIn: "signs in to your Apple Account in Hot Updater's own prompts",
  },
] as const satisfies readonly {
  kind: (typeof ISSUED_KINDS)[number];
  group: string;
  description: string;
  signIn: string;
}[];

/**
 * A shortcut takes nothing but what it declares: anything else, an option or
 * an argument, exits 1 on two short lines, with the full command to run
 * instead, labeled, as `instead` names it for what was passed.
 */
const onlyShortcut = (
  command: { readonly args: readonly string[] },
  shortcut: string,
  takes: string,
  instead: (args: readonly string[]) => readonly [label: string, run: string],
) => {
  if (command.args.length === 0) return true;
  const [label, run] = instead(command.args);
  p.log.error(
    [
      `${shortcut} takes ${takes}.`,
      `${label}: ${ui.command(`npx hot-updater ${run}`)}`,
    ].join("\n"),
  );
  process.exitCode = 1;
  return false;
};

/** The `apple` command, by the kind it logs in for. */
for (const { kind, group, description, signIn } of LOGIN_COMMANDS) {
  const groupCommand = program
    .command(CREDENTIAL_LOGIN_GROUPS[kind])
    .description(group);
  const shortcut = `${CREDENTIAL_LOGIN_GROUPS[kind]} login`;
  groupCommand
    .command("login")
    .description(
      `Alias of hot-updater secrets issue ${kind}: ${description[0]!.toLowerCase()}${description.slice(1)}`,
    )
    .allowUnknownOption()
    .allowExcessArguments()
    .addHelpText(
      "after",
      [
        "",
        `Alias of \`hot-updater secrets issue ${kind}\`: it ${signIn}, at a terminal only, never in CI.`,
        "Hot Updater keeps no session: only the key it issues stays, so there is no logout or whoami.",
        `A key already stored, or set by the environment, is kept. It takes no options: for another name or a new key, run \`hot-updater secrets issue ${kind} <name> --replace\`.`,
      ].join("\n"),
    )
    .action(async (_options, command) => {
      if (
        !onlyShortcut(command, shortcut, "no options or arguments", (args) =>
          args.includes("--replace")
            ? ["New key", `secrets issue ${kind} --replace`]
            : ["Full command", `secrets issue ${kind} --help`],
        )
      ) {
        return;
      }
      await handleSecretsIssue(kind, kind);
    });
}

program
  .command("google-play")
  .description(
    "Google Play: upload builds an .aab and releases it to the internal track",
  )
  .command("upload")
  .description(
    "Shortcut for hot-updater native-build android --submit play-internal: build the .aab, track it, and release it to Google Play's internal track",
  )
  .option(
    "-s, --scheme <scheme>",
    "the nativeBuild.android scheme (default: the only one that uploads to Google Play, else a prompt at a terminal)",
  )
  .allowUnknownOption()
  .allowExcessArguments()
  .addHelpText(
    "after",
    [
      "",
      "Shortcut for `hot-updater native-build android --scheme <scheme> --submit play-internal`.",
      "It takes only --scheme; for --json or --output-path, run native-build android.",
      "Before it builds, it checks the service account key, the upload keystore,",
      "and Play access, and lists everything missing. Store the files with:",
      "  secrets put play-service-account <key.json>",
      "  secrets put android-keystore <upload.jks>",
    ].join("\n"),
  )
  .action(async (options: StoreUploadOptions, command) => {
    if (
      !onlyShortcut(command, "google-play upload", "only --scheme", () => [
        "Full command",
        "native-build android --submit play-internal",
      ])
    ) {
      return;
    }
    await handleGooglePlayUpload(options);
  });

const remoteConfigCommand = program
  .command("remote-config")
  .description("Show, publish, and roll back Remote Config templates");

remoteConfigCommand
  .command("show")
  .description("Show the active template, or a published version's")
  .option("--version-number <n>", "show this published version", integerFrom(1))
  .option("--json", "output the template and its version as JSON")
  .argument("[serverPath]", SERVER_PATH_HELP)
  .action((serverPath: string | undefined, options) =>
    handleRemoteConfigShow({ ...options, serverPath }),
  );

remoteConfigCommand
  .command("versions")
  .description("List published versions, newest first")
  .option(
    "--limit <n>",
    "versions per page, from 1 to 100",
    integerFrom(1, 100),
    20,
  )
  .option("--cursor <cursor>", "the next page, as the last page printed it")
  .option("--json", "output the page as JSON")
  .argument("[serverPath]", SERVER_PATH_HELP)
  .action((serverPath: string | undefined, options) =>
    handleRemoteConfigVersions({ ...options, serverPath }),
  );

remoteConfigCommand
  .command("publish")
  .description("Publish a template file as the next version")
  .argument(
    "<file>",
    "a template JSON file, or what show --json prints; - reads stdin",
  )
  .argument("[serverPath]", SERVER_PATH_HELP)
  .option("--description <text>", "a note for the version")
  .option(
    "--expected-version <n>",
    "fail if the active version is not this one (default: the version show --json printed, else the active one)",
    integerFrom(0),
  )
  .option("--dry-run", "validate and show the changes without publishing")
  .option("-y, --yes", "skip confirmation prompt")
  .option("--json", "output the result as JSON")
  .action((file: string, serverPath: string | undefined, options) =>
    handleRemoteConfigPublish(file, { ...options, serverPath }),
  );

remoteConfigCommand
  .command("rollback")
  .description("Publish a copy of an earlier version as the next version")
  .argument("<version>", "the version to copy", integerFrom(1))
  .argument("[serverPath]", SERVER_PATH_HELP)
  .option("--description <text>", "a note for the version")
  .option(
    "--expected-version <n>",
    "fail if the active version is not this one",
    integerFrom(0),
  )
  .option("-y, --yes", "skip confirmation prompt")
  .option("--json", "output the result as JSON")
  .action((version: number, serverPath: string | undefined, options) =>
    handleRemoteConfigRollback(version, { ...options, serverPath }),
  );

remoteConfigCommand
  .command("preview")
  .description("Show the values a device gets")
  .addOption(platformCommandOption)
  .option("-c, --channel <channel>", "the device's channel")
  .option("--app-version <version>", "the device's app version")
  .option("--cohort <cohort>", "the device's cohort")
  .option("--fingerprint-hash <hash>", "the device's fingerprint hash")
  .option("--at <date-time>", "when, as an ISO 8601 date-time (default: now)")
  .addOption(
    new Option(
      "--version-number <n>",
      "preview this published version (default: the active one)",
    )
      .argParser(integerFrom(1))
      .conflicts("file"),
  )
  .option("--file <file>", "preview a template file before publishing it")
  .option("--json", "output the values as JSON")
  .argument("[serverPath]", SERVER_PATH_HELP)
  .action((serverPath: string | undefined, options) =>
    handleRemoteConfigPreview({
      ...options,
      platform: options.platform as "ios" | "android" | undefined,
      serverPath,
    }),
  );

const insightsCommand = program
  .command("insights")
  .description("Read Insights: reporting devices, update failures, and events");

const insightsWindowOption = () =>
  new Option("--window <window>", "the period that ends with the current hour")
    .choices(INSIGHTS_WINDOWS)
    .default("24h" as const);

const addInsightsScope = <
  TArgs extends unknown[],
  TOptions extends Record<string, unknown>,
  TGlobalOptions extends Record<string, unknown>,
>(
  command: Command<TArgs, TOptions, TGlobalOptions>,
) =>
  command
    .option(
      "--bundle <id>",
      "a bundle, by the ID shown in the console or hotUpdater.getBundleId()",
    )
    .addOption(platformCommandOption)
    .option("-c, --channel <channel>", "the channel, with --platform")
    .addOption(insightsWindowOption())
    .option("--json", "output the result as JSON")
    .argument("[serverPath]", SERVER_PATH_HELP);

addInsightsScope(
  insightsCommand
    .command("overview")
    .description("Count a channel's reporting devices, or a bundle's reports"),
).action((serverPath: string | undefined, options) =>
  handleInsightsOverview({
    ...options,
    platform: options.platform as "ios" | "android" | undefined,
    serverPath,
  }),
);

addInsightsScope(
  insightsCommand
    .command("failures")
    .description("Show a channel's or a bundle's update failures"),
).action((serverPath: string | undefined, options) =>
  handleInsightsFailures({
    ...options,
    platform: options.platform as "ios" | "android" | undefined,
    serverPath,
  }),
);

insightsCommand
  .command("events")
  .description(
    "List reports, newest first: all, a bundle's, or an installation's",
  )
  .option("--bundle <id>", "a bundle's reports, with --outcome")
  .addOption(
    new Option("--outcome <outcome>", "which of the bundle's reports").choices(
      Object.keys(INSIGHTS_OUTCOMES) as (keyof typeof INSIGHTS_OUTCOMES)[],
    ),
  )
  .option("--install <id>", "an installation's reports")
  .option(
    "--limit <n>",
    "events per page, from 1 to 100",
    integerFrom(1, 100),
    20,
  )
  .option("--cursor <cursor>", "the next page, as the last page printed it")
  .option("--json", "output the page as JSON")
  .argument("[serverPath]", SERVER_PATH_HELP)
  .action((serverPath: string | undefined, options) =>
    handleInsightsEvents({ ...options, serverPath }),
  );

insightsCommand
  .command("installations")
  .description("Find an installation by its install ID, or by user ID")
  .argument("<id>", "an install ID, or the user ID the app set")
  .argument("[serverPath]", SERVER_PATH_HELP)
  .option(
    "--limit <n>",
    "installations per page, from 1 to 100",
    integerFrom(1, 100),
    20,
  )
  .option("--cursor <cursor>", "the next page, as the last page printed it")
  .option("--json", "output the installations as JSON")
  .action((id: string, serverPath: string | undefined, options) =>
    handleInsightsInstallations(id, { ...options, serverPath }),
  );

const bundleCommand = program.command("bundle").description("Manage bundles");

bundleCommand
  .command("list")
  .description("List bundles, most recent first")
  .option("-c, --channel <channel>", "filter by channel")
  .option(
    "--target-app-version <targetAppVersion>",
    "filter by exact target app version",
  )
  .option("--json", "output raw internal data as JSON")
  .addOption(platformCommandOption)
  .option(
    "--limit <n>",
    "limit the number of results",
    (value) => {
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n) || n <= 0 || n > 1000) {
        throw new InvalidArgumentError("must be an integer from 1 to 1000");
      }
      return n;
    },
    20,
  )
  .action(handleBundleList);

bundleCommand
  .command("show")
  .description("Show one bundle by ID")
  .argument("<id>", "the ID shown in the console or hotUpdater.getBundleId()")
  .option("--json", "output raw internal data as JSON")
  .action((id: string, options: { json?: boolean }) =>
    handleBundleShow(id, options),
  );

const addBundlePolicyOptions = <
  TArgs extends unknown[],
  TOptions extends Record<string, unknown>,
  TGlobalOptions extends Record<string, unknown>,
>(
  command: Command<TArgs, TOptions, TGlobalOptions>,
) =>
  command
    .option("--message <message>", "set the bundle message")
    .option("--clear-message", "clear the bundle message")
    .option(
      "--target-app-version <range>",
      "set the app-version compatibility range",
    )
    .option(
      "--rollout-cohort-count <count>",
      "rollout cohort count from 0 to 1000",
      parseRolloutCohortCount,
    )
    .option(
      "--force-update <value>",
      "set the force-update flag",
      parseBooleanOption,
    )
    .option(
      "--target-cohorts <cohorts>",
      "comma-separated public target cohort names",
    )
    .option("--clear-target-cohorts", "clear public target cohort names")
    .option(
      "--expected-revision <revision>",
      "fail if the bundle revision changed",
      (value) => {
        const revision = Number.parseInt(value, 10);
        if (!Number.isSafeInteger(revision) || revision < 1) {
          throw new InvalidArgumentError("must be a positive integer");
        }
        return revision;
      },
    )
    .option("--json", "output JSON");

addBundlePolicyOptions(
  bundleCommand
    .command("update")
    .description("Update bundle rollout and targeting")
    .argument("<id>", "the ID shown in the console or hotUpdater.getBundleId()")
    .option(
      "--dry-run",
      "validate the update and show the projected catalog without saving",
    )
    .option("-y, --yes", "skip confirmation prompt"),
).action(handleBundleUpdate);

for (const [name, enabled] of [
  ["enable", true],
  ["disable", false],
] as const) {
  bundleCommand
    .command(name)
    .description(
      enabled
        ? "Enable a bundle"
        : "Disable a bundle and re-resolve compatible delivery",
    )
    .argument("<id>", "the ID shown in the console or hotUpdater.getBundleId()")
    .option(
      "--expected-revision <revision>",
      "expected bundle revision",
      (value) => {
        const revision = Number.parseInt(value, 10);
        if (!Number.isSafeInteger(revision) || revision < 1) {
          throw new InvalidArgumentError("must be a positive integer");
        }
        return revision;
      },
    )
    .option("--json", "output JSON")
    .option("-y, --yes", "skip confirmation prompt")
    .action((releaseId, options) =>
      handleBundleEnablement(releaseId, enabled, options),
    );
}

bundleCommand
  .command("delete")
  .description("Delete a disabled bundle")
  .argument("<id>", "the ID shown in the console or hotUpdater.getBundleId()")
  .option(
    "--expected-revision <revision>",
    "expected bundle revision",
    (value) => {
      const revision = Number.parseInt(value, 10);
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new InvalidArgumentError("must be a positive integer");
      }
      return revision;
    },
  )
  .option("--json", "output JSON")
  .option("-y, --yes", "skip confirmation prompt")
  .action(handleBundleDelete);

bundleCommand
  .command("promote")
  .description("Copy or move a bundle to another channel")
  .argument("<source-id>", "the source ID shown in the console")
  .requiredOption("-t, --target <channel>", "target channel")
  .addOption(
    new Option(
      "-a, --action <action>",
      "copy keeps the source enabled; move disables it",
    )
      .choices(["copy", "move"])
      .default("copy"),
  )
  .option("-y, --yes", "skip confirmation prompt")
  .action(
    (
      sourceReleaseId: string,
      options: {
        target: string;
        action: "copy" | "move";
        yes?: boolean;
      },
    ) => handlePromote(sourceReleaseId, options),
  );

const storageCommand = program
  .command("storage")
  .description("Manage stored bundle artifacts");

storageCommand
  .command("prune")
  .description("Find or delete unreferenced bundle objects and shared assets")
  .addOption(
    new Option(
      "--protect-newer-than <duration>",
      "protect unreferenced objects modified within this duration",
    )
      .argParser((value) => {
        try {
          return parseStoragePruneProtection(value);
        } catch (error) {
          throw new InvalidArgumentError(
            error instanceof Error ? error.message : String(error),
          );
        }
      })
      .default(DEFAULT_STORAGE_PRUNE_PROTECTION_MS, "24h"),
  )
  .addOption(
    new Option(
      "--dry-run",
      "list eligible objects without deleting them (default)",
    ).conflicts("yes"),
  )
  .addOption(
    new Option(
      "-y, --yes",
      "delete eligible objects after reference validation",
    ).conflicts("dryRun"),
  )
  .addHelpText(
    "after",
    `
Examples:
  $ hot-updater storage prune --dry-run
  $ hot-updater storage prune --protect-newer-than 24h --yes

Only unreferenced bundle objects and shared assets are eligible.
Protection uses object modification time, not time since bundle deletion.
Deletion requires exclusive storage access; stop deploy and patch first.
Object listing and deletion require a capable Storage adapter such as s3Storage.
`,
  )
  .action(
    (options: { dryRun?: boolean; protectNewerThan: number; yes?: boolean }) =>
      handleStoragePrune(options),
  );

const keysCommand = program
  .command("keys")
  .description("Embed or remove the bundle signing public key");

keysCommand
  .command("export-public")
  .description("Export public key for native configuration")
  .option(
    "-p, --print-only",
    "only print the public key without writing to native files",
  )
  .option(
    "-o, --output <path>",
    "write the public key to an Expo trust-anchor file",
  )
  .option("-y, --yes", "skip confirmation prompt when writing to native files")
  .action(keysExportPublic);

keysCommand
  .command("remove")
  .description("Remove public keys from native configuration files")
  .option("-y, --yes", "skip confirmation prompt")
  .action(keysRemove);

program
  .command("deploy")
  .description("Build and deploy a bundle")
  .addOption(platformCommandOption)
  .addOption(
    new Option(
      "-t, --target-app-version <targetAppVersion>",
      "specify the target app version (semver format e.g. 1.0.0, 1.x.x)",
    ).argParser((value) => {
      if (!normalizeRange(value)) {
        p.log.error("Invalid semver format (e.g. 1.0.0, 1.x.x)");
        process.exit(1);
      }
      return value;
    }),
  )
  .addOption(
    new Option("-d, --disabled", "create the bundle disabled").default(false),
  )
  .addOption(
    new Option("-f, --force-update", "force update the app").default(false),
  )
  .addOption(
    new Option(
      "-o, --bundle-output-path <bundleOutputPath>",
      "the directory where bundle archives will be generated",
    ),
  )
  .addOption(
    new Option(
      "-r, --rollout <percentage>",
      "specify the rollout percentage for the new bundle (0-100)",
    )
      .argParser((value) => {
        try {
          return normalizeRolloutPercentage(value);
        } catch (error) {
          if (error instanceof Error) {
            p.log.error(error.message);
            process.exit(1);
          }
          throw error;
        }
      })
      .default(100),
  )
  .addOption(interactiveCommandOption)
  .addOption(
    new Option(
      "-c, --channel <channel>",
      "specify the channel to deploy",
    ).default(DEFAULT_CHANNEL),
  )
  .addOption(
    new Option(
      "-m, --message <message>",
      "Specify a custom message for this deployment. If not provided, the latest git commit message will be used as the deployment message",
    ),
  )
  .action(async (options: DeployOptions) => deploy(options));

program
  .command("patch")
  .description("create patch artifacts for a deployed bundle")
  .requiredOption(
    "-b, --artifact-id <artifact-id>",
    "target artifact ID from Advanced diagnostics",
  )
  .requiredOption(
    "--base-artifact-id <artifact-id>",
    "older artifact ID from Advanced diagnostics to use as the patch base",
  )
  .addOption(platformCommandOption)
  .addOption(interactiveCommandOption)
  .addOption(
    new Option(
      "-c, --channel <channel>",
      "specify the channel used to load config",
    ).default(DEFAULT_CHANNEL),
  )
  .action(async ({ artifactId, baseArtifactId, ...options }) => {
    await createPatch({
      ...options,
      bundleId: artifactId,
      baseBundleId: baseArtifactId,
    } satisfies PatchOptions);
  });

program
  .command("console")
  .description("open the console")
  .action(async () => {
    printBanner();

    const port = await getConsolePort();

    if (await isPortReachable(port, { host: "127.0.0.1" })) {
      p.log.error(
        `Port ${port} is already in use.\nSet console.port in hot-updater.config.ts to use another port.`,
      );
      process.exit(1);
    }

    await openConsole(port, ({ session }) => {
      // The link carries this run's session: the console answers no
      // other browser or process.
      p.log.info(
        `Console:\n${withConsoleSession(`http://localhost:${port}`, session)}`,
      );
    });
  });

program
  .command("app-version")
  .description("get the current app version")
  .option("--json", "output app versions as JSON")
  .action(handleAppVersion);

// Database migration commands
const dbCommand = program
  .command("db")
  .description("Database migration commands");

// db migrate - Primary migration command (always to latest)
dbCommand
  .command("migrate")
  .description("Run database migration (creates tables directly in database)")
  .argument(
    "[configPath]",
    "path to the server definition that exports hotUpdater (default: src/hotUpdater.ts or src/db.ts)",
  )
  .option("-y, --yes", "skip confirmation prompt", false)
  .action(async (configPath: string | undefined, options: { yes: boolean }) => {
    await migrate({ configPath: configPath || "", skipConfirm: options.yes });
  });

// db generate - SQL generation command
dbCommand
  .command("generate")
  .description("Generate SQL migration file (does not execute)")
  .argument(
    "[configPath]",
    "path to the server definition that exports hotUpdater (default: src/hotUpdater.ts or src/db.ts; optional with --sql)",
  )
  .argument("[outputDir]", "output directory (default: hot-updater_migrations)")
  .option("-y, --yes", "skip confirmation prompt", false)
  .option(
    "--sql [provider]",
    "generate a standalone SQL file of core's tables and the server's plugins' tables, from the server definition or the plugins in hot-updater.config.ts when found. Optional provider: postgresql, mysql, sqlite (default: interactive selection)",
  )
  .action(
    async (
      configPath: string | undefined,
      outputDir: string | undefined,
      options: { yes: boolean; sql?: string | true },
    ) => {
      const sql = options.sql === true ? true : options.sql || false;

      await generate({
        configPath: configPath || "",
        outputDir,
        skipConfirm: options.yes,
        sql,
      });
      process.exit(0);
    },
  );

program
  .command("testflight")
  .description(
    "Shortcut for hot-updater native-build ios --submit testflight: build the .ipa, track it, and upload it to TestFlight",
  )
  .option(
    "-s, --scheme <scheme>",
    "the nativeBuild.ios scheme (default: the only one that uploads to TestFlight, else a prompt at a terminal)",
  )
  .allowUnknownOption()
  .allowExcessArguments()
  .addHelpText(
    "after",
    [
      "",
      "Shortcut for `hot-updater native-build ios --scheme <scheme> --submit testflight`.",
      "It takes only --scheme; for --json or --output-path, run native-build ios.",
      "Without an App Store Connect API key, it signs in to your Apple Account at a",
      "terminal, as native-build ios does; in CI it never signs in (run apple login once first).",
    ].join("\n"),
  )
  .action(async (options: StoreUploadOptions, command) => {
    if (
      !onlyShortcut(command, "testflight", "only --scheme", () => [
        "Full command",
        "native-build ios --submit testflight",
      ])
    ) {
      return;
    }
    await handleTestFlight(options);
  });

program.hook("preAction", (_command, actionCommand) => {
  if (
    actionCommand.parent === agentInfraCommand ||
    actionCommand.parent === infraCommand ||
    (actionCommand.name() === "doctor" &&
      actionCommand.opts()["scope"] !== undefined)
  )
    return;
  ensureNoConflicts();
});

program.parse(process.argv);
