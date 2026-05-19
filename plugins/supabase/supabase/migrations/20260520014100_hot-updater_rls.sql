-- HotUpdater.supabase_rls

ALTER TABLE public.bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bundle_patches ENABLE ROW LEVEL SECURITY;

ALTER FUNCTION public.get_target_app_version_list(public.platforms, uuid)
  SET search_path = public, pg_catalog;
ALTER FUNCTION public.get_channels()
  SET search_path = public, pg_catalog;
ALTER FUNCTION public.positive_mod(integer, integer)
  SET search_path = public, pg_catalog;
ALTER FUNCTION public.hash_rollout_value(text)
  SET search_path = public, pg_catalog;
ALTER FUNCTION public.normalize_cohort_value(text)
  SET search_path = public, pg_catalog;
ALTER FUNCTION public.gcd_int(integer, integer)
  SET search_path = public, pg_catalog;
ALTER FUNCTION public.get_rollout_multiplier(uuid)
  SET search_path = public, pg_catalog;
ALTER FUNCTION public.get_rollout_offset(uuid)
  SET search_path = public, pg_catalog;
ALTER FUNCTION public.get_modular_inverse(integer, integer)
  SET search_path = public, pg_catalog;
ALTER FUNCTION public.is_numeric_cohort(text)
  SET search_path = public, pg_catalog;
ALTER FUNCTION public.get_numeric_cohort_rollout_position(uuid, text)
  SET search_path = public, pg_catalog;
ALTER FUNCTION public.is_cohort_eligible(uuid, text, integer, text[])
  SET search_path = public, pg_catalog;
ALTER FUNCTION public.get_update_info_by_fingerprint_hash(
  public.platforms,
  uuid,
  uuid,
  text,
  text,
  text
)
  SET search_path = public, pg_catalog;
ALTER FUNCTION public.get_update_info_by_app_version(
  public.platforms,
  text,
  uuid,
  uuid,
  text,
  text[],
  text
)
  SET search_path = public, pg_catalog;
