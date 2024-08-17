export function toRotated<T>(array: T[], steps: number): T[] {
  if (!Array.isArray(array)) {
    throw new TypeError(`Expected an array, got \`${typeof array}\`.`);
  }

  if (!Number.isSafeInteger(steps)) {
    throw new TypeError(
      `The \`steps\` parameter must be an integer, got ${steps}.`,
    );
  }

  const { length } = array;
  if (length === 0) {
    return [...array];
  }

  const normalizedSteps = ((steps % length) + length) % length;
  if (normalizedSteps === 0) {
    return [...array];
  }

  return [
    ...array.slice(-normalizedSteps),
    ...array.slice(0, -normalizedSteps),
  ];
}
