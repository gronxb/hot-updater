// eslint-disable-next-line @typescript-eslint/no-unused-vars
type ExtractPlaceholders<T extends string> =
  T extends `${infer _Start}%%${infer Key}%%${infer Rest}`
    ? Key | ExtractPlaceholders<Rest>
    : never;

type TransformTemplateArgs<T extends string> = {
  [Key in ExtractPlaceholders<T>]: string;
};

/**
 * Replaces placeholders in the format %%key%% in a template string with values from the values object.
 * Uses generic type T to automatically infer placeholder keys from the template string to ensure type safety.
 *
 * @example
 * const str = "Hello %%name%%, you are %%age%% years old."
 * const result = transformTemplate(str, { name: "John", age: "20" })
 * // Result: "Hello John, you are 20 years old."
 */
export function transformTemplate<T extends string>(
  templateString: T,
  values: TransformTemplateArgs<T>,
): string {
  let result: string = templateString;
  for (const key in values) {
    const placeholder = `%%${key}%%`;
    const value = values[key as keyof typeof values];
    result = result.replace(new RegExp(placeholder, "g"), value);
  }
  return result;
}
