export const areBuildHashesIncluded = (
  uploadedHashed: { [key: string]: string },
  buildHashes: { [key: string]: string },
) => {
  for (const key in buildHashes) {
    if (uploadedHashed[key] !== buildHashes[key]) {
      return false;
    }
  }
  return true;
};
