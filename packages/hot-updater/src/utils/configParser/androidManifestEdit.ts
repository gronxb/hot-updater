/**
 * In-place edits of `<application>` meta-data in an AndroidManifest.xml.
 *
 * Writing the manifest back through a parse/build round trip drops every XML
 * comment and reformats the whole file, so a single `fingerprint create` or
 * `keys export-public` turned into a whole-file diff in the app's own source.
 * These helpers change only the meta-data element they target and leave every
 * other byte of the file as it was.
 */

interface XmlAttribute {
  readonly name: string;
  /** Raw attribute value, entities not decoded. */
  readonly rawValue: string;
  /** Offset of the attribute name. */
  readonly start: number;
  /** Offset just past the closing quote. */
  readonly end: number;
}

interface XmlTag {
  readonly name: string;
  /** Offset of `<`. */
  readonly start: number;
  /** Offset just past `>`. */
  readonly end: number;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly attributes: readonly XmlAttribute[];
}

interface ElementRange {
  readonly openTag: XmlTag;
  /** Offset of `<` of the opening tag. */
  readonly start: number;
  /** Offset just past the element, its closing tag included. */
  readonly end: number;
}

interface ApplicationElement {
  readonly openTag: XmlTag;
  /** The `</application>` tag, or null for `<application ... />`. */
  readonly closeTag: XmlTag | null;
  /** Direct children of `<application>`. */
  readonly children: readonly ElementRange[];
}

const NAME = /[^\s/>=]+/y;
const WHITESPACE = /\s*/y;

const matchAt = (pattern: RegExp, text: string, index: number) => {
  pattern.lastIndex = index;
  return pattern.exec(text);
};

const skipTo = (xml: string, terminator: string, from: number): number => {
  const index = xml.indexOf(terminator, from);
  if (index === -1) {
    throw new Error(`unterminated markup, expected "${terminator}"`);
  }
  return index + terminator.length;
};

/**
 * Element tags of an XML document in document order. Comments, CDATA,
 * processing instructions and the doctype are skipped, so markup inside them
 * is never mistaken for an element.
 */
const scanTags = (xml: string): XmlTag[] => {
  const tags: XmlTag[] = [];
  let index = 0;

  while (index < xml.length) {
    const start = xml.indexOf("<", index);
    if (start === -1) {
      break;
    }
    if (xml.startsWith("<!--", start)) {
      index = skipTo(xml, "-->", start + 4);
      continue;
    }
    if (xml.startsWith("<![CDATA[", start)) {
      index = skipTo(xml, "]]>", start + 9);
      continue;
    }
    if (xml.startsWith("<?", start)) {
      index = skipTo(xml, "?>", start + 2);
      continue;
    }
    if (xml.startsWith("<!", start)) {
      index = skipTo(xml, ">", start + 2);
      continue;
    }

    let cursor = start + 1;
    const closing = xml[cursor] === "/";
    if (closing) {
      cursor += 1;
    }
    const name = matchAt(NAME, xml, cursor)?.[0];
    if (!name) {
      throw new Error(`invalid tag at offset ${start}`);
    }
    cursor += name.length;

    const attributes: XmlAttribute[] = [];
    let selfClosing = false;
    for (;;) {
      cursor += matchAt(WHITESPACE, xml, cursor)?.[0].length ?? 0;
      if (cursor >= xml.length) {
        throw new Error(`unterminated tag <${name}> at offset ${start}`);
      }
      if (xml.startsWith("/>", cursor)) {
        selfClosing = true;
        cursor += 2;
        break;
      }
      if (xml[cursor] === ">") {
        cursor += 1;
        break;
      }

      const attributeStart = cursor;
      const attributeName = matchAt(NAME, xml, cursor)?.[0];
      if (!attributeName) {
        throw new Error(`invalid attribute in <${name}> at offset ${cursor}`);
      }
      cursor += attributeName.length;
      cursor += matchAt(WHITESPACE, xml, cursor)?.[0].length ?? 0;
      if (xml[cursor] !== "=") {
        throw new Error(`attribute ${attributeName} in <${name}> has no value`);
      }
      cursor += 1;
      cursor += matchAt(WHITESPACE, xml, cursor)?.[0].length ?? 0;
      const quote = xml[cursor];
      if (quote !== '"' && quote !== "'") {
        throw new Error(
          `attribute ${attributeName} in <${name}> is not quoted`,
        );
      }
      const valueEnd = xml.indexOf(quote, cursor + 1);
      if (valueEnd === -1) {
        throw new Error(`unterminated value of ${attributeName} in <${name}>`);
      }
      attributes.push({
        name: attributeName,
        rawValue: xml.slice(cursor + 1, valueEnd),
        start: attributeStart,
        end: valueEnd + 1,
      });
      cursor = valueEnd + 1;
    }

    tags.push({ name, start, end: cursor, closing, selfClosing, attributes });
    index = cursor;
  }

  return tags;
};

const decodeEntities = (value: string) =>
  value.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g,
    (_, entity: string) => {
      switch (entity) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        default:
          return String.fromCodePoint(
            entity.startsWith("#x")
              ? Number.parseInt(entity.slice(2), 16)
              : Number.parseInt(entity.slice(1), 10),
          );
      }
    },
  );

const escapeAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const attributeValue = (tag: XmlTag, name: string): string | undefined => {
  const attribute = tag.attributes.find((item) => item.name === name);
  return attribute === undefined
    ? undefined
    : decodeEntities(attribute.rawValue);
};

/** The first `<application>` directly under `<manifest>`, with its children. */
const findApplication = (xml: string): ApplicationElement | null => {
  const tags = scanTags(xml);
  const stack: string[] = [];

  for (let index = 0; index < tags.length; index += 1) {
    const tag = tags[index]!;
    if (tag.closing) {
      stack.pop();
      continue;
    }
    const isApplication =
      tag.name === "application" &&
      stack.length === 1 &&
      stack[0] === "manifest";
    if (!isApplication) {
      if (!tag.selfClosing) {
        stack.push(tag.name);
      }
      continue;
    }
    if (tag.selfClosing) {
      return { openTag: tag, closeTag: null, children: [] };
    }

    const children: ElementRange[] = [];
    let depth = 0;
    let open: XmlTag | null = null;
    for (let inner = index + 1; inner < tags.length; inner += 1) {
      const child = tags[inner]!;
      if (child.closing) {
        if (depth === 0) {
          return { openTag: tag, closeTag: child, children };
        }
        depth -= 1;
        if (depth === 0 && open) {
          children.push({ openTag: open, start: open.start, end: child.end });
          open = null;
        }
        continue;
      }
      if (child.selfClosing) {
        if (depth === 0) {
          children.push({ openTag: child, start: child.start, end: child.end });
        }
        continue;
      }
      if (depth === 0) {
        open = child;
      }
      depth += 1;
    }
    throw new Error("<application> is not closed");
  }

  return null;
};

const metaDataElements = (application: ApplicationElement, key: string) =>
  application.children.filter(
    (child) =>
      child.openTag.name === "meta-data" &&
      attributeValue(child.openTag, "android:name") === key,
  );

/** Leading whitespace of the line that contains `offset`. */
const lineIndent = (xml: string, offset: number) => {
  const lineStart = xml.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(xml.slice(lineStart, offset))?.[0] ?? "";
};

/** Whether only whitespace sits between the start of the line and `offset`. */
const startsLine = (xml: string, offset: number) => {
  const lineStart = xml.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*$/.test(xml.slice(lineStart, offset));
};

const lineEnding = (xml: string) => (xml.includes("\r\n") ? "\r\n" : "\n");

/** `" />"` or `"/>"`, whichever the file already uses more. */
const selfClosingStyle = (xml: string) => {
  const spaced = xml.match(/\s\/>/g)?.length ?? 0;
  const tight = xml.match(/[^\s]\/>/g)?.length ?? 0;
  return spaced >= tight ? " />" : "/>";
};

const indentUnit = (xml: string, application: ApplicationElement) => {
  const applicationIndent = lineIndent(xml, application.openTag.start);
  if (applicationIndent.includes("\t")) {
    return "\t";
  }
  const manifest = /<manifest\b/.exec(xml);
  const manifestIndent = manifest ? lineIndent(xml, manifest.index) : "";
  const unit = applicationIndent.slice(manifestIndent.length);
  return unit.length > 0 ? unit : "    ";
};

const applyEdits = (
  xml: string,
  edits: readonly { start: number; end: number; text: string }[],
) =>
  [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce(
      (result, edit) =>
        result.slice(0, edit.start) + edit.text + result.slice(edit.end),
      xml,
    );

/**
 * Sets `<meta-data android:name={key} android:value={value}>` under
 * `<application>`, changing nothing else in the file. An existing element
 * gets its `android:value` replaced in place; otherwise a new element is
 * added as the last child, indented like its siblings.
 *
 * @returns the edited manifest, or null when it has no `<application>`.
 */
export const setManifestMetaData = (
  xml: string,
  key: string,
  value: string,
): string | null => {
  const application = findApplication(xml);
  if (!application) {
    return null;
  }

  const valueAttribute = `android:value="${escapeAttribute(value)}"`;
  const existing = metaDataElements(application, key);
  if (existing.length > 0) {
    return applyEdits(
      xml,
      existing.flatMap(({ openTag }) => {
        const attribute = (name: string) =>
          openTag.attributes.find((item) => item.name === name);
        const current = attribute("android:value");
        // `android:resource` wins over `android:value` when Android reads
        // application meta-data, so the element must be left with the value
        // only: the resource attribute becomes the value, or is removed.
        const resource = attribute("android:resource");

        if (!current && resource) {
          return [
            { start: resource.start, end: resource.end, text: valueAttribute },
          ];
        }
        const edits = current
          ? [{ start: current.start, end: current.end, text: valueAttribute }]
          : [
              {
                start: attribute("android:name")!.end,
                end: attribute("android:name")!.end,
                text: ` ${valueAttribute}`,
              },
            ];
        if (resource) {
          let start = resource.start;
          while (start > openTag.start && /\s/.test(xml[start - 1]!)) {
            start -= 1;
          }
          edits.push({ start, end: resource.end, text: "" });
        }
        return edits;
      }),
    );
  }

  const eol = lineEnding(xml);
  const element = `<meta-data android:name="${escapeAttribute(key)}" ${valueAttribute}${selfClosingStyle(xml)}`;
  const applicationIndent = lineIndent(xml, application.openTag.start);
  const lastChild = application.children.at(-1);
  const childIndent =
    lastChild && startsLine(xml, lastChild.start)
      ? lineIndent(xml, lastChild.start)
      : applicationIndent + indentUnit(xml, application);

  if (application.closeTag === null) {
    // `<application ... />`: open it up to hold the new child.
    const { openTag } = application;
    const head = xml.slice(openTag.start, openTag.end).replace(/\s*\/>$/, ">");
    return applyEdits(xml, [
      {
        start: openTag.start,
        end: openTag.end,
        text: `${head}${eol}${childIndent}${element}${eol}${applicationIndent}</application>`,
      },
    ]);
  }

  const closeStart = application.closeTag.start;
  if (startsLine(xml, closeStart)) {
    const lineStart = xml.lastIndexOf("\n", closeStart - 1) + 1;
    return applyEdits(xml, [
      {
        start: lineStart,
        end: lineStart,
        text: `${childIndent}${element}${eol}`,
      },
    ]);
  }
  return applyEdits(xml, [
    { start: closeStart, end: closeStart, text: element },
  ]);
};

/**
 * Removes every `<meta-data android:name={key}>` under `<application>`. An
 * element alone on its line takes the line with it.
 *
 * @returns the edited manifest, or null when there was nothing to remove.
 */
export const removeManifestMetaData = (
  xml: string,
  key: string,
): string | null => {
  const application = findApplication(xml);
  if (!application) {
    return null;
  }
  const existing = metaDataElements(application, key);
  if (existing.length === 0) {
    return null;
  }

  return applyEdits(
    xml,
    existing.map(({ start, end }) => {
      const lineStart = xml.lastIndexOf("\n", start - 1) + 1;
      const newline = xml.indexOf("\n", end);
      const lineEnd = newline === -1 ? xml.length : newline + 1;
      const ownsLine =
        /^[ \t]*$/.test(xml.slice(lineStart, start)) &&
        /^[ \t]*\r?\n?$/.test(xml.slice(end, lineEnd));
      return ownsLine
        ? { start: lineStart, end: lineEnd, text: "" }
        : { start, end, text: "" };
    }),
  );
};
