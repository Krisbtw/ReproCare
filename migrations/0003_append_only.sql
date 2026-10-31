-- 0003: database-level append-only protection for clinically relevant history.
--
-- Rules enforced here (not only in application code):
--   finding_versions, reviews, correspondence_decisions, audit_events
--     * UPDATE is refused.
--     * TRUNCATE is refused.
--     * A DIRECT DELETE of a row is refused.
--   Rows may still disappear when their parent patient is deleted (ON DELETE CASCADE).
--   That path is kept on purpose: a whole-record erasure (for example a data-erasure
--   request, or the admin "reset synthetic workspace") must stay possible. It is the
--   only way history can be removed, and it removes the whole patient, not one version.
--
-- How a cascade is told apart from a direct delete: pg_trigger_depth().
-- A direct DELETE fires this trigger at depth 1. A delete fired by the foreign-key
-- cascade runs inside another trigger, so the depth is 2 or more.
--
-- Limits (honest):
--   * A database superuser or the table owner can still drop the trigger. This guards
--     against application bugs and ordinary roles, not against a privileged operator.
--   * audit_events has no foreign key to patients, so it is never removed by cascade.
--     Nothing in the app deletes audit rows any more.

create or replace function ab_block_mutation() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'append-only: % cannot be updated (row %). Insert a new row instead.', tg_table_name, old.id
      using errcode = 'restrict_violation';
  elsif tg_op = 'DELETE' then
    if pg_trigger_depth() <= 1 then
      raise exception 'append-only: % rows cannot be deleted directly (row %).', tg_table_name, old.id
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;
  return null;
end;
$$;

create or replace function ab_block_truncate() returns trigger
language plpgsql as $$
begin
  raise exception 'append-only: % cannot be truncated.', tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['finding_versions', 'reviews', 'correspondence_decisions', 'audit_events']
  loop
    execute format('drop trigger if exists %I on %I', t || '_append_only', t);
    execute format(
      'create trigger %I before update or delete on %I for each row execute function ab_block_mutation()',
      t || '_append_only', t);
    execute format('drop trigger if exists %I on %I', t || '_no_truncate', t);
    execute format(
      'create trigger %I before truncate on %I for each statement execute function ab_block_truncate()',
      t || '_no_truncate', t);
  end loop;
end $$;
