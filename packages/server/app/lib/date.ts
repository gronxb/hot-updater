export const formatDateTimeFromBundleVersion = (input: string): string => {
  const year = input.substring(0, 4);
  const month = input.substring(4, 6);
  const day = input.substring(6, 8);
  const hour = input.substring(8, 10);
  const minute = input.substring(10, 12);
  const second = input.substring(12, 14);

  return `${year}/${month}/${day} ${hour}:${minute}:${second}`;
};
