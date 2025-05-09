export const tags: Record<string, string> = {
  "Application": "hot-updater",
  "billed-team": "lastmile",
  "service-team": "lastmile",
  "git": "https://github.com/distribution-innovation-public/hot-updater",
}

export const getTagsAsKeyValuePairs = () => {
  return Object.keys(tags).map(key => ({
    "Key": key,
    "Value": tags[key]
  }))
}

