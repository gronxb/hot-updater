/**
 * The client-route policy a managed server's plugins set, as the packaged
 * scaffold records it: null when client routes are public.
 */
export type InfraClientAuth = {
  /** The plugin that provides clientAuth. */
  plugin: string;
  /** The request headers its decision reads, which CDN caches key on. */
  varyHeaders: string[];
  /** The credential an app sends. */
  credential: {
    label: string;
    header: string;
    /** The environment variable that holds it. */
    env: string;
  };
} | null;

/** A client plugin a managed server's plugins ask an app to add. */
export type InfraClientPlugin = {
  /** The module that exports it. */
  module: string;
  /** The export, which the app calls with no arguments. */
  name: string;
};

/** What agent instructions depend on in the server's plugins. */
export interface AgentInstructionsContext {
  readonly sdkModule?: string;
  readonly clientAuth: InfraClientAuth;
  readonly clientPlugins: readonly InfraClientPlugin[];
}

/**
 * Saves and registers the app's credential; beside the scaffold's server
 * definition, whose database and plugins it uses.
 */
export const CLIENT_CREDENTIAL_SCRIPT = "provision-client-credential.mjs";

/** Where the script keeps the credential it generated, before registering it. */
export const CLIENT_CREDENTIAL_FILE = "client-credential.local";

const TOKENS = {
  "{{CREDENTIAL_LABEL}}": "label",
  "{{CREDENTIAL_HEADER}}": "header",
  "{{CREDENTIAL_ENV}}": "env",
} as const;

const CONDITIONS = ["credential", "clientPlugins"] as const;

type Condition = (typeof CONDITIONS)[number];

const isCondition = (value: string): value is Condition =>
  (CONDITIONS as readonly string[]).includes(value);

/**
 * The app's import lines for `HotUpdater` and `clientPlugins`: one line per
 * module, the SDK's first, so a built-in plugin such as `insights` joins
 * `HotUpdater`'s import. This module imports no package, since the scaffold's
 * standalone `verify-server.mjs` bundles it; `renderAppImports` in
 * `@hot-updater/cli-tools` prints the same lines for init.
 */
const appImportLines = (
  clientPlugins: readonly InfraClientPlugin[],
  sdkModule?: string,
): string[] => {
  const namesByModule = new Map<string, string[]>(
    sdkModule ? [[sdkModule, ["HotUpdater"]]] : [],
  );
  for (const { module, name } of clientPlugins) {
    const names = namesByModule.get(module) ?? [];
    if (!names.includes(name)) names.push(name);
    namesByModule.set(module, names);
  }
  return [
    ...(sdkModule
      ? []
      : ["// Import HotUpdater from your application integration."]),
    ...[...namesByModule].map(
      ([module, names]) =>
        `import { ${names.join(", ")} } from ${JSON.stringify(module)};`,
    ),
  ];
};

/**
 * A code line's app tokens: `{{APP_IMPORTS}}` becomes the app's import lines,
 * `HotUpdater` and the client plugins, one per module, and
 * `{{CLIENT_PLUGINS}}` the plugins' calls; without client plugins, that line
 * goes.
 */
const expandClientPlugins = (
  line: string,
  clientPlugins: readonly InfraClientPlugin[],
  sdkModule?: string,
): string[] => {
  if (line.includes("{{APP_IMPORTS}}")) {
    return appImportLines(clientPlugins, sdkModule).map((imports) =>
      // A function inserts the text as it is, `$` included.
      line.replace("{{APP_IMPORTS}}", () => imports),
    );
  }
  if (line.includes("{{CLIENT_PLUGINS}}")) {
    return clientPlugins.length === 0
      ? []
      : [
          line.replace("{{CLIENT_PLUGINS}}", () =>
            clientPlugins.map(({ name }) => `${name}()`).join(", "),
          ),
        ];
  }
  return [line];
};

/**
 * Renders agent instructions for a server's plugins. Lines between
 * `<!-- if credential -->` and `<!-- else -->` or `<!-- end -->` stay only
 * when the server takes a credential, and the `else` part only when its
 * client routes are public; `{{CREDENTIAL_*}}` names the credential.
 * `<!-- if clientPlugins -->` blocks stay only when the plugins ask an app
 * for client plugins, which `{{CLIENT_PLUGIN_LIST}}` names in prose;
 * `{{APP_IMPORTS}}` and `{{CLIENT_PLUGINS}}` render code lines.
 */
export const renderAgentInstructions = (
  text: string,
  { clientAuth, clientPlugins, sdkModule }: AgentInstructionsContext,
): string => {
  const holds: Record<Condition, boolean> = {
    credential: clientAuth !== null,
    clientPlugins: clientPlugins.length > 0,
  };
  const lines: string[] = [];
  let block: { condition: Condition; branch: "if" | "else" } | undefined;
  for (const [index, line] of text.split("\n").entries()) {
    const marker = line.trim();
    const at = `line ${index + 1}`;
    const opened = /^<!-- if (\w+) -->$/u.exec(marker)?.[1];
    if (opened !== undefined) {
      if (!isCondition(opened)) {
        throw new Error(`Unknown condition "${opened}" at ${at}.`);
      }
      if (block !== undefined) throw new Error(`Nested block at ${at}.`);
      block = { condition: opened, branch: "if" };
    } else if (marker === "<!-- else -->") {
      if (block?.branch !== "if") throw new Error(`Unexpected else at ${at}.`);
      block = { condition: block.condition, branch: "else" };
    } else if (marker === "<!-- end -->") {
      if (block === undefined) throw new Error(`Unexpected end at ${at}.`);
      block = undefined;
    } else if (
      block === undefined ||
      (block.branch === "if") === holds[block.condition]
    ) {
      lines.push(...expandClientPlugins(line, clientPlugins, sdkModule));
    }
  }
  if (block !== undefined) throw new Error("Unclosed block.");
  let rendered = lines.join("\n");
  for (const [token, key] of Object.entries(TOKENS)) {
    if (!rendered.includes(token)) continue;
    if (clientAuth === null) {
      throw new Error(`${token} appears outside a credential block.`);
    }
    rendered = rendered.replaceAll(token, () => clientAuth.credential[key]);
  }
  if (rendered.includes("{{CLIENT_PLUGIN_LIST}}")) {
    if (clientPlugins.length === 0) {
      throw new Error(
        "{{CLIENT_PLUGIN_LIST}} appears outside a clientPlugins block.",
      );
    }
    rendered = rendered.replaceAll("{{CLIENT_PLUGIN_LIST}}", () =>
      clientPlugins
        .map(({ module, name }) => `\`${name}()\` from \`${module}\``)
        .join(", "),
    );
  }
  return rendered;
};
