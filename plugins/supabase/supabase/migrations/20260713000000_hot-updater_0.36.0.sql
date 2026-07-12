CREATE TABLE IF NOT EXISTS public.channels (
  id text PRIMARY KEY
);

INSERT INTO public.channels (id)
SELECT DISTINCT channel FROM public.bundles
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.bundles
  ADD CONSTRAINT bundles_channel_fk
  FOREIGN KEY (channel)
  REFERENCES public.channels(id) ON DELETE RESTRICT;

ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;
