-- 0004: store the year of the first period (menarche) on the patient record.
--
-- Why: the 2023 international PCOS guideline defines irregular cycles, and when
-- ovarian ultrasound may be used, by time since the first period. Until now the
-- app only had year of birth and used its own age-20 line instead.
--
-- Data minimisation: a YEAR only, never a full date. The app treats the result as
-- uncertain by up to one year either way (see src/lib/clinic/pcos-context.ts).
--
-- Nullable on purpose: unknown stays unknown. Nothing is back-filled or guessed.
-- Changes are written through setMenarcheYear, which records the previous value in
-- audit_events (append-only since 0003), so an earlier value is never silently lost.

alter table patients add column if not exists menarche_year integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'patients_menarche_year_range'
  ) then
    alter table patients
      add constraint patients_menarche_year_range
      check (menarche_year is null or menarche_year between 1900 and 2200);
  end if;
end $$;
