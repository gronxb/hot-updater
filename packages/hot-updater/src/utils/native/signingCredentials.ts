/**
 * Whether a build of an Android scheme signs with its `signing.keystore`:
 * a release variant does, and a debug variant keeps the debug keystore.
 */
export const signsWithKeystore = (
  scheme: { readonly variant?: string } | undefined,
): boolean => !/debug$/iu.test(scheme?.variant ?? "Release");

/**
 * Whether a build of an iOS scheme resolves its `signing.ascApiKey`: a
 * device build does, and a simulator build resolves nothing.
 */
export const resolvesAscApiKey = (
  scheme: { readonly simulator?: boolean } | undefined,
): boolean => !scheme?.simulator;
