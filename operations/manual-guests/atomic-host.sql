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
