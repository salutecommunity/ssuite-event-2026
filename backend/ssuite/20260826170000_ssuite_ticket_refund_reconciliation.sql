-- Reconcile Stripe ticket/table refunds without leaving paid access active after a full refund.
-- Service-role only. No email is sent by this migration.

create or replace function public.reconcile_ssuite_order_refund(
  p_order_id uuid,
  p_stripe_payment_intent_id text,
  p_charge_amount integer,
  p_amount_refunded integer,
  p_refunded_at timestamptz,
  p_stripe_event_id text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_order public.orders%rowtype;
  v_now timestamptz := coalesce(p_refunded_at, now());
  v_full boolean;
  v_table_ids uuid[];
begin
  if p_order_id is null
     or nullif(btrim(p_stripe_payment_intent_id), '') is null
     or nullif(btrim(p_stripe_event_id), '') is null
     or p_charge_amount is null or p_charge_amount <= 0
     or p_amount_refunded is null or p_amount_refunded <= 0
     or p_amount_refunded > p_charge_amount then
    raise exception 'Invalid Stripe refund reconciliation input';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then raise exception 'Order not found'; end if;
  if v_order.stripe_payment_intent_id is distinct from p_stripe_payment_intent_id then
    raise exception 'Stripe PaymentIntent does not match order';
  end if;
  if v_order.status not in ('paid','partially_refunded','refunded') then
    raise exception 'Order is not in a refundable state';
  end if;

  -- A duplicate cumulative refund event is idempotent.
  if v_order.status = 'refunded' then return 'already_refunded'; end if;

  v_full := p_charge_amount = v_order.total_cents
            and p_amount_refunded = p_charge_amount;

  if not v_full then
    update public.orders
    set status = 'partially_refunded',
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'refund_reconciliation', jsonb_build_object(
            'stripe_event_id', p_stripe_event_id,
            'charge_amount', p_charge_amount,
            'amount_refunded', p_amount_refunded,
            'requires_staff_review', p_charge_amount <> total_cents,
            'recorded_at', v_now
          )
        ),
        updated_at = now()
    where id = v_order.id;

    insert into public.audit_log(event_id, actor_type, action, entity_type, entity_id, metadata)
    values (v_order.event_id, 'system',
      case when p_charge_amount = v_order.total_cents then 'ssuite_order_partially_refunded' else 'ssuite_refund_amount_review_required' end,
      'order', v_order.id,
      jsonb_build_object('stripe_event_id', p_stripe_event_id, 'charge_amount', p_charge_amount,
                         'amount_refunded', p_amount_refunded));
    return case when p_charge_amount = v_order.total_cents then 'partially_refunded' else 'payment_review_required' end;
  end if;

  select coalesce(array_agg(id), array[]::uuid[]) into v_table_ids
  from public.event_tables where order_id = v_order.id;

  -- Stop unsent operational mail related to the refunded order.
  update public.ssuite_email_outbox
  set status = 'suppressed', suppressed_at = now(), lease_expires_at = null,
      failure_detail = 'Suppressed after verified full Stripe refund', updated_at = now()
  where entity_id = v_order.id and status in ('queued','processing');

  update public.communication_deliveries d
  set status = 'suppressed', lease_expires_at = null,
      failure_detail = 'Suppressed after verified full Stripe refund', updated_at = now()
  where d.status in ('queued','processing')
    and (
      d.attendee_id in (select a.id from public.attendees a where a.order_id = v_order.id)
      or d.invitation_id in (select i.id from public.invitations i where i.table_id = any(v_table_ids))
    );

  -- Invalidate every unconsumed guest and table-management credential.
  update public.invitations
  set status = 'revoked', revoked_at = coalesce(revoked_at, now()), updated_at = now()
  where table_id = any(v_table_ids)
    and status not in ('completed','revoked','expired');

  update public.table_management_tokens
  set status = 'revoked', revoked_at = coalesce(revoked_at, now()), updated_at = now()
  where table_id = any(v_table_ids) and status = 'active';

  -- Cancel registrations first so the capacity-protection triggers allow release.
  update public.attendees
  set registration_status = 'cancelled', updated_at = now()
  where order_id = v_order.id and registration_status <> 'cancelled';

  update public.table_seats
  set attendee_id = null, locked = false, updated_at = now()
  where table_id = any(v_table_ids);

  update public.seat_entitlements
  set status = 'released', updated_at = now()
  where order_id = v_order.id and status = 'active';

  update public.event_tables
  set status = 'cancelled', updated_at = now()
  where order_id = v_order.id and status <> 'cancelled';

  update public.orders
  set status = 'refunded', refunded_at = v_now,
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'refund_reconciliation', jsonb_build_object(
          'stripe_event_id', p_stripe_event_id,
          'charge_amount', p_charge_amount,
          'amount_refunded', p_amount_refunded,
          'recorded_at', v_now
        )
      ),
      updated_at = now()
  where id = v_order.id;

  insert into public.audit_log(event_id, actor_type, action, entity_type, entity_id, metadata)
  values (v_order.event_id, 'system', 'ssuite_order_fully_refunded', 'order', v_order.id,
          jsonb_build_object('stripe_event_id', p_stripe_event_id,
                             'charge_amount', p_charge_amount,
                             'amount_refunded', p_amount_refunded,
                             'registrations_cancelled', true,
                             'access_revoked', true));
  return 'refunded';
end;
$$;

revoke all on function public.reconcile_ssuite_order_refund(uuid,text,integer,integer,timestamptz,text)
  from public, anon, authenticated;
grant execute on function public.reconcile_ssuite_order_refund(uuid,text,integer,integer,timestamptz,text)
  to service_role;
