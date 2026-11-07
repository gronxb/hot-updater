const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/**
 * Text as an XML plist's `<string>` holds it. Control characters have no XML
 * form at all, even escaped, so they go.
 */
export const escapePlistText = (text: string) =>
  [...text]
    .filter((character) => character >= " " || "\t\n\r".includes(character))
    .map((character) => ESCAPES[character] ?? character)
    .join("");
