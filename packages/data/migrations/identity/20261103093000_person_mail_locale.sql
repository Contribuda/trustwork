-- QA-002 D5 (integrator defect fix, identity module of BE-002): the language a person last used for their own account
-- actions, so that mail someone else causes for them (a company invitation) can be written in that language.
--
-- The API records the first language of the person's own request (the web's language cookie, else Accept-Language)
-- when they sign in with a password or verify an e-mail address. It is a separate row, not a person column, so a
-- sign-in never changes the person's revision. The person reads and writes only their own row; mail caused by
-- someone else reads the tag through identity_mail_locale, which returns the tag alone and nothing else about the
-- person. The worker still picks the first language the hub serves and falls back to the hub default.

CREATE TABLE trustwork.person_mail_locale (
  person_id uuid PRIMARY KEY REFERENCES trustwork.person (id) ON DELETE CASCADE,
  locale text NOT NULL CHECK (char_length(locale) <= 35 AND locale ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$'),
  source text NOT NULL CHECK (source IN ('sign_in', 'email_verified')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE trustwork.person_mail_locale ENABLE ROW LEVEL SECURITY;
ALTER TABLE trustwork.person_mail_locale FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_all ON trustwork.person_mail_locale AS PERMISSIVE FOR ALL TO trustwork_owner USING (trustwork.maintenance_on()) WITH CHECK (trustwork.maintenance_on());
CREATE POLICY person_mail_locale_self ON trustwork.person_mail_locale FOR ALL TO trustwork_app
  USING (person_id = trustwork.current_person_id()) WITH CHECK (person_id = trustwork.current_person_id());
-- No DELETE: the row goes with the person.
GRANT SELECT, INSERT, UPDATE (locale, source, updated_at) ON trustwork.person_mail_locale TO trustwork_app;

-- The recorded language tag of a person for mail caused by someone else (NULL when none was recorded). Owner-run
-- because the caller is the other party (the inviter); it returns the tag only.
CREATE FUNCTION trustwork.identity_mail_locale(p_person uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = trustwork, pg_temp SET trustwork.maintenance = 'on' AS $$
  SELECT l.locale FROM trustwork.person_mail_locale l WHERE l.person_id = p_person
$$;

GRANT EXECUTE ON FUNCTION trustwork.identity_mail_locale(uuid) TO trustwork_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;
