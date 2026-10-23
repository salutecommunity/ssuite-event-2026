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
