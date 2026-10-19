const SECRET_MASK = "********";

/**
 * Shorter lines of a multi-line value are not masked on their own: masking
 * a `{` line of a JSON file would redact every brace.
 */
const MIN_SECRET_LINE_LENGTH = 6;

const PEM_ARMOR_LINE = /^-----(BEGIN|END) [A-Z0-9 ]+-----$/;

const secretValues = new Set<string>();
let secretValuesLongestFirst: readonly string[] = [];

/**
 * Registers a credential value so every CLI log sink (`p`, `log`, and the
 * build log files) prints it masked, however short it is. A multi-line value
 * is also registered line by line, so a PEM printed one line at a time stays
 * masked.
 */
export const registerSecretValue = (value: string) => {
  const whole = value.trim();
  if (whole) {
    secretValues.add(whole);
  }
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (
      trimmed.length >= MIN_SECRET_LINE_LENGTH &&
      !PEM_ARMOR_LINE.test(trimmed)
    ) {
      secretValues.add(trimmed);
    }
  }
  secretValuesLongestFirst = [...secretValues].sort(
    (left, right) => right.length - left.length,
  );
};

/** Replaces every registered credential value in `text` with a mask. */
export const maskSecretValues = (text: string): string => {
  let masked = text;
  for (const value of secretValuesLongestFirst) {
    if (masked.includes(value)) {
      masked = masked.split(value).join(SECRET_MASK);
    }
  }
  return masked;
};
