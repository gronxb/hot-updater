-- Release lookup uses scope_key; fingerprint_hash is no longer a runtime predicate.
DROP INDEX IF EXISTS releases_fingerprint_hash_idx;
