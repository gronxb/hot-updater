const PRECISION = 10;
const REGISTER_COUNT = 1 << PRECISION;
const MAX_RANK = 64 - PRECISION + 1;

const hash = (value: string): bigint => {
  let result = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    result ^= BigInt(byte);
    result = BigInt.asUintN(64, result * 0x100000001b3n);
  }
  return result;
};

const OFFSET = 33;

const decode = (summary: string | null | undefined): Uint8Array => {
  if (!summary) return new Uint8Array(REGISTER_COUNT);
  if (summary.length !== REGISTER_COUNT) {
    throw new Error("Invalid Insights distinct summary");
  }
  const registers = new Uint8Array(REGISTER_COUNT);
  for (let index = 0; index < REGISTER_COUNT; index += 1) {
    const value = summary.charCodeAt(index) - OFFSET;
    if (!Number.isInteger(value) || value < 0 || value > MAX_RANK) {
      throw new Error("Invalid Insights distinct summary");
    }
    registers[index] = value;
  }
  return registers;
};

const encode = (registers: Uint8Array): string =>
  Array.from(registers, (value) => String.fromCharCode(value + OFFSET)).join(
    "",
  );

export const getInsightsDistinctRegister = (identity: string) => {
  const value = hash(identity);
  const index = Number(value & BigInt(REGISTER_COUNT - 1));
  let remainder = value >> BigInt(PRECISION);
  let rank = 1;
  while ((remainder & 1n) === 0n && rank < MAX_RANK) {
    rank += 1;
    remainder >>= 1n;
  }
  return { index, rank, character: String.fromCharCode(rank + OFFSET) };
};

export const addInsightsDistinct = (
  summary: string | null | undefined,
  identity: string,
): string => {
  const registers = decode(summary);
  const { index, rank } = getInsightsDistinctRegister(identity);
  registers[index] = Math.max(registers[index]!, rank);
  return encode(registers);
};

export const mergeInsightsDistinct = (
  summaries: readonly (string | null | undefined)[],
): string => {
  const merged = new Uint8Array(REGISTER_COUNT);
  for (const summary of summaries) {
    const registers = decode(summary);
    for (let index = 0; index < REGISTER_COUNT; index += 1) {
      merged[index] = Math.max(merged[index]!, registers[index]!);
    }
  }
  return encode(merged);
};

export const countInsightsDistinct = (
  summary: string | null | undefined,
): number => {
  const registers = decode(summary);
  let inverseSum = 0;
  let empty = 0;
  for (const register of registers) {
    inverseSum += 2 ** -register;
    if (register === 0) empty += 1;
  }
  const alpha = 0.7213 / (1 + 1.079 / REGISTER_COUNT);
  const estimate =
    empty > 0
      ? REGISTER_COUNT * Math.log(REGISTER_COUNT / empty)
      : (alpha * REGISTER_COUNT ** 2) / inverseSum;
  return Math.max(0, Math.round(estimate));
};

export const emptyInsightsDistinct = (): string =>
  encode(new Uint8Array(REGISTER_COUNT));
