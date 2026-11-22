-- Idempotency keys of emails sent over SMTP (EMAIL_DRIVER=smtp).
--
-- Resend refuses a second send with the same idempotency key for 24 hours.
-- SMTP has no such thing, so the SMTP driver records each key here:
--
-- * 'sending' while the message is being handed to the SMTP server. A retry
--   that finds a key still 'sending' after a few minutes takes it over and
--   sends: the earlier attempt was interrupted (the app stopped, for
--   example), and losing the message would be worse than a rare duplicate.
--   A retry while the first attempt may still be running fails, so the
--   caller tries again later instead of counting the message as sent.
-- * 'sent' once the server accepted it. A retry then is not sent again (an
--   expiry notice whose follow-up database write failed, for example).
--
-- A send that fails removes its key. Rows older than 24 hours are removed as
-- new keys are claimed, matching Resend.
CREATE TABLE IF NOT EXISTS email_idempotency_keys (
  key text PRIMARY KEY,
  state text NOT NULL DEFAULT 'sending' CHECK (state IN ('sending', 'sent')),
  claimed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_idempotency_keys_claimed_at_idx
  ON email_idempotency_keys (claimed_at);
