-- Neha approved FOUR pooled last-minute Community Partner seats, $300, one per checkout.
-- New allocation only; no existing caps, capacities or revocations changed.
DO $guard$ BEGIN
IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='private' AND p.proname='ssuite_partner_paid_closed') IS DISTINCT FROM $baseline$CREATE OR REPLACE FUNCTION private.ssuite_partner_paid_closed(p_code text, p_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
 SELECT upper(regexp_replace(coalesce(p_code,''),'[^A-Za-z0-9]','','g')) IN ('SAYAPARTNERA2KC','SAYAPARTNERB0DB82')
 OR (p_at >= timestamptz '2026-11-07T04:59:00Z' AND EXISTS (SELECT 1 FROM public.member_access_codes c JOIN public.ticket_types t ON t.id=c.ticket_type_id WHERE c.code=upper(regexp_replace(coalesce(p_code,''),'[^A-Za-z0-9]','','g')) AND c.purpose='partner_organization' AND t.code='nonprofit_partner' AND c.code NOT IN ('SSUITEASCEND2026','SEHGALPARTNER5N3V')));
$function$
$baseline$ THEN RAISE EXCEPTION 'Concurrent policy change'; END IF;
IF EXISTS(SELECT 1 FROM public.member_access_codes WHERE code='SSUITECOMMUNITYPARTNER2026') THEN RAISE EXCEPTION 'Generic code exists'; END IF;
IF NOT EXISTS(SELECT 1 FROM public.ticket_types WHERE code='nonprofit_partner' AND amount_cents=30000 AND seat_count=1 AND active AND access_code_required AND early_bird_ends_at IS NULL) THEN RAISE EXCEPTION 'Partner price/eligibility changed'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION private.ssuite_partner_paid_closed(p_code text, p_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
 SELECT upper(regexp_replace(coalesce(p_code,''),'[^A-Za-z0-9]','','g')) IN ('SAYAPARTNERA2KC','SAYAPARTNERB0DB82')
 OR (p_at >= timestamptz '2026-11-07T04:59:00Z' AND EXISTS (SELECT 1 FROM public.member_access_codes c JOIN public.ticket_types t ON t.id=c.ticket_type_id WHERE c.code=upper(regexp_replace(coalesce(p_code,''),'[^A-Za-z0-9]','','g')) AND c.purpose='partner_organization' AND t.code='nonprofit_partner' AND c.code NOT IN ('SSUITEASCEND2026','SEHGALPARTNER5N3V','SSUITECOMMUNITYPARTNER2026')));
$function$
;
INSERT INTO public.member_access_codes(code,organization,issued_to_name,max_uses,active,expires_at,note,created_by,ticket_type_id,purpose,max_seats_per_order) SELECT 'SSUITECOMMUNITYPARTNER2026','Community Partners','Community Partners',4,true,null,'Neha approved shared last-minute allocation: FOUR total across everyone, $300 each, one attendee per checkout; paid plus recent 45-minute reservations consume cap. No guests/tables. New pooled allocation, not per-partner cap.','Neha Singh',id,'partner_organization',1 FROM public.ticket_types WHERE code='nonprofit_partner';
DO $verify$ BEGIN IF private.ssuite_partner_paid_closed('SSUITECOMMUNITYPARTNER2026',clock_timestamp()) OR NOT private.ssuite_has_private_paid_invitation('SSUITECOMMUNITYPARTNER2026') THEN RAISE EXCEPTION 'New private code not eligible'; END IF; END $verify$;