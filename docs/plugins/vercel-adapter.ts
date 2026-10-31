import vercelAdapter from "waku/adapters/vercel";

// Waku's Vercel adapter copies all of `dist`, including the prerendered site
// in `dist/public`, into the RSC function. Vercel serves those files from the
// static output before the function, so the enhancer removes the function's
// copy to keep it under Vercel's function size limit.
const adapter: typeof vercelAdapter = (handlers, options) => {
  const entry = vercelAdapter(handlers, options);

  return {
    ...entry,
    buildEnhancers: [
      ...(entry.buildEnhancers ?? []),
      "/plugins/vercel-function-enhancer.js",
    ],
  };
};

export default adapter;
