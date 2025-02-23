export const minMax = (minMs: number, maxMs: number): number =>
  Math.floor(Math.random() * (maxMs - minMs)) + minMs;

export const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};
