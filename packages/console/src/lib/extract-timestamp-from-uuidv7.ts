export const extractTimestampFromUUIDv7 = (uuid: string) => {
  const timestampHex = uuid.split('-').join('').slice(0, 12);

  const timestamp = Number.parseInt(timestampHex, 16);

  return timestamp;
};
