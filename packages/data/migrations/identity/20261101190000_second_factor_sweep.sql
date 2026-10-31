-- BE-004 follow-up: the bounded-table sweeper (trustwork.sweep_expired, run by the worker) deletes sessions 90 days
-- after they were revoked or expired, and deletes never-verified sign-ups after seven days. The BE-004 tables referenced
-- `session` and `person` without a referential action, so the first swept session with an elevation (or a purged
-- sign-up that a factor, challenge or support reset pointed at) would abort the whole sweep with a foreign-key error.
--
-- Rows that exist only for their session or their person now go with it:
--   - session_elevation -> session and person: an elevation is meaningless without its session;
--   - second_factor, recovery_code, second_factor_challenge -> person: credentials of the person, like `credential`
--     rows the sweeper already deletes for a purged sign-up;
--   - second_factor_reset.subject_person_id -> person: a reset of a person who no longer exists.
-- The staff references of a reset (requested_by, approved_by, cancelled_by, executed_by) keep NO ACTION: staff accounts
-- are verified and never swept, and the reset record must not lose its actors. The audit trail is unaffected (audit
-- rows carry ids, not foreign keys). The applied migration 20261101150000_second_factor.sql is not edited.
-- The timestamp sorts after DATA-002's admin/20261101180200 so either can merge first.

ALTER TABLE trustwork.session_elevation
  DROP CONSTRAINT session_elevation_session_id_fkey,
  ADD CONSTRAINT session_elevation_session_id_fkey FOREIGN KEY (session_id) REFERENCES trustwork.session (id) ON DELETE CASCADE,
  DROP CONSTRAINT session_elevation_person_id_fkey,
  ADD CONSTRAINT session_elevation_person_id_fkey FOREIGN KEY (person_id) REFERENCES trustwork.person (id) ON DELETE CASCADE;

ALTER TABLE trustwork.second_factor
  DROP CONSTRAINT second_factor_person_id_fkey,
  ADD CONSTRAINT second_factor_person_id_fkey FOREIGN KEY (person_id) REFERENCES trustwork.person (id) ON DELETE CASCADE;

ALTER TABLE trustwork.recovery_code
  DROP CONSTRAINT recovery_code_person_id_fkey,
  ADD CONSTRAINT recovery_code_person_id_fkey FOREIGN KEY (person_id) REFERENCES trustwork.person (id) ON DELETE CASCADE;

ALTER TABLE trustwork.second_factor_challenge
  DROP CONSTRAINT second_factor_challenge_person_id_fkey,
  ADD CONSTRAINT second_factor_challenge_person_id_fkey FOREIGN KEY (person_id) REFERENCES trustwork.person (id) ON DELETE CASCADE;

ALTER TABLE trustwork.second_factor_reset
  DROP CONSTRAINT second_factor_reset_subject_person_id_fkey,
  ADD CONSTRAINT second_factor_reset_subject_person_id_fkey FOREIGN KEY (subject_person_id) REFERENCES trustwork.person (id) ON DELETE CASCADE;
