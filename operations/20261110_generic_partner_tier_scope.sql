DO $guard$ BEGIN IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='create_ssuite_checkout_order') IS DISTINCT FROM $before$CREATE OR REPLACE FUNCTION public.create_ssuite_checkout_order(p_ticket_type_code text, p_order_type text, p_quantity integer, p_purchaser jsonb, p_how_heard text, p_attendees jsonb, p_combined_agreement boolean, p_terms_version text, p_privacy_version text, p_media_release_version text, p_accepted_at timestamp with time zone DEFAULT now(), p_ip_hash text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text, p_hold_token_hash text DEFAULT NULL::text, p_membership_email text DEFAULT NULL::text, p_member_attestation boolean DEFAULT false, p_guest_quantity integer DEFAULT 0, p_member_code text DEFAULT NULL::text, p_attribution_code text DEFAULT NULL::text)
 RETURNS TABLE(order_id uuid, hold_id uuid, hold_expires_at timestamp with time zone, ticket_type_id uuid, stripe_price_id text, amount_cents integer, currency text, quantity integer, total_cents integer, guest_ticket_type_id uuid, guest_stripe_price_id text, guest_amount_cents integer, guest_quantity integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_event_id uuid;
  v_event_capacity integer;
  v_hold_minutes integer;
  v_ticket_id uuid;
  v_price_id text;
  v_amount integer;
  v_currency text;
  v_seat_count integer;
  v_order_id uuid;
  v_hold_id uuid;
  v_expires_at timestamptz;
  v_purchaser_first text;
  v_purchaser_last text;
  v_purchaser_email text;
  v_purchaser_phone text;
  v_membership_email text;
  v_membership_status text := 'not_applicable';
  v_member_code text;
  v_code record;
  v_code_id uuid;
  v_attr_code record;
  v_attr_code_id uuid;
  v_attr_code_text text;
  v_access_code_required boolean := false;
  v_eff_amount integer;
  v_eff_price_id text;
  v_code_uses integer;
  v_policy record;
  v_attendee_emails text[] := ARRAY[]::text[];
  v_attendee_count integer;
  v_expected_count integer;
  v_held bigint;
  v_committed bigint;
  v_index bigint;
  v_item_id uuid;
  v_attendee_id uuid;
  v_first text;
  v_last text;
  v_email text;
  v_secondary_email text;
  v_phone text;
  v_job_title text;
  v_company text;
  v_pronunciation text;
  v_bio text;
  v_relationship_notes text;
  v_meal text;
  v_has_dietary boolean;
  v_dietary text;
  v_has_accessibility boolean;
  v_accessibility text;
  v_is_purchaser boolean;
  v_purchaser_marked boolean := false;
  v_attendee jsonb;
  v_event_name text;
  v_member_only boolean := false;
  v_public_sale_open boolean := true;
  v_public_sale_note text;
  v_ticket_label text;
  v_guest_seats_open boolean := true;
  v_guest_qty integer := coalesce(p_guest_quantity, 0);
  v_guest_ticket_id uuid;
  v_guest_price_id text;
  v_guest_amount integer;
  v_guest_seat_count integer;
  v_guest_item_id uuid;
  v_seats integer;
  v_total integer;
  v_target_item_id uuid;
  v_target_ticket_id uuid;
  v_honoree_table_kind text;
begin

  -- Public registration closed; valid private invitations retain existing eligibility.
  if not (private.ssuite_has_private_paid_invitation(p_member_code) or private.ssuite_has_private_paid_invitation(p_attribution_code)) then
    raise exception 'Public registration is now closed. Please email ssuite@salute.community for inquiries.';
  end if;

  -- Scheduled partner-only paid cutoff; server clock, never a browser timestamp.
  if private.ssuite_partner_paid_closed(p_member_code, clock_timestamp()) or private.ssuite_partner_paid_closed(p_attribution_code, clock_timestamp()) then
    raise exception 'The event is now at capacity. Thank you so much for your interest.';
  end if;
  if v_guest_qty < 0 or v_guest_qty > 4 then
    raise exception 'Between zero and four guest seats may be added to a member registration';
  end if;
  if p_hold_token_hash is null or btrim(p_hold_token_hash) = '' then
    raise exception 'A server-generated hold token hash is required';
  end if;
  if p_order_type not in ('ticket','table') then
    raise exception 'Only ticket and table checkout orders are supported';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be positive';
  end if;
  if p_purchaser is null or jsonb_typeof(p_purchaser) <> 'object' then
    raise exception 'Purchaser details are required';
  end if;
  if p_attendees is null or jsonb_typeof(p_attendees) <> 'array' then
    raise exception 'Attendee details are required';
  end if;
  if not coalesce(p_combined_agreement, false) then
    raise exception 'Combined agreement is required';
  end if;
  if nullif(btrim(p_terms_version), '') is null
     or nullif(btrim(p_privacy_version), '') is null
     or nullif(btrim(p_media_release_version), '') is null then
    raise exception 'Current policy versions are required';
  end if;
  if nullif(btrim(p_how_heard), '') is null then
    raise exception 'How did you hear about this event is required';
  end if;

  v_purchaser_first := nullif(btrim(p_purchaser->>'first_name'), '');
  v_purchaser_last := nullif(btrim(p_purchaser->>'last_name'), '');
  v_purchaser_email := nullif(btrim(p_purchaser->>'email'), '');
  v_purchaser_phone := private.ssuite_phone(p_purchaser->>'phone');
  -- The buyer is filling in their own details, so their mobile number is
  -- required and their agreement to event texts is their own to give. Guests
  -- entered on the same payment are a different matter: nobody can consent to
  -- messages on another person's behalf, and demanding a colleague's mobile
  -- number would block the sale without ever reaching the guest. Each guest is
  -- asked for their own number, under its own disclosure, on the link they
  -- register through themselves.
  if v_purchaser_phone is null then
    raise exception 'A mobile phone number is required for the person registering';
  end if;
  if v_purchaser_first is null or v_purchaser_last is null or v_purchaser_email is null then
    raise exception 'Purchaser first name, last name, and email are required';
  end if;
  if length(v_purchaser_email) > 320
     or v_purchaser_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Purchaser email address is invalid';
  end if;
  v_purchaser_email := lower(v_purchaser_email);
  v_membership_email := nullif(lower(btrim(p_membership_email)), '');
  if v_membership_email is not null and (length(v_membership_email) > 320
     or v_membership_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception 'Membership email address is invalid';
  end if;

  select e.id, e.paid_capacity, e.inventory_hold_minutes, e.name
    into v_event_id, v_event_capacity, v_hold_minutes, v_event_name
  from public.events e
  where e.name = 'SSuite' and e.sales_status = 'open'
    and (e.registration_cutoff is null or e.registration_cutoff > now())
  order by e.created_at
  limit 1
  for update;
  if not found then
    raise exception 'SSuite sales are not open';
  end if;

  -- Policy versions are operator-controlled server state. Keep the existing
  -- Edge contract, but never trust versions supplied by the browser: require
  -- them to match the currently configured values before creating the order.
  select p.terms_version, p.privacy_version, p.media_release_version
    into v_policy
  from public.ssuite_policy_versions p
  where p.event_id = v_event_id
    and p.configured_at is not null
    and p.terms_version <> 'UNCONFIGURED'
    and p.privacy_version <> 'UNCONFIGURED'
    and p.media_release_version <> 'UNCONFIGURED';
  if not found then
    raise exception 'Current SSuite policies are not configured';
  end if;
  if btrim(p_terms_version) is distinct from v_policy.terms_version
     or btrim(p_privacy_version) is distinct from v_policy.privacy_version
     or btrim(p_media_release_version) is distinct from v_policy.media_release_version then
    raise exception 'Submitted policy versions do not match current SSuite policies';
  end if;

  select t.id, t.stripe_price_id, t.amount_cents, t.currency, t.seat_count, t.member_only,
         coalesce(t.public_sale_open, true), t.public_sale_note, t.name,
         coalesce(t.access_code_required, false)
    into v_ticket_id, v_price_id, v_amount, v_currency, v_seat_count, v_member_only,
         v_public_sale_open, v_public_sale_note, v_ticket_label,
         v_access_code_required
  from public.ticket_types t
  where t.event_id = v_event_id and t.code = p_ticket_type_code and t.active
  for share;
  if not found then
    raise exception 'The requested SSuite ticket type is unavailable';
  end if;

  -- What Stripe charges is decided here, at purchase time, by re-reading the
  -- early-bird window itself. amount_cents / stripe_price_id are a cache that
  -- sync_ssuite_effective_pricing() refreshes for display and reporting; a
  -- charge must never depend on that job having run, so a tier configured for a
  -- rollover is priced from its own window and the cache serves only tiers that
  -- have no rollover configured.
  select case when now() < t.early_bird_ends_at then t.early_bird_amount_cents
              else t.regular_amount_cents end,
         case when now() < t.early_bird_ends_at then t.early_bird_stripe_price_id
              else t.regular_stripe_price_id end
    into v_eff_amount, v_eff_price_id
  from public.ticket_types t
  where t.id = v_ticket_id
    and t.early_bird_ends_at is not null
    and t.early_bird_amount_cents is not null
    and t.regular_amount_cents is not null
    and btrim(coalesce(t.early_bird_stripe_price_id, '')) <> ''
    and btrim(coalesce(t.regular_stripe_price_id, '')) <> '';
  if v_eff_amount is not null and btrim(coalesce(v_eff_price_id, '')) <> '' then
    v_amount := v_eff_amount;
    v_price_id := v_eff_price_id;
  end if;

  -- A tier with no usable price cannot be sold. Checked after the window is
  -- applied so a tier that is configured but not yet priced fails closed.
  if v_price_id is null or btrim(v_price_id) = '' or v_amount is null then
    raise exception 'The requested SSuite ticket type is unavailable';
  end if;

  -- A tier may be withheld from public sale while the rest of the event stays
  -- open -- a members-first registration window, for example. This is separate
  -- from t.active on purpose: the tier keeps its price, its Stripe price id and
  -- its role as the Community rate for member guest seats. Only the ability to
  -- buy it as the primary line item is suspended, and restoring it is one
  -- update with no other moving parts.
  if not v_public_sale_open then
    raise exception '%', coalesce(
      nullif(btrim(v_public_sale_note), ''),
      coalesce(nullif(btrim(v_ticket_label), ''), 'This') || ' tickets are not on sale right now.');
  end if;

  -- Guests may be added to a member registration so a member pays once for
  -- their own seat plus their guests. Guests are always priced at the open
  -- Community rate; the member rate is never applied to a guest seat.
  if v_guest_qty > 0 then
    if p_order_type <> 'ticket' or not v_member_only then
      raise exception 'Guest seats may only be added to a member ticket registration';
    end if;
    -- Deliberately its own switch. Guest seats are billed at the Community rate,
    -- so they would otherwise be suspended as a side effect of closing Community
    -- to the public -- stranding a verified member mid-checkout. Whether members
    -- may bring guests is a policy decision and is stored as one.
    select coalesce(e.member_guest_seats_open, true) into v_guest_seats_open
      from public.events e where e.id = v_event_id;
    if not v_guest_seats_open then
      raise exception 'Guest seats are not available right now';
    end if;
    select t.id, t.stripe_price_id, t.amount_cents, t.seat_count
      into v_guest_ticket_id, v_guest_price_id, v_guest_amount, v_guest_seat_count
    from public.ticket_types t
    where t.event_id = v_event_id and t.code = 'community' and t.active and not t.member_only
    for share;
    -- Guest seats are billed at the Community rate, so they cross over at the
    -- same instant as a Community ticket bought directly.
    select case when now() < t.early_bird_ends_at then t.early_bird_amount_cents
                else t.regular_amount_cents end,
           case when now() < t.early_bird_ends_at then t.early_bird_stripe_price_id
                else t.regular_stripe_price_id end
      into v_eff_amount, v_eff_price_id
    from public.ticket_types t
    where t.id = v_guest_ticket_id
      and t.early_bird_ends_at is not null
      and t.early_bird_amount_cents is not null
      and t.regular_amount_cents is not null
      and btrim(coalesce(t.early_bird_stripe_price_id, '')) <> ''
      and btrim(coalesce(t.regular_stripe_price_id, '')) <> '';
    if v_eff_amount is not null and btrim(coalesce(v_eff_price_id, '')) <> '' then
      v_guest_amount := v_eff_amount;
      v_guest_price_id := v_eff_price_id;
    end if;
    -- Deliberately tested on the variables rather than FOUND: the pricing read
    -- above has since reset FOUND.
    if v_guest_ticket_id is null or v_guest_price_id is null or btrim(v_guest_price_id) = ''
       or v_guest_amount is null or v_guest_seat_count <> 1 then
      raise exception 'Community guest tickets are unavailable';
    end if;
  end if;

  v_seats := (p_quantity * v_seat_count) + v_guest_qty;
  v_total := (v_amount * p_quantity) + (coalesce(v_guest_amount, 0) * v_guest_qty);
  if v_seats > v_event_capacity then
    raise exception 'Requested quantity exceeds event capacity';
  end if;

  -- The SALUTE member rate is one seat per verified member (Neha, 2026-08-28).
  -- A member is welcome to bring guests, but guests attend at the Community
  -- rate, so a member-only ticket type can never be multiplied across extra
  -- attendees inside a single order.
  if p_quantity <> 1 and exists (
    select 1 from public.ticket_types t2
    where t2.id = v_ticket_id and t2.member_only
  ) then
    raise exception 'The SALUTE member rate covers one seat per member. Guests attend at the Community rate.';
  end if;

  -- A code-gated rate is issued with a cap, and the cap is meant to bound
  -- PEOPLE rather than orders. Each redemption records how many seats it took,
  -- so a code covering ten seats can never seat eleven however the orders are
  -- split -- and one person can buy their own seat plus a companion's in a
  -- single checkout, which Community needs and the partner rate never did.
  if v_access_code_required and p_order_type <> 'ticket' then
    raise exception 'This rate is sold as individual seats.';
  end if;

  -- Member access codes are the strongest proof of eligibility: they are issued
  -- deliberately to a named person, so redeeming one settles membership without
  -- any manual review. Roster/attestation rungs remain so that members who were
  -- issued no code are never locked out mid-sale.
  v_member_code := nullif(upper(regexp_replace(coalesce(p_member_code, ''), '[^A-Za-z0-9]', '', 'g')), '');

  if v_access_code_required then
    -- A code-gated rate has no roster or attestation rung. The code is the
    -- whole proof of eligibility, and it is scoped to one tier, so a code
    -- issued for this rate can never open another and a code issued for
    -- another rate can never open this one.
    if v_member_code is null then
      raise exception 'This rate requires an invitation code. Please enter the code you were given, or choose Request an invitation.';
    end if;

    select c.* into v_code
    from public.member_access_codes c
    where c.code = v_member_code and c.active
      and (c.expires_at is null or c.expires_at > now())
      and c.ticket_type_id = v_ticket_id
    for update;

    if not found then
      raise exception 'That code is not valid for this rate. Please check the code you were given, or write to ssuite@salute.community.';
    end if;

    -- A pending checkout reserves a seat against the cap briefly so two people
    -- cannot spend the last one at once; an abandoned cart releases it.
    select coalesce(sum(r.seats), 0) into v_code_uses
    from public.member_access_code_redemptions r
    join public.orders o on o.id = r.order_id
    where r.code_id = v_code.id
      and (o.paid_at is not null or r.created_at > now() - interval '45 minutes');

    -- Separate from the overall cap. A shared organization code is spread
    -- across that organization's people, so it is limited to one seat per
    -- checkout; a personal invitation may cover the seats it was issued for.
    if v_code.max_seats_per_order is not null and p_quantity > v_code.max_seats_per_order then
      raise exception 'This code covers % seat(s) per registration.', v_code.max_seats_per_order;
    end if;

    if v_code.max_uses is not null and v_code_uses + p_quantity > v_code.max_uses then
      if v_code_uses >= v_code.max_uses then
        raise exception 'This access code has already been used for every seat it covers. Please write to ssuite@salute.community and we will sort it out.';
      end if;
      raise exception 'This access code covers % more seat(s). Please reduce the number of seats.', v_code.max_uses - v_code_uses;
    end if;

    if v_code.issued_to_email is not null
       and v_code.issued_to_email <> v_purchaser_email
       and (v_membership_email is null or v_code.issued_to_email <> v_membership_email) then
      raise exception 'That access code was issued to a different email address.';
    end if;

    v_membership_status := 'partner_code_verified';
    v_code_id := v_code.id;

  elsif p_ticket_type_code = 'salute_member' then
    if v_member_code is not null then
      select c.* into v_code
      from public.member_access_codes c
      where c.code = v_member_code and c.active
        and (c.expires_at is null or c.expires_at > now())
        -- Codes carry the tier they were issued for. A null tier is the SALUTE
        -- member rate: that is how the original shared member code was issued,
        -- and it stays valid without a migration.
        and (c.ticket_type_id is null or c.ticket_type_id = v_ticket_id)
      for update;

      if not found then
        raise exception 'That member code is not valid. Please check the code in your SALUTE email.';
      end if;

      -- A pending checkout reserves the code briefly so two people cannot spend a
      -- single-use code at once, but an abandoned cart releases it automatically.
      select coalesce(sum(r.seats), 0) into v_code_uses
      from public.member_access_code_redemptions r
      join public.orders o on o.id = r.order_id
      where r.code_id = v_code.id
        and (o.paid_at is not null or r.created_at > now() - interval '45 minutes');

      if v_code.max_uses is not null and v_code_uses >= v_code.max_uses then
        raise exception 'That member code has already been used. Please contact us and we will sort it out.';
      end if;

      if v_code.issued_to_email is not null
         and v_code.issued_to_email <> v_purchaser_email
         and (v_membership_email is null or v_code.issued_to_email <> v_membership_email) then
        raise exception 'That member code was issued to a different email address.';
      end if;

      v_membership_status := 'code_verified';
      v_code_id := v_code.id;
    elsif exists (
      select 1 from public.member_emails m
      where m.normalized_email = v_purchaser_email and m.active
    ) then
      v_membership_status := 'matched';
    elsif v_membership_email is not null and exists (
      select 1 from public.member_emails m
      where m.normalized_email = v_membership_email and m.active
    ) then
      v_membership_status := 'alternate_email_matched';
    elsif coalesce(p_member_attestation, false) then
      v_membership_status := 'attested_review';
    else
      raise exception 'Salute member verification or attestation is required';
    end if;

  elsif p_order_type = 'table' and p_ticket_type_code = 'full_table' and v_member_code is not null then
    -- An S.Suite honoree keeps the $5,000 table rate after the public early-bird
    -- window closes. Her private code is issued for the full-table tier with
    -- purpose 'honoree_table' and is delivered only inside her private portal.
    -- A code that is not an honoree table code is ignored here, so any other
    -- table checkout is priced exactly as before.
    select c.* into v_code
    from public.member_access_codes c
    where c.code = v_member_code and c.active
      and c.purpose in ('honoree_table', 'honoree_table_inclusive')
      and c.ticket_type_id = v_ticket_id
      and (c.expires_at is null or c.expires_at > now())
    for update;

    if found then
      select coalesce(sum(r.seats), 0) into v_code_uses
      from public.member_access_code_redemptions r
      join public.orders o on o.id = r.order_id
      where r.code_id = v_code.id
        and (o.paid_at is not null or r.created_at > now() - interval '45 minutes');
      if v_code.max_uses is not null and v_code_uses + p_quantity > v_code.max_uses then
        raise exception 'This honoree table rate has already been used. Please write to ssuite@salute.community and we will sort it out.';
      end if;

      if v_code.purpose = 'honoree_table_inclusive' then
        -- Neha, 2026-10-13: an honoree's own table is $4,500 and INCLUDES her
        -- seat and her complimentary guest's seat (eight more seats for her
        -- guests). One per honoree (max_uses 1). A table in addition to her two
        -- complimentary seats stays at $5,000 via her 'honoree_table' code.
        v_eff_amount := 450000;
        v_eff_price_id := 'price_1UQFPdJk9JAYiIqLhTWF88yz';
        v_honoree_table_kind := 'inclusive';
      else
        select t.early_bird_amount_cents, t.early_bird_stripe_price_id
          into v_eff_amount, v_eff_price_id
        from public.ticket_types t
        where t.id = v_ticket_id;
        v_honoree_table_kind := 'additional';
      end if;
      if v_eff_amount is null or btrim(coalesce(v_eff_price_id, '')) = '' then
        raise exception 'The honoree table rate is temporarily unavailable. Please write to ssuite@salute.community.';
      end if;
      v_amount := v_eff_amount;
      v_price_id := v_eff_price_id;
      v_total := (v_amount * p_quantity) + (coalesce(v_guest_amount, 0) * v_guest_qty);
      v_code_id := v_code.id;
    end if;
  end if;

  -- A SALUTE member accepting a personal invitation.
  --
  -- Her seat is billed at the member rate, so the invitation is not the code
  -- that priced this order -- but it is still the reason she is here, and the
  -- host who invited her has to be credited with the whole party for seating.
  -- This records that credit. It can never grant the member rate: membership was
  -- settled above, and an invitation code does not appear on any of those rungs.
  v_attr_code_text := nullif(upper(regexp_replace(coalesce(p_attribution_code, ''), '[^A-Za-z0-9]', '', 'g')), '');
  if v_attr_code_text is not null then
    if p_ticket_type_code not in ('salute_member', 'full_table', 'half_table') then
      raise exception 'An invitation is credited on a member registration or a table only.';
    end if;
    if v_attr_code_text = v_member_code then
      -- One code cannot both verify a membership and credit a host. It has
      -- already been recorded once; recording it twice would double the seats.
      v_attr_code_text := null;
    else
      select c.* into v_attr_code
      from public.member_access_codes c
      where c.code = v_attr_code_text and c.active
        and (c.expires_at is null or c.expires_at > now())
      for update;

      if not found then
        raise exception 'That invitation could not be applied. Please write to ssuite@salute.community and we will sort it out.';
      end if;

      -- A table is not seated by the invitation. It is its own ten-seat tier at
      -- its own price, bought in full; the invitation only records who brought
      -- the party. The four-seat allowance an invitation carries describes seats
      -- it grants, so applying it here would refuse every table an invitation
      -- ever sent us.
      if p_order_type <> 'table'
         and v_attr_code.max_seats_per_order is not null
         and p_quantity + v_guest_qty > v_attr_code.max_seats_per_order then
        raise exception 'This code covers % seat(s) per registration.', v_attr_code.max_seats_per_order;
      end if;

      select coalesce(sum(r.seats), 0) into v_code_uses
      from public.member_access_code_redemptions r
      join public.orders o on o.id = r.order_id
      where r.code_id = v_attr_code.id
        and (o.paid_at is not null or r.created_at > now() - interval '45 minutes');

      -- v_seats is the real number of people this order puts in the room: ten
      -- for a table, and identical to quantity plus guests for every ticket. A
      -- capped code is still capped, and now counts a table honestly.
      if v_attr_code.max_uses is not null and v_code_uses + v_seats > v_attr_code.max_uses then
        raise exception 'This invitation covers % more seat(s). Please reduce the number of seats.',
          greatest(v_attr_code.max_uses - v_code_uses, 0);
      end if;

      if v_attr_code.issued_to_email is not null
         and v_attr_code.issued_to_email <> v_purchaser_email
         and (v_membership_email is null or v_attr_code.issued_to_email <> v_membership_email) then
        raise exception 'That invitation was issued to a different email address.';
      end if;

      v_attr_code_id := v_attr_code.id;
    end if;
  end if;

  v_attendee_count := jsonb_array_length(p_attendees);
  if p_order_type = 'ticket' then
    if v_seat_count <> 1 then
      raise exception 'Individual ticket checkout requires a one-seat ticket type';
    end if;
    v_expected_count := p_quantity + v_guest_qty;
    if v_attendee_count <> v_expected_count then
      raise exception 'Every individual ticket requires a complete attendee payload';
    end if;
  else
    -- A table is bought whole, at its tier's own seat count: ten for a full
    -- table, five for a half. The seat count is never taken from the request --
    -- it is the tier's, read from the database above -- so a half table cannot
    -- be passed off as a full one, or the reverse.
    if p_ticket_type_code not in ('full_table', 'half_table')
       or p_quantity <> 1
       or v_seat_count <> (case p_ticket_type_code when 'half_table' then 5 else 10 end) then
      raise exception 'A table order must be exactly one whole-table purchase';
    end if;
    if v_attendee_count < 1 or v_attendee_count > v_seat_count then
      raise exception 'A table requires between one and % pre-entered attendees', v_seat_count;
    end if;
  end if;

  -- Validate every attendee before creating any rows. Required fields are
  -- intentionally stricter here than the nullable storage columns.
  for v_attendee, v_index in
    select value, ordinality from jsonb_array_elements(p_attendees) with ordinality
  loop
    if jsonb_typeof(v_attendee) <> 'object' then
      raise exception 'Each attendee payload must be an object';
    end if;
    v_first := nullif(btrim(v_attendee->>'first_name'), '');
    v_last := nullif(btrim(v_attendee->>'last_name'), '');
    v_email := nullif(lower(btrim(v_attendee->>'email')), '');
    v_secondary_email := nullif(lower(btrim(v_attendee->>'secondary_email')), '');
    v_job_title := nullif(btrim(v_attendee->>'job_title'), '');
    v_company := nullif(btrim(v_attendee->>'company'), '');
    v_meal := nullif(btrim(v_attendee->>'meal_preference'), '');
    if v_first is null or v_last is null or v_email is null
       or v_job_title is null or v_company is null or v_meal is null then
      raise exception 'Attendee % is missing a required identity, organization, or meal field', v_index;
    end if;
    -- Refused before any row is written, so a missing number cannot produce a
    -- half-made order. Every seat on the registration needs a number, not only
    -- the buyer's: the buyer confirms at checkout that they hold each guest's
    -- permission, and staff must be able to reach every attendee on the night.
    if private.ssuite_phone(v_attendee->>'phone') is null then
      if v_email = lower(btrim(v_purchaser_email)) then
        raise exception 'A mobile phone number is required for the person registering';
      end if;
      raise exception 'A mobile phone number is required for every guest on this registration';
    end if;
    if length(v_email) > 320
       or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      raise exception 'Attendee % primary email address is invalid', v_index;
    end if;
    v_email := lower(v_email);
    if v_email = any(v_attendee_emails) then
      raise exception 'Attendee % primary email is duplicated in this order', v_index;
    end if;
    v_attendee_emails := array_append(v_attendee_emails, v_email);
    if v_secondary_email is not null then
      if length(v_secondary_email) > 320
         or v_secondary_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
        raise exception 'Attendee % secondary email address is invalid', v_index;
      end if;
      v_secondary_email := lower(v_secondary_email);
    end if;
    if v_secondary_email is not null and v_secondary_email = v_email then
      raise exception 'Attendee % secondary email must differ from primary email', v_index;
    end if;
    v_has_dietary := coalesce(nullif(v_attendee->>'has_dietary_or_allergy_needs', '')::boolean, false);
    v_dietary := nullif(btrim(v_attendee->>'dietary_or_allergy_details'), '');
    if v_has_dietary and v_dietary is null then
      raise exception 'Attendee % dietary or allergy details are required', v_index;
    end if;
    v_has_accessibility := coalesce(nullif(v_attendee->>'has_accessibility_needs', '')::boolean, false);
    v_accessibility := nullif(btrim(v_attendee->>'accessibility_details'), '');
    if v_has_accessibility and v_accessibility is null then
      raise exception 'Attendee % accessibility details are required', v_index;
    end if;
  end loop;

  -- Locking the event serializes this capacity check with other SSuite holds.
  update public.inventory_holds
  set status = 'expired', updated_at = now()
  where event_id = v_event_id and status = 'active' and expires_at <= now();
  select coalesce(sum(oi.seats_reserved), 0) into v_committed
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where o.event_id = v_event_id and o.status in ('paid','partially_refunded');
  v_committed := v_committed + private.ssuite_general_claim_seats(v_event_id);
  select coalesce(sum(h.seats), 0) into v_held
  from public.inventory_holds h
  where h.event_id = v_event_id and h.status = 'active' and h.expires_at > now();
  if v_committed + v_held + v_seats > v_event_capacity then
    raise exception 'Requested seats are no longer available';
  end if;

  -- Recheck after inventory/code locks: a pre-deadline request may have waited.
  if private.ssuite_partner_paid_closed(p_member_code, clock_timestamp()) or private.ssuite_partner_paid_closed(p_attribution_code, clock_timestamp()) then
    raise exception 'The event is now at capacity. Thank you so much for your interest.';
  end if;


  -- Public registration closed; valid private invitations retain existing eligibility.
  if not (private.ssuite_has_private_paid_invitation(p_member_code) or private.ssuite_has_private_paid_invitation(p_attribution_code)) then
    raise exception 'Public registration is now closed. Please email ssuite@salute.community for inquiries.';
  end if;

  insert into public.orders (
    event_id, order_type, status, purchaser_first_name, purchaser_last_name,
    purchaser_email, purchaser_phone, how_heard, subtotal_cents, total_cents, currency,
    -- Membership outcome belongs in its own reviewable columns, not only in
    -- metadata, so staff can see which member-rate orders still need review.
    member_verification_status, membership_email,
    metadata
  ) values (
    v_event_id, p_order_type, 'inventory_held', v_purchaser_first, v_purchaser_last,
    v_purchaser_email, v_purchaser_phone, btrim(p_how_heard),
    v_total, v_total, v_currency,
    v_membership_status, v_membership_email,
    jsonb_build_object(
      'checkout_source', 'ssuite_create_checkout',
      'membership_status', v_membership_status,
      'member_guest_seats', v_guest_qty,
      'invitation_code', v_attr_code_text
    ) || case when v_honoree_table_kind is not null
              then jsonb_build_object('honoree_table_kind', v_honoree_table_kind)
              else '{}'::jsonb end
  ) returning id into v_order_id;

  -- Guard on a plain scalar: plpgsql raises when a field of an unassigned
  -- record is read, even inside a condition that is already false.
  if v_code_id is not null then
    insert into public.member_access_code_redemptions (code_id, order_id, redeemer_email, seats)
    values (v_code_id, v_order_id, v_purchaser_email, p_quantity);
  end if;

  -- Credited for every seat on the registration, not only the member's own:
  -- the host invited the party, and seating needs to know who else is in it.
  if v_attr_code_id is not null then
    insert into public.member_access_code_redemptions (code_id, order_id, redeemer_email, seats)
    values (v_attr_code_id, v_order_id, v_purchaser_email, v_seats);
  end if;

  insert into public.order_items (
    event_id, order_id, ticket_type_id, description, quantity,
    unit_amount_cents, seats_reserved, stripe_price_id
  ) values (
    v_event_id, v_order_id, v_ticket_id,
    (select name from public.ticket_types where id = v_ticket_id),
    p_quantity, v_amount, 0, v_price_id
  ) returning id into v_item_id;

  if v_guest_qty > 0 then
    insert into public.order_items (
      event_id, order_id, ticket_type_id, description, quantity,
      unit_amount_cents, seats_reserved, stripe_price_id
    ) values (
      v_event_id, v_order_id, v_guest_ticket_id,
      (select name from public.ticket_types where id = v_guest_ticket_id),
      v_guest_qty, v_guest_amount, 0, v_guest_price_id
    ) returning id into v_guest_item_id;
  end if;

  insert into public.consents (
    event_id, order_id, scope, accepted, terms_version, privacy_version,
    media_release_version, accepted_at, ip_hash, user_agent, source
  ) values (
    v_event_id, v_order_id, 'purchaser_and_included_guests', true,
    v_policy.terms_version, v_policy.privacy_version, v_policy.media_release_version,
    coalesce(p_accepted_at, now()), p_ip_hash, p_user_agent, 'checkout'
  );

  -- These attendees are pre-entered by the purchaser and remain pending until
  -- Stripe payment is durably finalized.
  for v_attendee, v_index in
    select value, ordinality from jsonb_array_elements(p_attendees) with ordinality
  loop
    v_first := nullif(btrim(v_attendee->>'first_name'), '');
    v_last := nullif(btrim(v_attendee->>'last_name'), '');
    v_email := nullif(lower(btrim(v_attendee->>'email')), '');
    v_secondary_email := nullif(lower(btrim(v_attendee->>'secondary_email')), '');
    v_phone := private.ssuite_phone(v_attendee->>'phone');
    v_job_title := nullif(btrim(v_attendee->>'job_title'), '');
    v_company := nullif(btrim(v_attendee->>'company'), '');
    v_pronunciation := nullif(btrim(v_attendee->>'pronunciation'), '');
    v_bio := nullif(btrim(v_attendee->>'bio'), '');
    v_relationship_notes := nullif(btrim(v_attendee->>'relationship_notes'), '');
    v_meal := nullif(btrim(v_attendee->>'meal_preference'), '');
    v_has_dietary := coalesce(nullif(v_attendee->>'has_dietary_or_allergy_needs', '')::boolean, false);
    v_dietary := nullif(btrim(v_attendee->>'dietary_or_allergy_details'), '');
    v_has_accessibility := coalesce(nullif(v_attendee->>'has_accessibility_needs', '')::boolean, false);
    v_accessibility := nullif(btrim(v_attendee->>'accessibility_details'), '');
    v_is_purchaser := lower(v_email) = lower(v_purchaser_email) and not v_purchaser_marked;
    if v_is_purchaser then v_purchaser_marked := true; end if;

    -- Seat one is the member's own seat; every later seat in a combined order
    -- belongs to the Community-rate guest line item.
    if v_guest_qty > 0 and v_index > 1 then
      v_target_item_id := v_guest_item_id;
      v_target_ticket_id := v_guest_ticket_id;
    else
      v_target_item_id := v_item_id;
      v_target_ticket_id := v_ticket_id;
    end if;

    insert into public.attendees (
      event_id, order_id, order_item_id, ticket_type_id, first_name, last_name,
      email, secondary_email, phone, job_title, company, pronunciation, bio,
      relationship_notes, source, is_purchaser
    ) values (
      v_event_id, v_order_id, v_target_item_id, v_target_ticket_id, v_first, v_last,
      v_email, v_secondary_email, v_phone, v_job_title, v_company, v_pronunciation, v_bio,
      v_relationship_notes, 'purchaser_entry', v_is_purchaser
    ) returning id into v_attendee_id;

    insert into public.attendee_needs (
      attendee_id, meal_preference, has_dietary_or_allergy_needs,
      dietary_or_allergy_details, has_accessibility_needs, accessibility_details
    ) values (
      v_attendee_id, v_meal, v_has_dietary, v_dietary, v_has_accessibility, v_accessibility
    );

    -- The buyer's own seat is their own consent. A guest the buyer entered is
    -- recorded under a different source, so the data never reads as a personal
    -- opt-in by someone who never saw the form.
    if v_phone is not null then
      perform private.record_ssuite_sms_consent(
        v_attendee_id, v_phone,
        case when v_is_purchaser then 'checkout' else 'checkout_purchaser_confirmed' end
      );
    end if;
  end loop;

  v_expires_at := now() + make_interval(mins => v_hold_minutes);
  insert into public.inventory_holds (
    event_id, order_id, hold_token_hash, seats, expires_at
  ) values (
    v_event_id, v_order_id, p_hold_token_hash, v_seats, v_expires_at
  ) returning id into v_hold_id;

  return query select v_order_id, v_hold_id, v_expires_at, v_ticket_id, v_price_id,
    v_amount, v_currency, p_quantity, v_total,
    v_guest_ticket_id, v_guest_price_id, v_guest_amount, v_guest_qty;
end;
$function$
$before$ THEN RAISE EXCEPTION 'Concurrent checkout edit'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.create_ssuite_checkout_order(p_ticket_type_code text, p_order_type text, p_quantity integer, p_purchaser jsonb, p_how_heard text, p_attendees jsonb, p_combined_agreement boolean, p_terms_version text, p_privacy_version text, p_media_release_version text, p_accepted_at timestamp with time zone DEFAULT now(), p_ip_hash text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text, p_hold_token_hash text DEFAULT NULL::text, p_membership_email text DEFAULT NULL::text, p_member_attestation boolean DEFAULT false, p_guest_quantity integer DEFAULT 0, p_member_code text DEFAULT NULL::text, p_attribution_code text DEFAULT NULL::text)
 RETURNS TABLE(order_id uuid, hold_id uuid, hold_expires_at timestamp with time zone, ticket_type_id uuid, stripe_price_id text, amount_cents integer, currency text, quantity integer, total_cents integer, guest_ticket_type_id uuid, guest_stripe_price_id text, guest_amount_cents integer, guest_quantity integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_event_id uuid;
  v_event_capacity integer;
  v_hold_minutes integer;
  v_ticket_id uuid;
  v_price_id text;
  v_amount integer;
  v_currency text;
  v_seat_count integer;
  v_order_id uuid;
  v_hold_id uuid;
  v_expires_at timestamptz;
  v_purchaser_first text;
  v_purchaser_last text;
  v_purchaser_email text;
  v_purchaser_phone text;
  v_membership_email text;
  v_membership_status text := 'not_applicable';
  v_member_code text;
  v_code record;
  v_code_id uuid;
  v_attr_code record;
  v_attr_code_id uuid;
  v_attr_code_text text;
  v_access_code_required boolean := false;
  v_eff_amount integer;
  v_eff_price_id text;
  v_code_uses integer;
  v_policy record;
  v_attendee_emails text[] := ARRAY[]::text[];
  v_attendee_count integer;
  v_expected_count integer;
  v_held bigint;
  v_committed bigint;
  v_index bigint;
  v_item_id uuid;
  v_attendee_id uuid;
  v_first text;
  v_last text;
  v_email text;
  v_secondary_email text;
  v_phone text;
  v_job_title text;
  v_company text;
  v_pronunciation text;
  v_bio text;
  v_relationship_notes text;
  v_meal text;
  v_has_dietary boolean;
  v_dietary text;
  v_has_accessibility boolean;
  v_accessibility text;
  v_is_purchaser boolean;
  v_purchaser_marked boolean := false;
  v_attendee jsonb;
  v_event_name text;
  v_member_only boolean := false;
  v_public_sale_open boolean := true;
  v_public_sale_note text;
  v_ticket_label text;
  v_guest_seats_open boolean := true;
  v_guest_qty integer := coalesce(p_guest_quantity, 0);
  v_guest_ticket_id uuid;
  v_guest_price_id text;
  v_guest_amount integer;
  v_guest_seat_count integer;
  v_guest_item_id uuid;
  v_seats integer;
  v_total integer;
  v_target_item_id uuid;
  v_target_ticket_id uuid;
  v_honoree_table_kind text;
begin

  -- New generic allocation ONLY: never unlock other tiers or attribution paths.
  if (upper(regexp_replace(coalesce(p_member_code,''),'[^A-Za-z0-9]','','g')) = 'SSUITECOMMUNITYPARTNER2026'
      or upper(regexp_replace(coalesce(p_attribution_code,''),'[^A-Za-z0-9]','','g')) = 'SSUITECOMMUNITYPARTNER2026')
     and (p_ticket_type_code is distinct from 'nonprofit_partner'
          or p_order_type is distinct from 'ticket'
          or upper(regexp_replace(coalesce(p_member_code,''),'[^A-Za-z0-9]','','g')) <> 'SSUITECOMMUNITYPARTNER2026'
          or nullif(upper(regexp_replace(coalesce(p_attribution_code,''),'[^A-Za-z0-9]','','g')),'') is not null) then
    raise exception 'This Community Partner invitation is for individual $300 partner tickets only; no tables or other rates.';
  end if;

  -- Public registration closed; valid private invitations retain existing eligibility.
  if not (private.ssuite_has_private_paid_invitation(p_member_code) or private.ssuite_has_private_paid_invitation(p_attribution_code)) then
    raise exception 'Public registration is now closed. Please email ssuite@salute.community for inquiries.';
  end if;

  -- Scheduled partner-only paid cutoff; server clock, never a browser timestamp.
  if private.ssuite_partner_paid_closed(p_member_code, clock_timestamp()) or private.ssuite_partner_paid_closed(p_attribution_code, clock_timestamp()) then
    raise exception 'The event is now at capacity. Thank you so much for your interest.';
  end if;
  if v_guest_qty < 0 or v_guest_qty > 4 then
    raise exception 'Between zero and four guest seats may be added to a member registration';
  end if;
  if p_hold_token_hash is null or btrim(p_hold_token_hash) = '' then
    raise exception 'A server-generated hold token hash is required';
  end if;
  if p_order_type not in ('ticket','table') then
    raise exception 'Only ticket and table checkout orders are supported';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be positive';
  end if;
  if p_purchaser is null or jsonb_typeof(p_purchaser) <> 'object' then
    raise exception 'Purchaser details are required';
  end if;
  if p_attendees is null or jsonb_typeof(p_attendees) <> 'array' then
    raise exception 'Attendee details are required';
  end if;
  if not coalesce(p_combined_agreement, false) then
    raise exception 'Combined agreement is required';
  end if;
  if nullif(btrim(p_terms_version), '') is null
     or nullif(btrim(p_privacy_version), '') is null
     or nullif(btrim(p_media_release_version), '') is null then
    raise exception 'Current policy versions are required';
  end if;
  if nullif(btrim(p_how_heard), '') is null then
    raise exception 'How did you hear about this event is required';
  end if;

  v_purchaser_first := nullif(btrim(p_purchaser->>'first_name'), '');
  v_purchaser_last := nullif(btrim(p_purchaser->>'last_name'), '');
  v_purchaser_email := nullif(btrim(p_purchaser->>'email'), '');
  v_purchaser_phone := private.ssuite_phone(p_purchaser->>'phone');
  -- The buyer is filling in their own details, so their mobile number is
  -- required and their agreement to event texts is their own to give. Guests
  -- entered on the same payment are a different matter: nobody can consent to
  -- messages on another person's behalf, and demanding a colleague's mobile
  -- number would block the sale without ever reaching the guest. Each guest is
  -- asked for their own number, under its own disclosure, on the link they
  -- register through themselves.
  if v_purchaser_phone is null then
    raise exception 'A mobile phone number is required for the person registering';
  end if;
  if v_purchaser_first is null or v_purchaser_last is null or v_purchaser_email is null then
    raise exception 'Purchaser first name, last name, and email are required';
  end if;
  if length(v_purchaser_email) > 320
     or v_purchaser_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Purchaser email address is invalid';
  end if;
  v_purchaser_email := lower(v_purchaser_email);
  v_membership_email := nullif(lower(btrim(p_membership_email)), '');
  if v_membership_email is not null and (length(v_membership_email) > 320
     or v_membership_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception 'Membership email address is invalid';
  end if;

  select e.id, e.paid_capacity, e.inventory_hold_minutes, e.name
    into v_event_id, v_event_capacity, v_hold_minutes, v_event_name
  from public.events e
  where e.name = 'SSuite' and e.sales_status = 'open'
    and (e.registration_cutoff is null or e.registration_cutoff > now())
  order by e.created_at
  limit 1
  for update;
  if not found then
    raise exception 'SSuite sales are not open';
  end if;

  -- Policy versions are operator-controlled server state. Keep the existing
  -- Edge contract, but never trust versions supplied by the browser: require
  -- them to match the currently configured values before creating the order.
  select p.terms_version, p.privacy_version, p.media_release_version
    into v_policy
  from public.ssuite_policy_versions p
  where p.event_id = v_event_id
    and p.configured_at is not null
    and p.terms_version <> 'UNCONFIGURED'
    and p.privacy_version <> 'UNCONFIGURED'
    and p.media_release_version <> 'UNCONFIGURED';
  if not found then
    raise exception 'Current SSuite policies are not configured';
  end if;
  if btrim(p_terms_version) is distinct from v_policy.terms_version
     or btrim(p_privacy_version) is distinct from v_policy.privacy_version
     or btrim(p_media_release_version) is distinct from v_policy.media_release_version then
    raise exception 'Submitted policy versions do not match current SSuite policies';
  end if;

  select t.id, t.stripe_price_id, t.amount_cents, t.currency, t.seat_count, t.member_only,
         coalesce(t.public_sale_open, true), t.public_sale_note, t.name,
         coalesce(t.access_code_required, false)
    into v_ticket_id, v_price_id, v_amount, v_currency, v_seat_count, v_member_only,
         v_public_sale_open, v_public_sale_note, v_ticket_label,
         v_access_code_required
  from public.ticket_types t
  where t.event_id = v_event_id and t.code = p_ticket_type_code and t.active
  for share;
  if not found then
    raise exception 'The requested SSuite ticket type is unavailable';
  end if;

  -- What Stripe charges is decided here, at purchase time, by re-reading the
  -- early-bird window itself. amount_cents / stripe_price_id are a cache that
  -- sync_ssuite_effective_pricing() refreshes for display and reporting; a
  -- charge must never depend on that job having run, so a tier configured for a
  -- rollover is priced from its own window and the cache serves only tiers that
  -- have no rollover configured.
  select case when now() < t.early_bird_ends_at then t.early_bird_amount_cents
              else t.regular_amount_cents end,
         case when now() < t.early_bird_ends_at then t.early_bird_stripe_price_id
              else t.regular_stripe_price_id end
    into v_eff_amount, v_eff_price_id
  from public.ticket_types t
  where t.id = v_ticket_id
    and t.early_bird_ends_at is not null
    and t.early_bird_amount_cents is not null
    and t.regular_amount_cents is not null
    and btrim(coalesce(t.early_bird_stripe_price_id, '')) <> ''
    and btrim(coalesce(t.regular_stripe_price_id, '')) <> '';
  if v_eff_amount is not null and btrim(coalesce(v_eff_price_id, '')) <> '' then
    v_amount := v_eff_amount;
    v_price_id := v_eff_price_id;
  end if;

  -- A tier with no usable price cannot be sold. Checked after the window is
  -- applied so a tier that is configured but not yet priced fails closed.
  if v_price_id is null or btrim(v_price_id) = '' or v_amount is null then
    raise exception 'The requested SSuite ticket type is unavailable';
  end if;

  -- A tier may be withheld from public sale while the rest of the event stays
  -- open -- a members-first registration window, for example. This is separate
  -- from t.active on purpose: the tier keeps its price, its Stripe price id and
  -- its role as the Community rate for member guest seats. Only the ability to
  -- buy it as the primary line item is suspended, and restoring it is one
  -- update with no other moving parts.
  if not v_public_sale_open then
    raise exception '%', coalesce(
      nullif(btrim(v_public_sale_note), ''),
      coalesce(nullif(btrim(v_ticket_label), ''), 'This') || ' tickets are not on sale right now.');
  end if;

  -- Guests may be added to a member registration so a member pays once for
  -- their own seat plus their guests. Guests are always priced at the open
  -- Community rate; the member rate is never applied to a guest seat.
  if v_guest_qty > 0 then
    if p_order_type <> 'ticket' or not v_member_only then
      raise exception 'Guest seats may only be added to a member ticket registration';
    end if;
    -- Deliberately its own switch. Guest seats are billed at the Community rate,
    -- so they would otherwise be suspended as a side effect of closing Community
    -- to the public -- stranding a verified member mid-checkout. Whether members
    -- may bring guests is a policy decision and is stored as one.
    select coalesce(e.member_guest_seats_open, true) into v_guest_seats_open
      from public.events e where e.id = v_event_id;
    if not v_guest_seats_open then
      raise exception 'Guest seats are not available right now';
    end if;
    select t.id, t.stripe_price_id, t.amount_cents, t.seat_count
      into v_guest_ticket_id, v_guest_price_id, v_guest_amount, v_guest_seat_count
    from public.ticket_types t
    where t.event_id = v_event_id and t.code = 'community' and t.active and not t.member_only
    for share;
    -- Guest seats are billed at the Community rate, so they cross over at the
    -- same instant as a Community ticket bought directly.
    select case when now() < t.early_bird_ends_at then t.early_bird_amount_cents
                else t.regular_amount_cents end,
           case when now() < t.early_bird_ends_at then t.early_bird_stripe_price_id
                else t.regular_stripe_price_id end
      into v_eff_amount, v_eff_price_id
    from public.ticket_types t
    where t.id = v_guest_ticket_id
      and t.early_bird_ends_at is not null
      and t.early_bird_amount_cents is not null
      and t.regular_amount_cents is not null
      and btrim(coalesce(t.early_bird_stripe_price_id, '')) <> ''
      and btrim(coalesce(t.regular_stripe_price_id, '')) <> '';
    if v_eff_amount is not null and btrim(coalesce(v_eff_price_id, '')) <> '' then
      v_guest_amount := v_eff_amount;
      v_guest_price_id := v_eff_price_id;
    end if;
    -- Deliberately tested on the variables rather than FOUND: the pricing read
    -- above has since reset FOUND.
    if v_guest_ticket_id is null or v_guest_price_id is null or btrim(v_guest_price_id) = ''
       or v_guest_amount is null or v_guest_seat_count <> 1 then
      raise exception 'Community guest tickets are unavailable';
    end if;
  end if;

  v_seats := (p_quantity * v_seat_count) + v_guest_qty;
  v_total := (v_amount * p_quantity) + (coalesce(v_guest_amount, 0) * v_guest_qty);
  if v_seats > v_event_capacity then
    raise exception 'Requested quantity exceeds event capacity';
  end if;

  -- The SALUTE member rate is one seat per verified member (Neha, 2026-08-28).
  -- A member is welcome to bring guests, but guests attend at the Community
  -- rate, so a member-only ticket type can never be multiplied across extra
  -- attendees inside a single order.
  if p_quantity <> 1 and exists (
    select 1 from public.ticket_types t2
    where t2.id = v_ticket_id and t2.member_only
  ) then
    raise exception 'The SALUTE member rate covers one seat per member. Guests attend at the Community rate.';
  end if;

  -- A code-gated rate is issued with a cap, and the cap is meant to bound
  -- PEOPLE rather than orders. Each redemption records how many seats it took,
  -- so a code covering ten seats can never seat eleven however the orders are
  -- split -- and one person can buy their own seat plus a companion's in a
  -- single checkout, which Community needs and the partner rate never did.
  if v_access_code_required and p_order_type <> 'ticket' then
    raise exception 'This rate is sold as individual seats.';
  end if;

  -- Member access codes are the strongest proof of eligibility: they are issued
  -- deliberately to a named person, so redeeming one settles membership without
  -- any manual review. Roster/attestation rungs remain so that members who were
  -- issued no code are never locked out mid-sale.
  v_member_code := nullif(upper(regexp_replace(coalesce(p_member_code, ''), '[^A-Za-z0-9]', '', 'g')), '');

  if v_access_code_required then
    -- A code-gated rate has no roster or attestation rung. The code is the
    -- whole proof of eligibility, and it is scoped to one tier, so a code
    -- issued for this rate can never open another and a code issued for
    -- another rate can never open this one.
    if v_member_code is null then
      raise exception 'This rate requires an invitation code. Please enter the code you were given, or choose Request an invitation.';
    end if;

    select c.* into v_code
    from public.member_access_codes c
    where c.code = v_member_code and c.active
      and (c.expires_at is null or c.expires_at > now())
      and c.ticket_type_id = v_ticket_id
    for update;

    if not found then
      raise exception 'That code is not valid for this rate. Please check the code you were given, or write to ssuite@salute.community.';
    end if;

    -- A pending checkout reserves a seat against the cap briefly so two people
    -- cannot spend the last one at once; an abandoned cart releases it.
    select coalesce(sum(r.seats), 0) into v_code_uses
    from public.member_access_code_redemptions r
    join public.orders o on o.id = r.order_id
    where r.code_id = v_code.id
      and (o.paid_at is not null or r.created_at > now() - interval '45 minutes');

    -- Separate from the overall cap. A shared organization code is spread
    -- across that organization's people, so it is limited to one seat per
    -- checkout; a personal invitation may cover the seats it was issued for.
    if v_code.max_seats_per_order is not null and p_quantity > v_code.max_seats_per_order then
      raise exception 'This code covers % seat(s) per registration.', v_code.max_seats_per_order;
    end if;

    if v_code.max_uses is not null and v_code_uses + p_quantity > v_code.max_uses then
      if v_code_uses >= v_code.max_uses then
        raise exception 'This access code has already been used for every seat it covers. Please write to ssuite@salute.community and we will sort it out.';
      end if;
      raise exception 'This access code covers % more seat(s). Please reduce the number of seats.', v_code.max_uses - v_code_uses;
    end if;

    if v_code.issued_to_email is not null
       and v_code.issued_to_email <> v_purchaser_email
       and (v_membership_email is null or v_code.issued_to_email <> v_membership_email) then
      raise exception 'That access code was issued to a different email address.';
    end if;

    v_membership_status := 'partner_code_verified';
    v_code_id := v_code.id;

  elsif p_ticket_type_code = 'salute_member' then
    if v_member_code is not null then
      select c.* into v_code
      from public.member_access_codes c
      where c.code = v_member_code and c.active
        and (c.expires_at is null or c.expires_at > now())
        -- Codes carry the tier they were issued for. A null tier is the SALUTE
        -- member rate: that is how the original shared member code was issued,
        -- and it stays valid without a migration.
        and (c.ticket_type_id is null or c.ticket_type_id = v_ticket_id)
      for update;

      if not found then
        raise exception 'That member code is not valid. Please check the code in your SALUTE email.';
      end if;

      -- A pending checkout reserves the code briefly so two people cannot spend a
      -- single-use code at once, but an abandoned cart releases it automatically.
      select coalesce(sum(r.seats), 0) into v_code_uses
      from public.member_access_code_redemptions r
      join public.orders o on o.id = r.order_id
      where r.code_id = v_code.id
        and (o.paid_at is not null or r.created_at > now() - interval '45 minutes');

      if v_code.max_uses is not null and v_code_uses >= v_code.max_uses then
        raise exception 'That member code has already been used. Please contact us and we will sort it out.';
      end if;

      if v_code.issued_to_email is not null
         and v_code.issued_to_email <> v_purchaser_email
         and (v_membership_email is null or v_code.issued_to_email <> v_membership_email) then
        raise exception 'That member code was issued to a different email address.';
      end if;

      v_membership_status := 'code_verified';
      v_code_id := v_code.id;
    elsif exists (
      select 1 from public.member_emails m
      where m.normalized_email = v_purchaser_email and m.active
    ) then
      v_membership_status := 'matched';
    elsif v_membership_email is not null and exists (
      select 1 from public.member_emails m
      where m.normalized_email = v_membership_email and m.active
    ) then
      v_membership_status := 'alternate_email_matched';
    elsif coalesce(p_member_attestation, false) then
      v_membership_status := 'attested_review';
    else
      raise exception 'Salute member verification or attestation is required';
    end if;

  elsif p_order_type = 'table' and p_ticket_type_code = 'full_table' and v_member_code is not null then
    -- An S.Suite honoree keeps the $5,000 table rate after the public early-bird
    -- window closes. Her private code is issued for the full-table tier with
    -- purpose 'honoree_table' and is delivered only inside her private portal.
    -- A code that is not an honoree table code is ignored here, so any other
    -- table checkout is priced exactly as before.
    select c.* into v_code
    from public.member_access_codes c
    where c.code = v_member_code and c.active
      and c.purpose in ('honoree_table', 'honoree_table_inclusive')
      and c.ticket_type_id = v_ticket_id
      and (c.expires_at is null or c.expires_at > now())
    for update;

    if found then
      select coalesce(sum(r.seats), 0) into v_code_uses
      from public.member_access_code_redemptions r
      join public.orders o on o.id = r.order_id
      where r.code_id = v_code.id
        and (o.paid_at is not null or r.created_at > now() - interval '45 minutes');
      if v_code.max_uses is not null and v_code_uses + p_quantity > v_code.max_uses then
        raise exception 'This honoree table rate has already been used. Please write to ssuite@salute.community and we will sort it out.';
      end if;

      if v_code.purpose = 'honoree_table_inclusive' then
        -- Neha, 2026-10-13: an honoree's own table is $4,500 and INCLUDES her
        -- seat and her complimentary guest's seat (eight more seats for her
        -- guests). One per honoree (max_uses 1). A table in addition to her two
        -- complimentary seats stays at $5,000 via her 'honoree_table' code.
        v_eff_amount := 450000;
        v_eff_price_id := 'price_1UQFPdJk9JAYiIqLhTWF88yz';
        v_honoree_table_kind := 'inclusive';
      else
        select t.early_bird_amount_cents, t.early_bird_stripe_price_id
          into v_eff_amount, v_eff_price_id
        from public.ticket_types t
        where t.id = v_ticket_id;
        v_honoree_table_kind := 'additional';
      end if;
      if v_eff_amount is null or btrim(coalesce(v_eff_price_id, '')) = '' then
        raise exception 'The honoree table rate is temporarily unavailable. Please write to ssuite@salute.community.';
      end if;
      v_amount := v_eff_amount;
      v_price_id := v_eff_price_id;
      v_total := (v_amount * p_quantity) + (coalesce(v_guest_amount, 0) * v_guest_qty);
      v_code_id := v_code.id;
    end if;
  end if;

  -- A SALUTE member accepting a personal invitation.
  --
  -- Her seat is billed at the member rate, so the invitation is not the code
  -- that priced this order -- but it is still the reason she is here, and the
  -- host who invited her has to be credited with the whole party for seating.
  -- This records that credit. It can never grant the member rate: membership was
  -- settled above, and an invitation code does not appear on any of those rungs.
  v_attr_code_text := nullif(upper(regexp_replace(coalesce(p_attribution_code, ''), '[^A-Za-z0-9]', '', 'g')), '');
  if v_attr_code_text is not null then
    if p_ticket_type_code not in ('salute_member', 'full_table', 'half_table') then
      raise exception 'An invitation is credited on a member registration or a table only.';
    end if;
    if v_attr_code_text = v_member_code then
      -- One code cannot both verify a membership and credit a host. It has
      -- already been recorded once; recording it twice would double the seats.
      v_attr_code_text := null;
    else
      select c.* into v_attr_code
      from public.member_access_codes c
      where c.code = v_attr_code_text and c.active
        and (c.expires_at is null or c.expires_at > now())
      for update;

      if not found then
        raise exception 'That invitation could not be applied. Please write to ssuite@salute.community and we will sort it out.';
      end if;

      -- A table is not seated by the invitation. It is its own ten-seat tier at
      -- its own price, bought in full; the invitation only records who brought
      -- the party. The four-seat allowance an invitation carries describes seats
      -- it grants, so applying it here would refuse every table an invitation
      -- ever sent us.
      if p_order_type <> 'table'
         and v_attr_code.max_seats_per_order is not null
         and p_quantity + v_guest_qty > v_attr_code.max_seats_per_order then
        raise exception 'This code covers % seat(s) per registration.', v_attr_code.max_seats_per_order;
      end if;

      select coalesce(sum(r.seats), 0) into v_code_uses
      from public.member_access_code_redemptions r
      join public.orders o on o.id = r.order_id
      where r.code_id = v_attr_code.id
        and (o.paid_at is not null or r.created_at > now() - interval '45 minutes');

      -- v_seats is the real number of people this order puts in the room: ten
      -- for a table, and identical to quantity plus guests for every ticket. A
      -- capped code is still capped, and now counts a table honestly.
      if v_attr_code.max_uses is not null and v_code_uses + v_seats > v_attr_code.max_uses then
        raise exception 'This invitation covers % more seat(s). Please reduce the number of seats.',
          greatest(v_attr_code.max_uses - v_code_uses, 0);
      end if;

      if v_attr_code.issued_to_email is not null
         and v_attr_code.issued_to_email <> v_purchaser_email
         and (v_membership_email is null or v_attr_code.issued_to_email <> v_membership_email) then
        raise exception 'That invitation was issued to a different email address.';
      end if;

      v_attr_code_id := v_attr_code.id;
    end if;
  end if;

  v_attendee_count := jsonb_array_length(p_attendees);
  if p_order_type = 'ticket' then
    if v_seat_count <> 1 then
      raise exception 'Individual ticket checkout requires a one-seat ticket type';
    end if;
    v_expected_count := p_quantity + v_guest_qty;
    if v_attendee_count <> v_expected_count then
      raise exception 'Every individual ticket requires a complete attendee payload';
    end if;
  else
    -- A table is bought whole, at its tier's own seat count: ten for a full
    -- table, five for a half. The seat count is never taken from the request --
    -- it is the tier's, read from the database above -- so a half table cannot
    -- be passed off as a full one, or the reverse.
    if p_ticket_type_code not in ('full_table', 'half_table')
       or p_quantity <> 1
       or v_seat_count <> (case p_ticket_type_code when 'half_table' then 5 else 10 end) then
      raise exception 'A table order must be exactly one whole-table purchase';
    end if;
    if v_attendee_count < 1 or v_attendee_count > v_seat_count then
      raise exception 'A table requires between one and % pre-entered attendees', v_seat_count;
    end if;
  end if;

  -- Validate every attendee before creating any rows. Required fields are
  -- intentionally stricter here than the nullable storage columns.
  for v_attendee, v_index in
    select value, ordinality from jsonb_array_elements(p_attendees) with ordinality
  loop
    if jsonb_typeof(v_attendee) <> 'object' then
      raise exception 'Each attendee payload must be an object';
    end if;
    v_first := nullif(btrim(v_attendee->>'first_name'), '');
    v_last := nullif(btrim(v_attendee->>'last_name'), '');
    v_email := nullif(lower(btrim(v_attendee->>'email')), '');
    v_secondary_email := nullif(lower(btrim(v_attendee->>'secondary_email')), '');
    v_job_title := nullif(btrim(v_attendee->>'job_title'), '');
    v_company := nullif(btrim(v_attendee->>'company'), '');
    v_meal := nullif(btrim(v_attendee->>'meal_preference'), '');
    if v_first is null or v_last is null or v_email is null
       or v_job_title is null or v_company is null or v_meal is null then
      raise exception 'Attendee % is missing a required identity, organization, or meal field', v_index;
    end if;
    -- Refused before any row is written, so a missing number cannot produce a
    -- half-made order. Every seat on the registration needs a number, not only
    -- the buyer's: the buyer confirms at checkout that they hold each guest's
    -- permission, and staff must be able to reach every attendee on the night.
    if private.ssuite_phone(v_attendee->>'phone') is null then
      if v_email = lower(btrim(v_purchaser_email)) then
        raise exception 'A mobile phone number is required for the person registering';
      end if;
      raise exception 'A mobile phone number is required for every guest on this registration';
    end if;
    if length(v_email) > 320
       or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      raise exception 'Attendee % primary email address is invalid', v_index;
    end if;
    v_email := lower(v_email);
    if v_email = any(v_attendee_emails) then
      raise exception 'Attendee % primary email is duplicated in this order', v_index;
    end if;
    v_attendee_emails := array_append(v_attendee_emails, v_email);
    if v_secondary_email is not null then
      if length(v_secondary_email) > 320
         or v_secondary_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
        raise exception 'Attendee % secondary email address is invalid', v_index;
      end if;
      v_secondary_email := lower(v_secondary_email);
    end if;
    if v_secondary_email is not null and v_secondary_email = v_email then
      raise exception 'Attendee % secondary email must differ from primary email', v_index;
    end if;
    v_has_dietary := coalesce(nullif(v_attendee->>'has_dietary_or_allergy_needs', '')::boolean, false);
    v_dietary := nullif(btrim(v_attendee->>'dietary_or_allergy_details'), '');
    if v_has_dietary and v_dietary is null then
      raise exception 'Attendee % dietary or allergy details are required', v_index;
    end if;
    v_has_accessibility := coalesce(nullif(v_attendee->>'has_accessibility_needs', '')::boolean, false);
    v_accessibility := nullif(btrim(v_attendee->>'accessibility_details'), '');
    if v_has_accessibility and v_accessibility is null then
      raise exception 'Attendee % accessibility details are required', v_index;
    end if;
  end loop;

  -- Locking the event serializes this capacity check with other SSuite holds.
  update public.inventory_holds
  set status = 'expired', updated_at = now()
  where event_id = v_event_id and status = 'active' and expires_at <= now();
  select coalesce(sum(oi.seats_reserved), 0) into v_committed
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where o.event_id = v_event_id and o.status in ('paid','partially_refunded');
  v_committed := v_committed + private.ssuite_general_claim_seats(v_event_id);
  select coalesce(sum(h.seats), 0) into v_held
  from public.inventory_holds h
  where h.event_id = v_event_id and h.status = 'active' and h.expires_at > now();
  if v_committed + v_held + v_seats > v_event_capacity then
    raise exception 'Requested seats are no longer available';
  end if;

  -- Recheck after inventory/code locks: a pre-deadline request may have waited.
  if private.ssuite_partner_paid_closed(p_member_code, clock_timestamp()) or private.ssuite_partner_paid_closed(p_attribution_code, clock_timestamp()) then
    raise exception 'The event is now at capacity. Thank you so much for your interest.';
  end if;


  -- Public registration closed; valid private invitations retain existing eligibility.
  if not (private.ssuite_has_private_paid_invitation(p_member_code) or private.ssuite_has_private_paid_invitation(p_attribution_code)) then
    raise exception 'Public registration is now closed. Please email ssuite@salute.community for inquiries.';
  end if;

  insert into public.orders (
    event_id, order_type, status, purchaser_first_name, purchaser_last_name,
    purchaser_email, purchaser_phone, how_heard, subtotal_cents, total_cents, currency,
    -- Membership outcome belongs in its own reviewable columns, not only in
    -- metadata, so staff can see which member-rate orders still need review.
    member_verification_status, membership_email,
    metadata
  ) values (
    v_event_id, p_order_type, 'inventory_held', v_purchaser_first, v_purchaser_last,
    v_purchaser_email, v_purchaser_phone, btrim(p_how_heard),
    v_total, v_total, v_currency,
    v_membership_status, v_membership_email,
    jsonb_build_object(
      'checkout_source', 'ssuite_create_checkout',
      'membership_status', v_membership_status,
      'member_guest_seats', v_guest_qty,
      'invitation_code', v_attr_code_text
    ) || case when v_honoree_table_kind is not null
              then jsonb_build_object('honoree_table_kind', v_honoree_table_kind)
              else '{}'::jsonb end
  ) returning id into v_order_id;

  -- Guard on a plain scalar: plpgsql raises when a field of an unassigned
  -- record is read, even inside a condition that is already false.
  if v_code_id is not null then
    insert into public.member_access_code_redemptions (code_id, order_id, redeemer_email, seats)
    values (v_code_id, v_order_id, v_purchaser_email, p_quantity);
  end if;

  -- Credited for every seat on the registration, not only the member's own:
  -- the host invited the party, and seating needs to know who else is in it.
  if v_attr_code_id is not null then
    insert into public.member_access_code_redemptions (code_id, order_id, redeemer_email, seats)
    values (v_attr_code_id, v_order_id, v_purchaser_email, v_seats);
  end if;

  insert into public.order_items (
    event_id, order_id, ticket_type_id, description, quantity,
    unit_amount_cents, seats_reserved, stripe_price_id
  ) values (
    v_event_id, v_order_id, v_ticket_id,
    (select name from public.ticket_types where id = v_ticket_id),
    p_quantity, v_amount, 0, v_price_id
  ) returning id into v_item_id;

  if v_guest_qty > 0 then
    insert into public.order_items (
      event_id, order_id, ticket_type_id, description, quantity,
      unit_amount_cents, seats_reserved, stripe_price_id
    ) values (
      v_event_id, v_order_id, v_guest_ticket_id,
      (select name from public.ticket_types where id = v_guest_ticket_id),
      v_guest_qty, v_guest_amount, 0, v_guest_price_id
    ) returning id into v_guest_item_id;
  end if;

  insert into public.consents (
    event_id, order_id, scope, accepted, terms_version, privacy_version,
    media_release_version, accepted_at, ip_hash, user_agent, source
  ) values (
    v_event_id, v_order_id, 'purchaser_and_included_guests', true,
    v_policy.terms_version, v_policy.privacy_version, v_policy.media_release_version,
    coalesce(p_accepted_at, now()), p_ip_hash, p_user_agent, 'checkout'
  );

  -- These attendees are pre-entered by the purchaser and remain pending until
  -- Stripe payment is durably finalized.
  for v_attendee, v_index in
    select value, ordinality from jsonb_array_elements(p_attendees) with ordinality
  loop
    v_first := nullif(btrim(v_attendee->>'first_name'), '');
    v_last := nullif(btrim(v_attendee->>'last_name'), '');
    v_email := nullif(lower(btrim(v_attendee->>'email')), '');
    v_secondary_email := nullif(lower(btrim(v_attendee->>'secondary_email')), '');
    v_phone := private.ssuite_phone(v_attendee->>'phone');
    v_job_title := nullif(btrim(v_attendee->>'job_title'), '');
    v_company := nullif(btrim(v_attendee->>'company'), '');
    v_pronunciation := nullif(btrim(v_attendee->>'pronunciation'), '');
    v_bio := nullif(btrim(v_attendee->>'bio'), '');
    v_relationship_notes := nullif(btrim(v_attendee->>'relationship_notes'), '');
    v_meal := nullif(btrim(v_attendee->>'meal_preference'), '');
    v_has_dietary := coalesce(nullif(v_attendee->>'has_dietary_or_allergy_needs', '')::boolean, false);
    v_dietary := nullif(btrim(v_attendee->>'dietary_or_allergy_details'), '');
    v_has_accessibility := coalesce(nullif(v_attendee->>'has_accessibility_needs', '')::boolean, false);
    v_accessibility := nullif(btrim(v_attendee->>'accessibility_details'), '');
    v_is_purchaser := lower(v_email) = lower(v_purchaser_email) and not v_purchaser_marked;
    if v_is_purchaser then v_purchaser_marked := true; end if;

    -- Seat one is the member's own seat; every later seat in a combined order
    -- belongs to the Community-rate guest line item.
    if v_guest_qty > 0 and v_index > 1 then
      v_target_item_id := v_guest_item_id;
      v_target_ticket_id := v_guest_ticket_id;
    else
      v_target_item_id := v_item_id;
      v_target_ticket_id := v_ticket_id;
    end if;

    insert into public.attendees (
      event_id, order_id, order_item_id, ticket_type_id, first_name, last_name,
      email, secondary_email, phone, job_title, company, pronunciation, bio,
      relationship_notes, source, is_purchaser
    ) values (
      v_event_id, v_order_id, v_target_item_id, v_target_ticket_id, v_first, v_last,
      v_email, v_secondary_email, v_phone, v_job_title, v_company, v_pronunciation, v_bio,
      v_relationship_notes, 'purchaser_entry', v_is_purchaser
    ) returning id into v_attendee_id;

    insert into public.attendee_needs (
      attendee_id, meal_preference, has_dietary_or_allergy_needs,
      dietary_or_allergy_details, has_accessibility_needs, accessibility_details
    ) values (
      v_attendee_id, v_meal, v_has_dietary, v_dietary, v_has_accessibility, v_accessibility
    );

    -- The buyer's own seat is their own consent. A guest the buyer entered is
    -- recorded under a different source, so the data never reads as a personal
    -- opt-in by someone who never saw the form.
    if v_phone is not null then
      perform private.record_ssuite_sms_consent(
        v_attendee_id, v_phone,
        case when v_is_purchaser then 'checkout' else 'checkout_purchaser_confirmed' end
      );
    end if;
  end loop;

  v_expires_at := now() + make_interval(mins => v_hold_minutes);
  insert into public.inventory_holds (
    event_id, order_id, hold_token_hash, seats, expires_at
  ) values (
    v_event_id, v_order_id, p_hold_token_hash, v_seats, v_expires_at
  ) returning id into v_hold_id;

  return query select v_order_id, v_hold_id, v_expires_at, v_ticket_id, v_price_id,
    v_amount, v_currency, p_quantity, v_total,
    v_guest_ticket_id, v_guest_price_id, v_guest_amount, v_guest_qty;
end;
$function$
;