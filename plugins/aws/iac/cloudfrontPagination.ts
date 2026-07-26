type PaginatedPage<T> = {
  items: T[];
  nextMarker?: string;
};

export const collectPaginatedCloudFrontList = async <T>({
  listPage,
}: {
  listPage: (marker?: string) => Promise<PaginatedPage<T>>;
}): Promise<T[]> => {
  const items: T[] = [];
  let marker: string | undefined;

  do {
    const page = await listPage(marker);
    items.push(...page.items);
    marker = page.nextMarker;
  } while (marker);

  return items;
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
