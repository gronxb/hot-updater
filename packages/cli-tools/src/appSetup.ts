import { p } from "./prompts";

/** The credential init gives an app, through the server's clientAuth plugin. */
export interface AppClientCredential {
  /** Its name in output, such as "API key". */
  readonly label: string;
  /** The request header that carries it. */
  readonly header: string;
  readonly value: string;
}

/** A client plugin the server's plugins ask an app to add. */
export interface AppClientPlugin {
  /** The module that exports it. */
  readonly module: string;
  /** The export, which the app calls with no arguments. */
  readonly name: string;
}

interface AppSetup {
  readonly credential?: AppClientCredential;
  readonly clientPlugins?: readonly AppClientPlugin[];
}

/** The SDK, which exports `HotUpdater` and built-in client plugins such as `insights`. */
const SDK_MODULE = "@hot-updater/react-native";

/**
 * The app's import lines for `HotUpdater` and `clientPlugins`: one line per
 * module, the SDK's first, so a built-in plugin joins `HotUpdater`'s import.
 * The agent scaffold renders the same lines in hot-updater's
 * `commands/infra/clientAuth.ts`, which imports no package.
 */
export const renderAppImports = (
  clientPlugins: readonly AppClientPlugin[],
): string[] => {
  const namesByModule = new Map<string, string[]>([
    [SDK_MODULE, ["HotUpdater"]],
  ]);
  for (const { module, name } of clientPlugins) {
    const names = namesByModule.get(module) ?? [];
    if (!names.includes(name)) names.push(name);
    namesByModule.set(module, names);
  }
  return [...namesByModule].map(
    ([module, names]) =>
      `import { ${names.join(", ")} } from ${JSON.stringify(module)};`,
  );
};

/**
 * The app code init prints: `src/hotUpdater.ts`, which exports the instance
 * `HotUpdater.init` returns with the server's URL, the header that carries
 * the client credential when the server takes one, and the client plugins
 * the server's plugins ask for; and `App.tsx`, which wraps the app's root
 * with the instance's `wrap`.
 */
export const renderAppSetup = ({
  baseURL,
  credential,
  clientPlugins = [],
}: AppSetup & { readonly baseURL: string }): string =>
  [
    "// src/hotUpdater.ts",
    ...renderAppImports(clientPlugins),
    "",
    "export const hotUpdater = HotUpdater.init({",
    `  baseURL: ${JSON.stringify(baseURL)},`,
    ...(credential === undefined
      ? []
      : [
          "  requestHeaders: {",
          `    ${JSON.stringify(credential.header)}: ${JSON.stringify(credential.value)},`,
          "  },",
        ]),
    ...(clientPlugins.length === 0
      ? []
      : [
          `  plugins: [${clientPlugins.map(({ name }) => `${name}()`).join(", ")}],`,
        ]),
    "});",
    "",
    "// App.tsx",
    'import { hotUpdater } from "./src/hotUpdater";',
    "",
    "function App() {",
    "  return null; // Replace with your app root.",
    "}",
    "",
    "// Checks for an update when App mounts. For your own flow, call",
    "// hotUpdater.checkForUpdate() instead.",
    'export default hotUpdater.wrap({ updateStrategy: "appVersion" })(App);',
  ].join("\n");

/** Prints the app code, when the URL is known, and the app's credential. */
export const printAppSetup = ({
  baseURL,
  ...setup
}: AppSetup & {
  readonly baseURL?: string;
  /** Required, so each init passes its server plugins' client plugins. */
  readonly clientPlugins: readonly AppClientPlugin[];
}): void => {
  if (baseURL !== undefined) p.note(renderAppSetup({ baseURL, ...setup }));
  const { credential } = setup;
  if (credential !== undefined) {
    p.note(credential.value, credential.label);
    p.log.message(
      `Store this ${credential.label} separately in a secure place.`,
    );
  }
};
