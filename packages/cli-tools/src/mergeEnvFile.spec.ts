import { parseEnv } from "node:util";

import { describe, expect, it } from "vitest";

import { formatEnvValue, mergeEnvContent } from "./mergeEnvFile";

// The oracle is Node's own parser, which `process.loadEnvFile` uses: the way
// `hot-updater.config.ts` loads `.env.hotupdater`.

const updates = (values: Record<string, string>) =>
  new Map(
    Object.entries(values).map(([key, value]) => {
      const formatted = formatEnvValue(value);
      if (formatted === undefined) throw new Error(`Unformatted ${key}`);
      return [key, formatted];
    }),
  );

describe("formatEnvValue", () => {
  it.each([
    ["plain", "abc-123_x.y/z:1@2%3+4,5=6"],
    ["spaces", "two words"],
    ["a hash", "before#after"],
    ["a dollar", "pa$$word${HOME}"],
    ["double quotes", '{"keyId":"ABC","p8":"line\\nline"}'],
    ["single quotes", "it's"],
    ["both quotes", `it's "quoted"`],
    ["all but backtick and a newline", `it's "a"\nb`],
    ["a PEM", "-----BEGIN KEY-----\nabc=\ndef=\n-----END KEY-----"],
    ["a literal backslash-n", String.raw`a\nb`],
    ["a literal backslash-n and a newline", "a\\nb\nc"],
  ])("reads back %s exactly", (_label, value) => {
    const formatted = formatEnvValue(value);
    expect(formatted).toBeDefined();
    expect(parseEnv(`V=${formatted}\n`)["V"]).toBe(value);
  });

  it("keeps a multi-line value without double quotes on one line", () => {
    expect(formatEnvValue("a\nb")).toBe('"a\\nb"');
  });

  it("gives undefined for a value no quoting holds", () => {
    expect(formatEnvValue(`'"\`\nand a \\n`)).toBeUndefined();
    expect(formatEnvValue("carriage\r\nreturn")).toBeUndefined();
  });
});

describe("mergeEnvContent", () => {
  it("creates a file from nothing", () => {
    const merged = mergeEnvContent("", updates({ A: "1", B: "two words" }));
    expect(merged).toBe("A=1\nB='two words'\n");
  });

  it("keeps every other byte, and replaces only the value", () => {
    const content = [
      "# keep this comment",
      "",
      "INFISICAL_TOKEN=keep # inline",
      "# about A",
      "export A=old # why A",
      "  B = 'old b'",
      "",
      "OTHER=keep",
      "",
    ].join("\n");

    const merged = mergeEnvContent(content, updates({ A: "new", B: "new b" }));

    expect(merged).toBe(
      [
        "# keep this comment",
        "",
        "INFISICAL_TOKEN=keep # inline",
        "# about A",
        "export A=new # why A",
        "  B = 'new b'",
        "",
        "OTHER=keep",
        "",
      ].join("\n"),
    );
    expect(parseEnv(merged!)).toEqual({
      INFISICAL_TOKEN: "keep",
      A: "new",
      B: "new b",
      OTHER: "keep",
    });
  });

  it("adds a new variable after a file with no final newline", () => {
    expect(mergeEnvContent("A=1", updates({ B: "2" }))).toBe("A=1\nB=2\n");
  });

  it("keeps a file's CRLF line endings", () => {
    expect(mergeEnvContent("A=1\r\nC=3\r\n", updates({ A: "2", B: "4" }))).toBe(
      "A=2\r\nC=3\r\nB=4\r\n",
    );
  });

  it("replaces an empty value", () => {
    expect(mergeEnvContent("A=\nB=2\n", updates({ A: "1" }))).toBe(
      "A=1\nB=2\n",
    );
    expect(mergeEnvContent("A= # why\n", updates({ A: "1" }))).toBe(
      "A= 1 # why\n",
    );
  });

  it("replaces the assignment that counts when a variable repeats", () => {
    const merged = mergeEnvContent("A=1\nA=2\n", updates({ A: "3" }));
    expect(merged).toBe("A=1\nA=3\n");
    expect(parseEnv(merged!)["A"]).toBe("3");
  });

  it("isn't fooled by a multi-line value that looks like assignments", () => {
    const content = [
      'PEM="-----BEGIN-----',
      "A=not-an-assignment",
      "# not a comment",
      '-----END-----"',
      "A=real",
      "",
    ].join("\n");

    const merged = mergeEnvContent(content, updates({ A: "new", PEM: "p" }));

    expect(merged).toBe("PEM=p\nA=new\n");
  });

  it("leaves a multi-line value alone when replacing another", () => {
    const pem = "-----BEGIN-----\nA=inside\n-----END-----";
    const merged = mergeEnvContent(
      `PEM="${pem}"\nA=real\n`,
      updates({ A: "new" }),
    );
    expect(parseEnv(merged!)).toEqual({ PEM: pem, A: "new" });
  });

  it("replaces a value whose opening quote never closes", () => {
    const merged = mergeEnvContent("A='open\nB=2\n", updates({ A: "new" }));
    expect(parseEnv(merged!)).toEqual({ A: "new", B: "2" });
  });

  it("leaves a line Node reads under another key, and adds the variable", () => {
    expect(mergeEnvContent("A B=1\n", updates({ A: "2" }))).toBe(
      "A B=1\nA=2\n",
    );
  });

  it("gives undefined rather than a file Node would read differently", () => {
    // Node takes the key as `export\tA`, where this reads `A`.
    expect(
      mergeEnvContent("export\tA=1\n", updates({ A: "2" })),
    ).toBeUndefined();
  });
});
