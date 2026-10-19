const SECRET_MASK = "********";

/**
 * A value shorter than this is masked only where it stands alone, so a
 * keystore password `a` masks `-Ppassword=a` but leaves `Gradle failed`
 * readable. The lines of a multi-line value are registered only from this
 * length: masking the `{` line of a JSON file would redact every brace.
 */
const MIN_SUBSTRING_SECRET_LENGTH = 6;

const PEM_ARMOR_LINE = /^-----(BEGIN|END) [A-Z0-9 ]+-----$/;

const secretValues = new Set<string>();
const shortSecretValues = new Set<string>();
let secretValuesLongestFirst: readonly string[] = [];
let shortSecretPattern: RegExp | undefined;

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
  secretValuesLongestFirst = longestFirst(secretValues);
  shortSecretPattern =
    shortSecretValues.size > 0
      ? new RegExp(
          `(?<![A-Za-z0-9])(?:${longestFirst(shortSecretValues)
            .map(escapeRegExp)
            .join("|")})(?![A-Za-z0-9])`,
          "g",
        )
      : undefined;
};

/** Replaces every registered credential value in `text` with a mask. */
export const maskSecretValues = (text: string): string => {
  let masked = text;
  for (const value of secretValuesLongestFirst) {
    if (masked.includes(value)) {
      masked = masked.split(value).join(SECRET_MASK);
    }
  }
  return shortSecretPattern
    ? masked.replace(shortSecretPattern, SECRET_MASK)
    : masked;
};
