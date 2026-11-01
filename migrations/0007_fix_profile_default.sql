-- 0007: Correct the default role for profiles from 'clinician' to 'patient'.
-- The application has always inserted with role = 'patient' explicitly, but the
-- column default was 'clinician', which is an unsafe fallback.
alter table profiles alter column role set default 'patient';
