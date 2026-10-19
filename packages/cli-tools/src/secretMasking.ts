const SECRET_MASK = "********";

/**
 * Shorter values are not masked: masking a two-letter value would redact
 * every occurrence of those letters. Keystore passwords are at least six
 * characters, and keys and service accounts are far longer.
 */
const MIN_SECRET_LENGTH = 6;

const PEM_ARMOR_LINE = /^-----(BEGIN|END) [A-Z0-9 ]+-----$/;

const secretValues = new Set<string>();
let secretValuesLongestFirst: readonly string[] = [];

/**
 * Registers a credential value so every CLI log sink (`p`, `log`, and the
 * build log files) prints it masked. A multi-line value is also registered
 * line by line, so a PEM printed one line at a time stays masked.
 */
export const registerSecretValue = (value: string) => {
  const candidates = [value, ...value.split(/\r?\n/)];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed.length < MIN_SECRET_LENGTH || PEM_ARMOR_LINE.test(trimmed)) {
      continue;
    }
    secretValues.add(trimmed);
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
