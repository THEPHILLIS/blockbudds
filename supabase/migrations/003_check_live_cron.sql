-- Schedule the check-live Edge Function every 2 minutes.
-- Requires 002_live_status.sql and a Vault secret named check_live_cron_secret
-- (create it separately; do not put the secret value in this file).
-- Project: kpaiacaqylipffdilnci (eu-central-1)

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- pg_net must not be callable by client roles (SSRF).
revoke usage on schema net from anon, authenticated, public;
revoke all on all functions in schema net from anon, authenticated, public;

-- Unschedule a previous copy of this job if it exists.
do $$
declare
  j bigint;
begin
  for j in select jobid from cron.job where jobname = 'check-live-every-2-min'
  loop
    perform cron.unschedule(j);
  end loop;
end
$$;

select cron.schedule(
  'check-live-every-2-min',
  '*/2 * * * *',
  $$
  select net.http_post(
    url := 'https://kpaiacaqylipffdilnci.supabase.co/functions/v1/check-live',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'check_live_cron_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) as request_id;
  $$
);
