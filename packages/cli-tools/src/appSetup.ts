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
  readonly sdkModule?: string;
  readonly credential?: AppClientCredential;
  readonly clientPlugins?: readonly AppClientPlugin[];
}

/**
 * The app's import lines for `HotUpdater` and `clientPlugins`: one line per
 * module, the SDK's first, so a built-in plugin joins `HotUpdater`'s import.
 * The agent scaffold renders the same lines in hot-updater's
 * `commands/infra/clientAuth.ts`, which imports no package.
 */
export const renderAppImports = (
  clientPlugins: readonly AppClientPlugin[],
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
 * The App.tsx code init prints: `HotUpdater.init` with the server's URL,
 * the header that carries the client credential when the server takes one,
 * and the client plugins the server's plugins ask for.
 */
export const renderAppSetup = ({
  baseURL,
  sdkModule,
  credential,
  clientPlugins = [],
}: AppSetup & { readonly baseURL: string }): string =>
  [
    "// Add this to your application startup",
    ...renderAppImports(clientPlugins, sdkModule),
    "",
    "HotUpdater.init({",
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
    '// Call HotUpdater.checkForUpdate({ updateStrategy: "appVersion" })',
    "// when your app is ready to check.",
  ].join("\n");

/** Prints the App.tsx code, when the URL is known, and the app's credential. */
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
