export const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365;

export const NO_STORE_CACHE_CONTROL = "no-store";

// Keep CloudFront edge cache warm while forcing viewers to revalidate.
export const SHARED_EDGE_CACHE_CONTROL = `public, max-age=0, s-maxage=${ONE_YEAR_IN_SECONDS}, must-revalidate`;
