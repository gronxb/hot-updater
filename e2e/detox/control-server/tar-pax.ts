const TAR_BLOCK_SIZE = 512;
const TAR_SIZE_OFFSET = 124;
const TAR_SIZE_LENGTH = 12;
const TAR_TYPE_FLAG_OFFSET = 156;

function readTarSize(header: Buffer) {
  const rawValue = header
    .subarray(TAR_SIZE_OFFSET, TAR_SIZE_OFFSET + TAR_SIZE_LENGTH)
    .toString("ascii");
  const nullOffset = rawValue.indexOf(String.fromCharCode(0));
  const value = (
    nullOffset < 0 ? rawValue : rawValue.slice(0, nullOffset)
  ).trim();
  const size = value.length === 0 ? 0 : Number.parseInt(value, 8);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`Invalid TAR entry size: ${JSON.stringify(value)}`);
  }
  return size;
}

function readPaxPathRecords(payload: Buffer) {
  const paths: string[] = [];
  let offset = 0;

  while (offset < payload.length) {
    const separator = payload.indexOf(0x20, offset);
    if (separator < 0) {
      throw new Error("Invalid PAX record: missing length separator");
    }

    const recordLength = Number.parseInt(
      payload.subarray(offset, separator).toString("ascii"),
      10,
    );
    const recordEnd = offset + recordLength;
    if (
      !Number.isSafeInteger(recordLength) ||
      recordLength <= separator - offset + 1 ||
      recordEnd > payload.length
    ) {
      throw new Error("Invalid PAX record length");
    }

    const contentStart = separator + 1;
    const equals = payload.indexOf(0x3d, contentStart);
    if (equals >= contentStart && equals < recordEnd) {
      const key = payload.subarray(contentStart, equals).toString("utf8");
      const valueEnd =
        payload[recordEnd - 1] === 0x0a ? recordEnd - 1 : recordEnd;
      if (key === "path") {
        paths.push(payload.subarray(equals + 1, valueEnd).toString("utf8"));
      }
    }

    offset = recordEnd;
  }

  return paths;
}

export function readPaxPaths(tarBuffer: Buffer) {
  const paths: string[] = [];
  let offset = 0;

  while (offset + TAR_BLOCK_SIZE <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const size = readTarSize(header);
    const payloadStart = offset + TAR_BLOCK_SIZE;
    const payloadEnd = payloadStart + size;
    if (payloadEnd > tarBuffer.length) {
      throw new Error("TAR entry exceeds archive size");
    }

    if (String.fromCharCode(header[TAR_TYPE_FLAG_OFFSET] ?? 0) === "x") {
      paths.push(
        ...readPaxPathRecords(tarBuffer.subarray(payloadStart, payloadEnd)),
      );
    }

    offset = payloadStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }

  return paths;
}
