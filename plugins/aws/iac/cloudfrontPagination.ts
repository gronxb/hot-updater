type PaginatedPage<T> = {
  items: T[];
  nextMarker?: string;
};

export const findInPaginatedCloudFrontList = async <T>({
  listPage,
  matches,
}: {
  listPage: (marker?: string) => Promise<PaginatedPage<T>>;
  matches: (item: T) => boolean;
}): Promise<T | undefined> => {
  let marker: string | undefined;

  do {
    const { items, nextMarker } = await listPage(marker);
    const matchedItem = items.find(matches);

    if (matchedItem) {
      return matchedItem;
    }

    marker = nextMarker;
  } while (marker);

  return undefined;
};
