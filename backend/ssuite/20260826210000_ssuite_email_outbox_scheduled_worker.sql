-- S.Suite: scheduled worker that drains the email outbox.
--
-- `email-operations-dispatch` is not self-triggering. Nothing has ever invoked it, which is one
-- of the two reasons no S.Suite email has ever been sent. This adds the missing scheduler.
--
-- The worker holds no secret in its own body. It reads the service-role bearer and the
-- functions base URL from Vault at call time, and returns a truthful "skipped" string when
-- either is absent, so the job is safe to install before the secrets exist.

create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;
create extension if not exists pg_cron;

create schema if not exists ssuite_ops;
revoke all on schema ssuite_ops from public;

create or replace function ssuite_ops.drain_email_outbox(p_max integer default 10)
returns text
language plpgsql
security definer
set search_path = ssuite_ops, public, extensions, vault
as $$
declare
  v_base_url    text;
  v_service_key text;
  v_request_id  bigint;
begin
  select decrypted_secret into v_base_url
    from vault.decrypted_secrets where name = 'ssuite_functions_base_url' limit 1;
  select decrypted_secret into v_service_key
    from vault.decrypted_secrets where name = 'ssuite_service_role_key' limit 1;

  -- Fail closed and say so plainly rather than pretending work happened.
  if v_base_url is null or btrim(v_base_url) = '' or v_service_key is null or btrim(v_service_key) = '' then
    return 'skipped: worker credentials are not configured in Vault';
  end if;
  if btrim(v_base_url) !~ '^https://[a-z0-9.-]+/functions/v1/?$' then
    return 'skipped: ssuite_functions_base_url is not a valid functions endpoint';
  end if;

  select net.http_post(
    url                 => rtrim(btrim(v_base_url), '/') || '/email-operations-dispatch',
    headers             => jsonb_build_object(
                             'Content-Type', 'application/json',
                             'Authorization', 'Bearer ' || btrim(v_service_key)),
    body                => jsonb_build_object('max', greatest(1, least(coalesce(p_max, 10), 20))),
    timeout_milliseconds => 20000
  ) into v_request_id;

  return 'queued request ' || v_request_id;
end;
$$;

revoke all on function ssuite_ops.drain_email_outbox(integer) from public;
revoke all on function ssuite_ops.drain_email_outbox(integer) from anon, authenticated;

select cron.schedule(
  'ssuite-email-outbox-drain',
  '* * * * *',
  $job$select ssuite_ops.drain_email_outbox(10);$job$
);

-- To activate, with the real values, run once per project:
--   select vault.create_secret('https://{project}.supabase.co/functions/v1', 'ssuite_functions_base_url');
--   select vault.create_secret('{service role key}', 'ssuite_service_role_key');
