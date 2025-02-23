export const sleepMaxLimit = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * ms)));
