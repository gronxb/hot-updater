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
  readonly clientAuth: InfraClientAuth;
  readonly clientPlugins: readonly InfraClientPlugin[];
}

/** Saves and registers the app's credential; beside the scaffold's app config. */
export const CLIENT_CREDENTIAL_SCRIPT = "provision-client-credential.mjs";

/** Where the script keeps the credential it generated, before registering it. */
export const CLIENT_CREDENTIAL_FILE = "client-credential.local";

/** The script's database config, named for its build like hot-updater.config. */
export const CLIENT_CREDENTIAL_CONFIG = "database.config";

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
 * A code line's client plugin tokens: `{{CLIENT_PLUGIN_IMPORTS}}` becomes an
 * import line per plugin, and `{{CLIENT_PLUGINS}}` their calls; without
 * client plugins, the line goes.
 */
const expandClientPlugins = (
  line: string,
  clientPlugins: readonly InfraClientPlugin[],
): string[] => {
  if (line.includes("{{CLIENT_PLUGIN_IMPORTS}}")) {
    return clientPlugins.map(({ module, name }) =>
      // A function inserts the text as it is, `$` included.
      line.replace(
        "{{CLIENT_PLUGIN_IMPORTS}}",
        () => `import { ${name} } from ${JSON.stringify(module)};`,
      ),
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
 * `{{CLIENT_PLUGIN_IMPORTS}}` and `{{CLIENT_PLUGINS}}` render code lines.
 */
export const renderAgentInstructions = (
  text: string,
  { clientAuth, clientPlugins }: AgentInstructionsContext,
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
      lines.push(...expandClientPlugins(line, clientPlugins));
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
