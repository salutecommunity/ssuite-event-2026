-- Preview only. Do not apply to production without review.
begin;
alter table public.ssuite_admin_table_capacity_claims drop constraint ssuite_admin_table_capacity_claims_seats_check;
alter table public.ssuite_admin_table_capacity_claims add constraint ssuite_admin_table_capacity_claims_seats_check check (seats in (5,10));
CREATE OR REPLACE FUNCTION private.validate_ssuite_admin_table_capacity_claim()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_capacity integer; v_used bigint;
begin
  select reserved_capacity into v_capacity from public.events where id=new.event_id for update;
  select coalesce((select sum(seats) from public.reserved_allocations where event_id=new.event_id and status='active'),0)
       + coalesce((select sum(seats) from public.ssuite_admin_table_capacity_claims where event_id=new.event_id and table_id<>new.table_id),0)
    into v_used;
  if v_used+new.seats>v_capacity then raise exception 'Reserved capacity is unavailable for a reserved table'; end if;
  if not exists(select 1 from public.event_tables t where t.id=new.table_id and t.event_id=new.event_id and t.order_id is null and t.seat_count=new.seats) then
    raise exception 'A manual capacity claim requires a same-event reserved table without an order';
  end if;
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.create_ssuite_admin_table(p_actor_user_id uuid, p_event_id uuid, p_request_id uuid, p_record jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_class text;v_reason text;v_approver text;v_name text;v_number integer;v_seats integer;v_order uuid;v_table uuid;v_old record;v_result jsonb;v_fp text;
begin
  perform private.require_ssuite_staff_permission(p_actor_user_id,'ssuite_registration_write');
  perform private.require_ssuite_staff_permission(p_actor_user_id,'ssuite_seating_write');
  if p_request_id is null or p_event_id is null or p_record is null or jsonb_typeof(p_record)<>'object' or pg_column_size(p_record)>8192 then raise exception 'Invalid table request'; end if;
  if exists(select 1 from jsonb_object_keys(p_record) k where k not in ('table_number','name','provenance','reason','approver','order_id','seat_count')) then raise exception 'Invalid table request fields'; end if;
  v_class:=nullif(btrim(p_record->>'provenance'),'');v_reason:=nullif(btrim(p_record->>'reason'),'');v_approver:=nullif(btrim(p_record->>'approver'),'');v_name:=nullif(btrim(p_record->>'name'),'');
  begin v_number:=(p_record->>'table_number')::integer; exception when others then raise exception 'Table number is invalid'; end;
  begin v_order:=nullif(p_record->>'order_id','')::uuid; exception when others then raise exception 'Order is invalid'; end;
  if v_class is null or v_class not in ('complimentary','sponsor','honoree','staff','pre_existing_paid') or v_number not between 1 and 9999 or v_name is null or length(v_name)>300 or v_name~'[[:cntrl:]]' then raise exception 'Required table details are invalid'; end if;
  if (v_class='pre_existing_paid')<>(v_order is not null) then raise exception 'A paid table must link one existing paid table order; manual tables cannot link an order'; end if;
  if v_class<>'pre_existing_paid' and (v_reason is null or v_approver is null or length(v_reason)>2000 or length(v_approver)>300 or v_reason~'[[:cntrl:]]' or v_approver~'[[:cntrl:]]') then raise exception 'Reserved table reason and approver are required'; end if;
  v_seats:=coalesce((p_record->>'seat_count')::integer,10);
  if v_seats not in (5,10) or (v_class='pre_existing_paid' and v_seats<>10) then raise exception 'Choose five or ten reserved seats; paid tables use the existing paid flow'; end if;
  v_fp:=md5(p_record::text);perform pg_advisory_xact_lock(hashtext('ssuite-admin-create-table:'||p_request_id::text));
  select * into v_old from public.ssuite_admin_operation_requests where request_id=p_request_id for update;
  if found then if v_old.operation<>'create_table' or v_old.event_id<>p_event_id or v_old.payload_fingerprint<>v_fp then raise exception 'Request ID was reused with a different table request'; end if; return v_old.result; end if;
  perform 1 from public.events where id=p_event_id for update; if not found then raise exception 'Event not found'; end if;
  if v_class='pre_existing_paid' then
    if not exists(select 1 from public.orders o where o.id=v_order and o.event_id=p_event_id and o.order_type='table' and o.status in ('paid','partially_refunded'))
       or exists(select 1 from public.event_tables t where t.order_id=v_order)
       or (select count(*) from public.seat_entitlements e where e.order_id=v_order and e.event_id=p_event_id and e.status='active')<>10 then
      raise exception 'The selected order is not an eligible existing paid ten-seat table order';
    end if;
  end if;
  insert into public.event_tables(event_id,order_id,table_number,name,seat_count,status) values(p_event_id,v_order,v_number,v_name,v_seats,'active') returning id into v_table;
  insert into public.table_seats(event_id,table_id,seat_number) select p_event_id,v_table,gs from generate_series(1,v_seats) gs;
  if v_class<>'pre_existing_paid' then insert into public.ssuite_admin_table_capacity_claims(table_id,event_id,provenance,seats,reason,approver,created_by) values(v_table,p_event_id,v_class,v_seats,v_reason,v_approver,p_actor_user_id); end if;
  v_result:=jsonb_build_object('table_id',v_table,'table_number',v_number,'status','active','provenance',v_class,'created',true,'nothing_sent',true);
  insert into public.ssuite_admin_operation_requests(request_id,operation,payload_fingerprint,event_id,actor_user_id,result) values(p_request_id,'create_table',v_fp,p_event_id,p_actor_user_id,v_result);
  insert into public.ssuite_admin_provenance(event_id,subject_type,subject_id,classification,reason,approver,linked_order_id,request_id,actor_user_id,metadata) values(p_event_id,'table',v_table,v_class,v_reason,v_approver,v_order,p_request_id,p_actor_user_id,jsonb_build_object('seat_count',v_seats,'nothing_sent',true));
  perform private.ssuite_staff_audit(p_event_id,p_actor_user_id,'ssuite_admin_table_created','event_table',v_table,jsonb_build_object('provenance',v_class,'linked_existing_paid_order',v_order is not null,'nothing_sent',true));
  return v_result;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.create_ssuite_admin_attendee(p_actor_user_id uuid, p_event_id uuid, p_request_id uuid, p_record jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_class text;v_reason text;v_approver text;v_first text;v_last text;v_email text;v_secondary text;v_title text;v_company text;v_table uuid;v_seat_number integer;v_seat uuid;v_table_row public.event_tables%rowtype;v_claim public.ssuite_admin_table_capacity_claims%rowtype;v_ent record;v_attendee uuid;v_old record;v_result jsonb;v_fp text;v_needs jsonb;v_meal text;v_hd boolean;v_dietary text;v_ha boolean;v_access text;
begin
  perform private.require_ssuite_staff_permission(p_actor_user_id,'ssuite_registration_write');
  perform private.require_ssuite_staff_permission(p_actor_user_id,'ssuite_seating_write');
  if p_request_id is null or p_event_id is null or p_record is null or jsonb_typeof(p_record)<>'object' or pg_column_size(p_record)>12288 then raise exception 'Invalid attendee request'; end if;
  if exists(select 1 from jsonb_object_keys(p_record) k where k not in ('first_name','last_name','email','secondary_email','phone','job_title','company','pronunciation','bio','relationship_notes','linkedin_url','provenance','reason','approver','table_id','seat_number','needs')) then raise exception 'Invalid attendee request fields'; end if;
  v_class:=nullif(btrim(p_record->>'provenance'),'');v_reason:=nullif(btrim(p_record->>'reason'),'');v_approver:=nullif(btrim(p_record->>'approver'),'');v_first:=nullif(btrim(p_record->>'first_name'),'');v_last:=nullif(btrim(p_record->>'last_name'),'');v_email:=lower(nullif(btrim(p_record->>'email'),''));v_secondary:=lower(nullif(btrim(p_record->>'secondary_email'),''));v_title:=nullif(btrim(p_record->>'job_title'),'');v_company:=nullif(btrim(p_record->>'company'),'');
  begin v_table:=nullif(p_record->>'table_id','')::uuid; exception when others then raise exception 'Table is invalid'; end;
  begin v_seat_number:=nullif(p_record->>'seat_number','')::integer; exception when others then raise exception 'Seat is invalid'; end;
  if v_class is null or v_class not in ('complimentary','sponsor','honoree','staff','pre_existing_paid') or v_first is null or v_last is null or v_email is null or length(v_first)>200 or length(v_last)>200 or length(v_email)>320 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' or v_title is null or v_company is null or length(v_title)>300 or length(v_company)>300 or v_first~'[[:cntrl:]]' or v_last~'[[:cntrl:]]' then raise exception 'Required attendee details are invalid'; end if;
  if v_secondary is not null and (length(v_secondary)>320 or v_secondary !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' or v_secondary=v_email) then raise exception 'Secondary email must be valid and different from primary email'; end if;
  if length(coalesce(p_record->>'pronunciation',''))>300 or length(coalesce(p_record->>'bio',''))>5000 or length(coalesce(p_record->>'relationship_notes',''))>2000 or length(coalesce(p_record->>'linkedin_url',''))>500 then raise exception 'Additional attendee details are too long'; end if;
  if nullif(btrim(p_record->>'linkedin_url'),'') is not null and nullif(btrim(p_record->>'linkedin_url'),'') !~* '^https://([a-z]{2,3}[.])?linkedin[.]com/' then raise exception 'LinkedIn profile is invalid'; end if;
  if (v_table is null)<>(v_seat_number is null) or (v_table is not null and v_seat_number not between 1 and 10) then raise exception 'A numbered table seat must be selected together'; end if;
  if v_class<>'pre_existing_paid' and (v_reason is null or v_approver is null or length(v_reason)>2000 or length(v_approver)>300 or v_reason~'[[:cntrl:]]' or v_approver~'[[:cntrl:]]') then raise exception 'Reserved attendee reason and approver are required'; end if;
  v_needs:=p_record->'needs';
  if v_needs is not null and (jsonb_typeof(v_needs)<>'object' or v_needs ?| array['consent','accepted','terms_version','privacy_version','media_release_version']) then raise exception 'Needs details are invalid'; end if;
  v_fp:=md5(p_record::text);perform pg_advisory_xact_lock(hashtext('ssuite-admin-create-attendee:'||p_request_id::text));
  select * into v_old from public.ssuite_admin_operation_requests where request_id=p_request_id for update;
  if found then if v_old.operation<>'create_attendee' or v_old.event_id<>p_event_id or v_old.payload_fingerprint<>v_fp then raise exception 'Request ID was reused with a different attendee request'; end if; return v_old.result; end if;
  perform 1 from public.events where id=p_event_id for update; if not found then raise exception 'Event not found'; end if;
  -- Event row lock serializes staff creation; idempotent retries return above.
  if exists(select 1 from public.attendees a where a.event_id=p_event_id and (lower(a.email)=v_email or lower(a.secondary_email)=v_email or (v_secondary is not null and (lower(a.email)=v_secondary or lower(a.secondary_email)=v_secondary)))) then raise exception 'This guest already exists; assign or edit the existing record instead'; end if;
  if v_table is null and v_class='pre_existing_paid' then raise exception 'Pre-existing paid attendees must use a paid table seat'; end if;
  if v_table is not null then
    select * into v_table_row from public.event_tables where id=v_table and event_id=p_event_id and status='active' for update;
    if not found then raise exception 'The selected table is unavailable'; end if;
    select id into v_seat from public.table_seats where table_id=v_table and event_id=p_event_id and seat_number=v_seat_number and not locked and attendee_id is null for update;
    if not found or exists(select 1 from public.invitations i where i.seat_id=v_seat and i.status in ('draft','queued','sent','opened','started')) then raise exception 'The selected table seat is unavailable'; end if;
    if v_table_row.order_id is null then
      select * into v_claim from public.ssuite_admin_table_capacity_claims where table_id=v_table for update;
      if not found or v_class='pre_existing_paid' or v_claim.provenance<>v_class then raise exception 'A manual table attendee must use the table’s reserved provenance'; end if;
      insert into public.attendees(event_id,table_id,first_name,last_name,email,secondary_email,phone,job_title,company,pronunciation,bio,relationship_notes,linkedin_url,source,registration_status) values(p_event_id,v_table,v_first,v_last,v_email,v_secondary,nullif(btrim(p_record->>'phone'),''),v_title,v_company,nullif(btrim(p_record->>'pronunciation'),''),nullif(btrim(p_record->>'bio'),''),nullif(btrim(p_record->>'relationship_notes'),''),nullif(btrim(p_record->>'linkedin_url'),''),case when v_class='complimentary' then 'complimentary' else 'staff' end,'pending') returning id into v_attendee;
    else
      if v_class<>'pre_existing_paid' then raise exception 'A paid table seat requires pre_existing_paid provenance'; end if;
      select oi.id as item_id,oi.ticket_type_id,e.id as entitlement_id into v_ent from public.order_items oi join public.seat_entitlements e on e.order_item_id=oi.id and e.event_id=oi.event_id
       where oi.order_id=v_table_row.order_id and oi.event_id=p_event_id and e.status='active' and not exists(select 1 from public.attendees a where a.seat_entitlement_id=e.id) order by e.seat_index for update of e skip locked limit 1;
      if not found then raise exception 'No unassigned active entitlement remains for this paid table'; end if;
      insert into public.attendees(event_id,order_id,order_item_id,ticket_type_id,seat_entitlement_id,table_id,first_name,last_name,email,secondary_email,phone,job_title,company,pronunciation,bio,relationship_notes,linkedin_url,source,registration_status) values(p_event_id,v_table_row.order_id,v_ent.item_id,v_ent.ticket_type_id,v_ent.entitlement_id,v_table,v_first,v_last,v_email,v_secondary,nullif(btrim(p_record->>'phone'),''),v_title,v_company,nullif(btrim(p_record->>'pronunciation'),''),nullif(btrim(p_record->>'bio'),''),nullif(btrim(p_record->>'relationship_notes'),''),nullif(btrim(p_record->>'linkedin_url'),''),'manual_table','pending') returning id into v_attendee;
    end if;
    update public.table_seats set attendee_id=v_attendee where id=v_seat;
  else
    insert into public.attendees(event_id,first_name,last_name,email,secondary_email,phone,job_title,company,pronunciation,bio,relationship_notes,linkedin_url,source,registration_status) values(p_event_id,v_first,v_last,v_email,v_secondary,nullif(btrim(p_record->>'phone'),''),v_title,v_company,nullif(btrim(p_record->>'pronunciation'),''),nullif(btrim(p_record->>'bio'),''),nullif(btrim(p_record->>'relationship_notes'),''),nullif(btrim(p_record->>'linkedin_url'),''),case when v_class='complimentary' then 'complimentary' else 'staff' end,'pending') returning id into v_attendee;
    insert into public.reserved_allocations(event_id,attendee_id,source,status) values(p_event_id,v_attendee,case v_class when 'complimentary' then 'complimentary' when 'sponsor' then 'sponsor' when 'honoree' then 'honoree' else 'staff' end,'active');
  end if;
  if v_needs is not null then
    v_meal:=nullif(btrim(v_needs->>'meal_preference'),'');
    begin v_hd:=coalesce((v_needs->>'has_dietary_or_allergy_needs')::boolean,false);v_ha:=coalesce((v_needs->>'has_accessibility_needs')::boolean,false); exception when others then raise exception 'Need selections are invalid'; end;
    v_dietary:=nullif(btrim(v_needs->>'dietary_or_allergy_details'),'');v_access:=nullif(btrim(v_needs->>'accessibility_details'),'');
    if v_meal is null or length(v_meal)>200 or (v_hd and (v_dietary is null or length(v_dietary)>2000)) or (v_ha and (v_access is null or length(v_access)>2000)) then raise exception 'Needs details are incomplete'; end if;
    insert into public.attendee_needs(attendee_id,meal_preference,has_dietary_or_allergy_needs,dietary_or_allergy_details,has_accessibility_needs,accessibility_details) values(v_attendee,v_meal,v_hd,case when v_hd then v_dietary else null end,v_ha,case when v_ha then v_access else null end);
  end if;
  v_result:=jsonb_build_object('attendee_id',v_attendee,'table_id',v_table,'seat_number',v_seat_number,'registration_status','pending','provenance',v_class,'created',true,'nothing_sent',true);
  insert into public.ssuite_admin_operation_requests(request_id,operation,payload_fingerprint,event_id,actor_user_id,result) values(p_request_id,'create_attendee',v_fp,p_event_id,p_actor_user_id,v_result);
  insert into public.ssuite_admin_provenance(event_id,subject_type,subject_id,classification,reason,approver,linked_order_id,request_id,actor_user_id,metadata) values(p_event_id,'attendee',v_attendee,v_class,v_reason,v_approver,case when v_table_row.order_id is not null then v_table_row.order_id else null end,p_request_id,p_actor_user_id,jsonb_build_object('table_id',v_table,'seat_number',v_seat_number,'needs_recorded',v_needs is not null,'consent_created',false,'nothing_sent',true));
  perform private.ssuite_staff_audit(p_event_id,p_actor_user_id,'ssuite_admin_attendee_created','attendee',v_attendee,jsonb_build_object('provenance',v_class,'table_id',v_table,'seat_number',v_seat_number,'registration_status','pending','nothing_sent',true));
  return v_result;
end;
$function$
;
-- Included by migration.sql; one transaction encompasses table, host, seat and lead.
alter table public.ssuite_admin_operation_requests drop constraint ssuite_admin_operation_requests_operation_check;
alter table public.ssuite_admin_operation_requests add constraint ssuite_admin_operation_requests_operation_check check (operation in ('create_table','create_attendee','create_allocated_host'));
create or replace function public.create_ssuite_admin_allocated_host(p_actor_user_id uuid, p_event_id uuid, p_request_id uuid, p_record jsonb)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog'
as $function$
declare v_old record; v_fp text; v_table jsonb; v_host jsonb; v_result jsonb; v_table_id uuid; v_attendee_id uuid;
begin
  perform private.require_ssuite_staff_permission(p_actor_user_id,'ssuite_registration_write');
  perform private.require_ssuite_staff_permission(p_actor_user_id,'ssuite_seating_write');
  if p_event_id is null or p_request_id is null or p_record is null or jsonb_typeof(p_record)<>'object' or pg_column_size(p_record)>12288 then raise exception 'Invalid allocated host request'; end if;
  if exists(select 1 from jsonb_object_keys(p_record) k where k not in ('table','host')) or jsonb_typeof(p_record->'table') is distinct from 'object' or jsonb_typeof(p_record->'host') is distinct from 'object' then raise exception 'Table and host details are required'; end if;
  v_table:=p_record->'table'; v_host:=p_record->'host';
  if coalesce(v_table->>'seat_count','') not in ('5','10') or nullif(btrim(v_table->>'table_number'),'') is null then raise exception 'A table number and five or ten allocated seats are required'; end if;
  if coalesce(v_table->>'provenance','') not in ('complimentary','sponsor','honoree','staff') or v_host->>'provenance' is distinct from v_table->>'provenance' then raise exception 'Matching reserved provenance is required; this is not a paid purchase'; end if;
  if v_table ? 'order_id' or v_host ?| array['table_id','seat_number','order_id','is_table_lead','registration_status','consent'] then raise exception 'Allocation cannot claim an order, existing seat, completion or consent'; end if;
  if v_host->>'reason' is distinct from v_table->>'reason' or v_host->>'approver' is distinct from v_table->>'approver' then raise exception 'Allocation and host must share reason and approver'; end if;
  v_fp:=md5(p_record::text);
  perform pg_advisory_xact_lock(hashtext('ssuite-admin-allocated-host:'||p_request_id::text));
  select * into v_old from public.ssuite_admin_operation_requests where request_id=p_request_id for update;
  if found then
    if v_old.operation<>'create_allocated_host' or v_old.event_id<>p_event_id or v_old.actor_user_id<>p_actor_user_id or v_old.payload_fingerprint<>v_fp then raise exception 'Request ID was reused with different allocation details'; end if;
    return v_old.result;
  end if;
  -- Existing RPCs enforce capacity, duplicate guest protection and immutable provenance.
  -- Child request UUIDs and every write roll back together if any step fails.
  v_result:=public.create_ssuite_admin_table(p_actor_user_id,p_event_id,gen_random_uuid(),v_table);
  v_table_id:=(v_result->>'table_id')::uuid;
  v_result:=public.create_ssuite_admin_attendee(p_actor_user_id,p_event_id,gen_random_uuid(),v_host||jsonb_build_object('table_id',v_table_id,'seat_number',1));
  v_attendee_id:=(v_result->>'attendee_id')::uuid;
  perform public.set_ssuite_admin_table_lead(p_actor_user_id,p_event_id,v_table_id,v_attendee_id);
  v_result:=jsonb_build_object('table_id',v_table_id,'attendee_id',v_attendee_id,'seat_number',1,'seat_count',(v_table->>'seat_count')::integer,'registration_status','pending','provenance',v_table->>'provenance','nothing_sent',true,'self_service_enabled',false,'created',true);
  insert into public.ssuite_admin_operation_requests(request_id,operation,payload_fingerprint,event_id,actor_user_id,result) values(p_request_id,'create_allocated_host',v_fp,p_event_id,p_actor_user_id,v_result);
  return v_result;
end;
$function$;
revoke all on function public.create_ssuite_admin_allocated_host(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.create_ssuite_admin_allocated_host(uuid,uuid,uuid,jsonb) to service_role;

-- Explicit staff action only: creating or completing a manual record does not enqueue here.
create or replace function public.ssuite_admin_manual_guest_email(p_actor_user_id uuid,p_event_id uuid,p_attendee_id uuid,p_send boolean default false)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog'
as $function$
declare a public.attendees%rowtype; i record; o record; v_kind text; v_key text; v_id uuid; v_existing boolean; v_hold timestamptz;
begin
  perform private.require_ssuite_staff_permission(p_actor_user_id,'ssuite_registration_write');
  select * into a from public.attendees where id=p_attendee_id and event_id=p_event_id for update;
  if not found or a.order_id is not null or a.registration_status not in ('pending','complete') then raise exception 'An active staff-added non-paid attendee is required'; end if;
  if not exists(select 1 from public.ssuite_admin_provenance p where p.event_id=p_event_id and p.subject_type='attendee' and p.subject_id=a.id and p.classification in ('complimentary','sponsor','honoree','staff')) then raise exception 'Staff-added provenance is required'; end if;
  if a.table_id is not null then
    if not exists(select 1 from public.event_tables t join public.ssuite_admin_table_capacity_claims c on c.table_id=t.id and c.event_id=t.event_id where t.id=a.table_id and t.event_id=p_event_id and t.order_id is null and t.status='active') then raise exception 'The reserved table is unavailable'; end if;
  elsif not exists(select 1 from public.reserved_allocations r where r.attendee_id=a.id and r.event_id=p_event_id and r.status='active') then raise exception 'An active reserved allocation is required'; end if;
  v_kind:=case when a.registration_status='complete' then 'ssuite_guest_registration_confirmation' else 'ssuite_finish_registration' end;
  select inv.* into i from public.invitations inv where inv.attendee_id=a.id and inv.event_id=p_event_id and inv.token_kind='registration_completion' and inv.revoked_at is null and inv.status not in ('revoked','expired') and (inv.expires_at is null or inv.expires_at>now()) and lower(btrim(inv.recipient_email))=lower(btrim(a.email)) order by inv.created_at desc limit 1;
  if a.registration_status='complete' then v_key:='guest-registration-confirmation:'||a.id::text||':v1';
  elsif i.id is not null then v_key:='completion:'||i.id::text||':v1'; end if;
  select * into o from public.ssuite_email_outbox where event_id=p_event_id and message_type=v_kind and idempotency_key=v_key;
  v_existing:=found;
  if coalesce(p_send,false) then
    if i.id is null then raise exception 'A valid personal completion link is required before this email can be sent'; end if;
    if a.registration_status='complete' and i.status<>'completed' then raise exception 'Personal registration must be complete before confirmation'; end if;
    v_id:=public.queue_ssuite_email(p_event_id,v_kind,lower(btrim(a.email)),'attendee',a.id,v_key,case when a.registration_status='complete' then jsonb_build_object('attendee_id',a.id::text) else jsonb_build_object('attendee_id',a.id::text,'invitation_id',i.id::text) end);
    select * into o from public.ssuite_email_outbox where id=v_id;
    if not v_existing then
      perform private.ssuite_staff_audit(p_event_id,p_actor_user_id,'ssuite_manual_guest_email_queued','attendee',a.id,jsonb_build_object('message_type',v_kind,'outbox_id',v_id,'recipient',a.email,'payment_claimed',false));
    end if;
  end if;
  select hold_until into v_hold from public.ssuite_email_compliance_holds where message_type=v_kind;
  return jsonb_build_object('attendee_id',a.id,'recipient',a.email,'registration_status',a.registration_status,'message_type',v_kind,'status',coalesce(o.status,'not_queued'),'outbox_id',o.id,'accepted_at',o.accepted_at,'delivered_at',o.delivered_at,'held_until',v_hold,'existing',v_existing,'self_service_table_management',false,'requires_personal_completion',a.registration_status<>'complete');
end;
$function$;
revoke all on function public.ssuite_admin_manual_guest_email(uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.ssuite_admin_manual_guest_email(uuid,uuid,uuid,boolean) to service_role;

-- Reserved hosts never receive a paid-table management template automatically on completion.
-- Existing paid-host behavior remains unchanged, including its existing error handling.
create or replace function private.queue_ssuite_table_host_access_on_completion()
returns trigger language plpgsql security definer set search_path to 'pg_catalog'
as $function$
begin
  if old.registration_status is distinct from 'complete' and new.registration_status='complete' and new.is_table_lead is true and new.table_id is not null
     and exists(select 1 from public.event_tables t join public.orders o on o.id=t.order_id and o.event_id=t.event_id where t.id=new.table_id and t.event_id=new.event_id and o.status in ('paid','partially_refunded')) then
    begin
      perform public.queue_ssuite_table_lead_access(new.table_id,new.id);
    exception when others then
      begin
        insert into public.audit_log(event_id,actor_user_id,actor_type,action,entity_type,entity_id,metadata) values(new.event_id,null,'system','ssuite_table_host_access_queue_failed','attendee',new.id,jsonb_build_object('table_id',new.table_id::text,'sqlstate',sqlstate,'detail',sqlerrm,'consequence','Staff should confirm the paid table credential and re-queue.'));
      exception when others then null; end;
    end;
  end if;
  return new;
end;
$function$;

commit;
