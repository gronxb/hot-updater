import { NativeArtifactError } from "./byteSource";

/** An attribute's value as a compiled manifest holds it. */
export type ManifestValue =
  | { readonly type: "string"; readonly value: string }
  | { readonly type: "int"; readonly value: number }
  | { readonly type: "boolean"; readonly value: boolean }
  | { readonly type: "reference"; readonly id: number; readonly name?: string }
  | { readonly type: "other" };

export interface ManifestAttribute {
  readonly name: string;
  /** The `android:` attribute's resource ID, such as 0x0101021c, or 0. */
  readonly resourceId: number;
  readonly value: ManifestValue;
}

export interface ManifestElement {
  readonly name: string;
  readonly attributes: readonly ManifestAttribute[];
  readonly children: readonly ManifestElement[];
}

const corrupt = () =>
  new NativeArtifactError(
    "UNREADABLE",
    "The artifact's AndroidManifest.xml is corrupt.",
  );

const view = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_TYPE = 0x0003;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const UTF8_FLAG = 0x100;
const NO_INDEX = 0xffffffff;

/** A `ResXMLTree_attrExt`, and a `ResXMLTree_attribute`, in bytes. */
const ELEMENT_EXT_BYTES = 20;
const ATTRIBUTE_BYTES = 20;
/** How deep a manifest's elements nest: an AndroidManifest.xml, a few levels. */
const MAX_ELEMENT_DEPTH = 64;

const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_INT_BOOLEAN = 0x12;

/**
 * How many bytes a manifest's strings decode to in all. A pool's offsets can
 * point many indexes, or overlapping ranges, at one long string, so the
 * manifest's own size bounds nothing.
 */
const DECODED_STRING_BYTES = 16 * 1024 * 1024;

/**
 * A `ResStringPool` chunk's strings, decoded when an index is read: each
 * offset once, against one budget, within the chunk.
 */
const readStringPool = (
  bytes: Uint8Array,
  start: number,
  size: number,
): ((index: number) => string) => {
  const data = view(bytes);
  const end = start + size;
  if (size < 28) throw corrupt();
  const count = data.getUint32(start + 8, true);
  const flags = data.getUint32(start + 16, true);
  const stringsStart = start + data.getUint32(start + 20, true);
  if (start + 28 + count * 4 > end || stringsStart > end) throw corrupt();
  const utf8 = (flags & UTF8_FLAG) !== 0;
  const decoder = new TextDecoder(utf8 ? "utf-8" : "utf-16le");
  const decoded = new Map<number, string>();
  let budget = DECODED_STRING_BYTES;
  return (index) => {
    if (index === NO_INDEX || index >= count) return "";
    const offset = data.getUint32(start + 28 + index * 4, true);
    const known = decoded.get(offset);
    if (known !== undefined) return known;
    let at = stringsStart + offset;
    let byteLength: number;
    if (at + 4 > end) throw corrupt();
    if (utf8) {
      // The UTF-16 length, then the UTF-8 length, each one or two bytes.
      at += bytes[at]! & 0x80 ? 2 : 1;
      let length = bytes[at]!;
      if (length & 0x80) {
        length = ((length & 0x7f) << 8) | bytes[at + 1]!;
        at += 2;
      } else {
        at += 1;
      }
      byteLength = length;
    } else {
      let length = data.getUint16(at, true);
      if (length & 0x8000) {
        length = ((length & 0x7fff) << 16) | data.getUint16(at + 2, true);
        at += 4;
      } else {
        at += 2;
      }
      byteLength = length * 2;
    }
    budget -= byteLength;
    if (at + byteLength > end || budget < 0) throw corrupt();
    const text = decoder.decode(bytes.subarray(at, at + byteLength));
    decoded.set(offset, text);
    return text;
  };
};

export const parseBinaryManifest = (bytes: Uint8Array): ManifestElement => {
  const data = view(bytes);
  if (bytes.byteLength < 8 || data.getUint16(0, true) !== RES_XML_TYPE) {
    throw corrupt();
  }
  let stringAt: (index: number) => string = () => "";
  let resourceIds: number[] = [];
  const stack: {
    name: string;
    attributes: ManifestAttribute[];
    children: ManifestElement[];
  }[] = [];
  let root: ManifestElement | null = null;

  for (let at = data.getUint16(2, true); at + 8 <= bytes.byteLength; ) {
    const type = data.getUint16(at, true);
    const headerSize = data.getUint16(at + 2, true);
    const size = data.getUint32(at + 4, true);
    if (size < 8 || at + size > bytes.byteLength) throw corrupt();
    if (type === RES_STRING_POOL_TYPE) {
      stringAt = readStringPool(bytes, at, size);
    } else if (type === RES_XML_RESOURCE_MAP_TYPE) {
      resourceIds = [];
      for (let i = at + headerSize; i + 4 <= at + size; i += 4) {
        resourceIds.push(data.getUint32(i, true));
      }
    } else if (type === RES_XML_START_ELEMENT_TYPE) {
      const ext = at + headerSize;
      const attributeStart = data.getUint16(ext + 8, true);
      const attributeSize = data.getUint16(ext + 10, true);
      const attributeCount = data.getUint16(ext + 12, true);
      // Every attribute is a whole record inside its element's chunk: a
      // crafted size of 0 can't read one record 65,535 times.
      if (
        headerSize < 16 ||
        ext + ELEMENT_EXT_BYTES > at + size ||
        attributeStart < ELEMENT_EXT_BYTES ||
        attributeSize < ATTRIBUTE_BYTES ||
        ext + attributeStart + attributeCount * attributeSize > at + size ||
        stack.length >= MAX_ELEMENT_DEPTH
      ) {
        throw corrupt();
      }
      const name = stringAt(data.getUint32(ext + 4, true));
      const attributes: ManifestAttribute[] = [];
      for (let i = 0; i < attributeCount; i += 1) {
        const attr = ext + attributeStart + i * attributeSize;
        const nameIndex = data.getUint32(attr + 4, true);
        const raw = data.getUint32(attr + 8, true);
        const dataType = bytes[attr + 15]!;
        const value = data.getUint32(attr + 16, true);
        attributes.push({
          name: stringAt(nameIndex),
          resourceId: resourceIds[nameIndex] ?? 0,
          value:
            dataType === TYPE_STRING
              ? {
                  type: "string",
                  value: stringAt(raw === NO_INDEX ? value : raw),
                }
              : dataType === TYPE_INT_BOOLEAN
                ? { type: "boolean", value: value !== 0 }
                : dataType === TYPE_INT_DEC || dataType === TYPE_INT_HEX
                  ? { type: "int", value: value | 0 }
                  : dataType === TYPE_REFERENCE
                    ? { type: "reference", id: value }
                    : { type: "other" },
        });
      }
      stack.push({ name, attributes, children: [] });
    } else if (type === RES_XML_END_ELEMENT_TYPE) {
      const element = stack.pop();
      if (element === undefined) throw corrupt();
      const parent = stack.at(-1);
      if (parent === undefined) root ??= element;
      else parent.children.push(element);
    }
    at += size;
  }
  if (root === null) throw corrupt();
  return root;
};

/** A minimal protobuf reader: fields of one message, by number. */
const readMessage = (
  bytes: Uint8Array,
): { field: number; wireType: number; value: number | Uint8Array }[] => {
  const fields: {
    field: number;
    wireType: number;
    value: number | Uint8Array;
  }[] = [];
  let at = 0;
  const varint = () => {
    let value = 0;
    let multiplier = 1;
    for (;;) {
      if (at >= bytes.byteLength) throw corrupt();
      const byte = bytes[at++]!;
      value += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return value;
      multiplier *= 128;
      if (multiplier > 2 ** 63) throw corrupt();
    }
  };
  while (at < bytes.byteLength) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wireType = key % 8;
    if (wireType === 0) {
      fields.push({ field, wireType, value: varint() });
    } else if (wireType === 2) {
      const length = varint();
      if (at + length > bytes.byteLength) throw corrupt();
      fields.push({ field, wireType, value: bytes.subarray(at, at + length) });
      at += length;
    } else if (wireType === 5) {
      at += 4;
    } else if (wireType === 1) {
      at += 8;
    } else {
      throw corrupt();
    }
  }
  return fields;
};

const decoder = new TextDecoder();
const bytesOf = (
  fields: ReturnType<typeof readMessage>,
  field: number,
): Uint8Array[] =>
  fields
    .filter((f) => f.field === field && f.value instanceof Uint8Array)
    .map((f) => f.value as Uint8Array);
const stringOf = (fields: ReturnType<typeof readMessage>, field: number) => {
  const [value] = bytesOf(fields, field);
  return value === undefined ? "" : decoder.decode(value);
};
const numberOf = (
  fields: ReturnType<typeof readMessage>,
  field: number,
): number | undefined => {
  const found = fields.find((f) => f.field === field && f.wireType === 0);
  return found === undefined ? undefined : (found.value as number);
};

/** An `Item` of aapt2's Resources.proto, as an attribute's compiled value. */
const protoItemValue = (
  item: Uint8Array,
  raw: string,
): ManifestValue | null => {
  const fields = readMessage(item);
  const [reference] = bytesOf(fields, 1);
  if (reference !== undefined) {
    const ref = readMessage(reference);
    return {
      type: "reference",
      id: numberOf(ref, 2) ?? 0,
      name: stringOf(ref, 3) || undefined,
    };
  }
  const [str] = bytesOf(fields, 2);
  if (str !== undefined) {
    return { type: "string", value: stringOf(readMessage(str), 1) };
  }
  const [primitive] = bytesOf(fields, 7);
  if (primitive !== undefined) {
    const prim = readMessage(primitive);
    const boolean = numberOf(prim, 8);
    if (boolean !== undefined) return { type: "boolean", value: boolean !== 0 };
    const int = numberOf(prim, 6) ?? numberOf(prim, 7);
    if (int !== undefined) return { type: "int", value: int | 0 };
    if (raw !== "") return { type: "string", value: raw };
  }
  return null;
};

/** An `XmlElement` of aapt2's Resources.proto. */
const protoElement = (bytes: Uint8Array, depth = 0): ManifestElement => {
  if (depth >= MAX_ELEMENT_DEPTH) throw corrupt();
  const fields = readMessage(bytes);
  const attributes = bytesOf(fields, 4).map((attribute): ManifestAttribute => {
    const attr = readMessage(attribute);
    const raw = stringOf(attr, 3);
    const [item] = bytesOf(attr, 6);
    return {
      name: stringOf(attr, 2),
      resourceId: numberOf(attr, 5) ?? 0,
      value: (item && protoItemValue(item, raw)) ?? {
        type: "string",
        value: raw,
      },
    };
  });
  const children = bytesOf(fields, 5).flatMap((node) => {
    const [element] = bytesOf(readMessage(node), 1);
    return element === undefined ? [] : [protoElement(element, depth + 1)];
  });
  return { name: stringOf(fields, 3), attributes, children };
};

/**
 * An `.aab` module's `manifest/AndroidManifest.xml`, an `XmlNode` of
 * aapt2's Resources.proto.
 */
export const parseProtoManifest = (bytes: Uint8Array): ManifestElement => {
  const [element] = bytesOf(readMessage(bytes), 1);
  if (element === undefined) throw corrupt();
  return protoElement(element);
};

const VERSION_CODE = 0x0101021b;
const VERSION_NAME = 0x0101021c;
const NAME = 0x01010003;
const VALUE = 0x01010024;
const RESOURCE = 0x01010025;
const SCHEME = 0x01010027;

const COMPONENTS = new Set(["activity", "activity-alias"]);

/** What an Android manifest says that import reads. */
export interface AndroidManifestInfo {
  readonly packageName: string | null;
  readonly versionName: ManifestValue | null;
  readonly versionCode: number | null;
  /** `<application>`'s `<meta-data>` values, by name. */
  readonly metaData: ReadonlyMap<string, ManifestValue>;
  /** The `<activity>`s and `<activity-alias>`es with a MAIN + LAUNCHER filter. */
  readonly launchers: readonly string[];
  /** The schemes of each intent filter, by the component that declares it. */
  readonly urlSchemes: ReadonlyMap<string, readonly string[]>;
}

const attributeOf = (
  element: ManifestElement,
  resourceId: number,
  name: string,
): ManifestValue | null =>
  element.attributes.find((attribute) =>
    attribute.resourceId !== 0
      ? attribute.resourceId === resourceId
      : attribute.name === name,
  )?.value ?? null;

/** The values of a parsed manifest that import reads. */
export const readAndroidManifest = (
  manifest: ManifestElement,
): AndroidManifestInfo => {
  if (manifest.name !== "manifest") throw corrupt();
  const packageValue = manifest.attributes.find(
    (attribute) => attribute.name === "package",
  )?.value;
  const versionCode = attributeOf(manifest, VERSION_CODE, "versionCode");
  const application = manifest.children.find(
    ({ name }) => name === "application",
  );
  const metaData = new Map<string, ManifestValue>();
  const launchers: string[] = [];
  const urlSchemes = new Map<string, string[]>();
  const stringAttribute = (element: ManifestElement, id: number, name: string) => {
    const value = attributeOf(element, id, name);
    return value?.type === "string" ? value.value : null;
  };
  for (const element of application?.children ?? []) {
    if (COMPONENTS.has(element.name)) {
      const component = stringAttribute(element, NAME, "name");
      if (component === null) continue;
      for (const filter of element.children) {
        if (filter.name !== "intent-filter") continue;
        const named = (child: string) =>
          filter.children
            .filter(({ name }) => name === child)
            .map((part) => stringAttribute(part, NAME, "name"));
        if (
          named("action").includes("android.intent.action.MAIN") &&
          named("category").includes("android.intent.category.LAUNCHER") &&
          !launchers.includes(component)
        ) {
          launchers.push(component);
        }
        for (const data of filter.children) {
          if (data.name !== "data") continue;
          const scheme = stringAttribute(data, SCHEME, "scheme");
          if (scheme === null) continue;
          urlSchemes.set(component, [
            ...(urlSchemes.get(component) ?? []),
            scheme,
          ]);
        }
      }
      continue;
    }
    if (element.name !== "meta-data") continue;
    const name = attributeOf(element, NAME, "name");
    // `android:resource` names a resource the app reads the value of.
    const value =
      attributeOf(element, VALUE, "value") ??
      attributeOf(element, RESOURCE, "resource");
    if (name?.type === "string" && value !== null) {
      metaData.set(name.value, value);
    }
  }
  return {
    packageName: packageValue?.type === "string" ? packageValue.value : null,
    versionName: attributeOf(manifest, VERSION_NAME, "versionName"),
    versionCode: versionCode?.type === "int" ? versionCode.value : null,
    metaData,
    launchers,
    urlSchemes,
  };
};
