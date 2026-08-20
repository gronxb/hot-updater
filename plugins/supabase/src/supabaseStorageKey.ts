/**
 * Supabase upload responses echo a percent-encoded object key (`data.Key`),
 * so the `supabase-storage://` URIs built from them keep that encoding.
 *
 * Storage API endpoints that carry the key in the request path
 * (`createSignedUrl`, `download`, `exists`) decode it server side, but the
 * ones that carry keys in the JSON body (`createSignedUrls`, `remove`) do
 * not, and look up an object whose name literally contains `%40`.
 *
 * Decoding when the URI is parsed keeps both request shapes pointing at the
 * same object. Keys that are not valid percent-encoded sequences are left
 * untouched.
 */
export const decodeStorageObjectKey = (key: string): string => {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
};
