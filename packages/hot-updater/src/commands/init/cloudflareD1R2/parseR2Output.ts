export const parseR2Output = (
  str: string,
): { name: string; creation_date: string }[] => {
  // Use regex to match bucket information at once
  const bucketRegex = /name:\s+(.+)\s*\ncreation_date:\s+(.+)/g;
  const buckets: { name: string; creation_date: string }[] = [];

  // Process all matches
  const matches = str.matchAll(bucketRegex);
  for (const match of matches) {
    if (match[1] && match[2]) {
      buckets.push({
        name: match[1].trim(),
        creation_date: match[2].trim(),
      });
    }
  }

  return buckets;
};
