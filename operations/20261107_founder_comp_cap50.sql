-- Neha authorization Nov 7 2026 16:42 America/New_York:
-- Increase ONLY founder complimentary allowance to 50. Preserve active state,
-- claim history, room exception, all other config caps, and all closure policy.
DO $migration$
DECLARE current_cap integer;
BEGIN
  SELECT cap INTO STRICT current_cap
  FROM public.ssuite_founder_comp_config
  WHERE key = 'neha-singh-invite' FOR UPDATE;
  IF current_cap NOT IN (43, 50) THEN
    RAISE EXCEPTION 'Unexpected founder cap %, review before proceeding', current_cap;
  END IF;
  UPDATE public.ssuite_founder_comp_config
  SET cap = 50, updated_at = now()
  WHERE key = 'neha-singh-invite' AND cap = 43;
END;
$migration$;
