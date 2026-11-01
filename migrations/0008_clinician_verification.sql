-- 0008: Administrator-controlled clinician verification and role management.
-- Prevents self-promotion and provides an audited verification workflow.

create table if not exists clinician_verifications (
  id text primary key,
  user_id text not null references profiles (user_id) on delete cascade,
  licence_no text not null default '',
  registry text not null default '',
  evidence_note text not null default '',
  status text not null default 'pending' check (status in ('pending', 'verified', 'revoked')),
  decided_by text references profiles (user_id) on delete set null,
  decided_at timestamptz,
  reason text not null default '',
  requested_at timestamptz not null default now()
);

create index if not exists clinician_verifications_status_idx on clinician_verifications (status);
create index if not exists clinician_verifications_user_idx on clinician_verifications (user_id);

