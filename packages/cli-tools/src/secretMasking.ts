const SECRET_MASK = "********";

/**
 * A value shorter than this is masked only where it is a whole token, so a
 * keystore password `a` masks `-Ppassword=a` but leaves `Gradle failed`
 * readable, and a value `1` leaves `http://127.0.0.1:3941` whole. The lines
 * of a multi-line value are registered only from this length: masking the
 * `{` line of a JSON file would redact every brace.
 */
const MIN_SUBSTRING_SECRET_LENGTH = 6;

/**
 * What separates the tokens a short value must be whole: whitespace, quotes,
 * `=`, `&`, `|`, brackets, commas, and semicolons. Characters such as `.`,
 * `:`, `/`, `-`, and `@` join a run into one token, as in a URL or a version,
 * except a `.`, `:`, `!`, or `?` that ends a sentence.
 */
const TOKEN_SEPARATOR = "\\s\"'`=&|,;()[\\]{}<>";
const SHORT_SECRET_BEFORE = `(?<=^|[${TOKEN_SEPARATOR}])`;
const SHORT_SECRET_AFTER = `(?=$|[${TOKEN_SEPARATOR}]|[.:!?](?:$|[${TOKEN_SEPARATOR}]))`;

const PEM_ARMOR_LINE = /^-----(BEGIN|END) [A-Z0-9 ]+-----$/;

interface MaskingRegistry {
  readonly secretValues: Set<string>;
  readonly shortSecretValues: Set<string>;
  secretValuesLongestFirst: readonly string[];
  shortSecretPattern: RegExp | undefined;
}

const MASKING_REGISTRY = Symbol.for("@hot-updater/cli-tools/secret-masking");

/**
 * The values to mask, kept on `globalThis`: the config file loads its own
 * copy of Hot Updater's modules, and a value it resolves, such as through
 * `secret()`, must be masked by the CLI's log sinks too.
 */
const registry: MaskingRegistry = ((
  globalThis as {
    [MASKING_REGISTRY]?: MaskingRegistry;
  }
)[MASKING_REGISTRY] ??= {
  secretValues: new Set(),
  shortSecretValues: new Set(),
  secretValuesLongestFirst: [],
  shortSecretPattern: undefined,
});
const { secretValues, shortSecretValues } = registry;

const longestFirst = (values: Iterable<string>) =>
  [...values].sort((left, right) => right.length - left.length);

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Registers a credential value so every CLI log sink (`p`, `log`, and the
 * build log files) prints it masked, however short it is. A multi-line value
 * is also registered line by line, so a PEM printed one line at a time stays
 * masked.
 */
export const registerSecretValue = (value: string) => {
  const whole = value.trim();
  if (whole.length >= MIN_SUBSTRING_SECRET_LENGTH) {
    secretValues.add(whole);
  } else if (whole) {
    shortSecretValues.add(whole);
  }
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (
      trimmed.length >= MIN_SUBSTRING_SECRET_LENGTH &&
      !PEM_ARMOR_LINE.test(trimmed)
    ) {
      secretValues.add(trimmed);
    }
  }
  registry.secretValuesLongestFirst = longestFirst(secretValues);
  registry.shortSecretPattern =
    shortSecretValues.size > 0
      ? new RegExp(
          `${SHORT_SECRET_BEFORE}(?:${longestFirst(shortSecretValues)
            .map(escapeRegExp)
            .join("|")})${SHORT_SECRET_AFTER}`,
          "g",
        )
      : undefined;
};

/**
 * A JSON Web Token, whether or not it was registered: Xcode mints its own from
 * the App Store Connect API key and may print it, and a build's log is uploaded
 * when the build fails.
 */
const JSON_WEB_TOKEN = /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g;

/**
 * Replaces every registered credential value in `text`, and any JSON Web Token,
 * with a mask.
 */
export const maskSecretValues = (text: string): string => {
  let masked = text;
  for (const value of registry.secretValuesLongestFirst) {
    if (masked.includes(value)) {
      masked = masked.split(value).join(SECRET_MASK);
    }
  }
  masked = masked.replace(JSON_WEB_TOKEN, SECRET_MASK);
  const { shortSecretPattern } = registry;
  return shortSecretPattern
    ? masked.replace(shortSecretPattern, SECRET_MASK)
    : masked;
};
