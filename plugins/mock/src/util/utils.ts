export const sleepMaxLimit = (minMs: number, maxMs: number) => {
  const range = maxMs - minMs;
  const randomValue = Math.random() * range;
  const delay = minMs + Math.floor(randomValue);
  return new Promise((resolve) => setTimeout(resolve, delay));
};
