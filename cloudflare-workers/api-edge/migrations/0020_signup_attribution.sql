-- signup_attribution (serverless-agents-ws 087): where each signup came from.
-- One row per user created by a login, written by the edge at signup from the
-- `oc_ft` first-touch cookie (src/signup_attribution.ts). `channel` is
-- signupChannel() of the stored fields; a signup without the cookie (CLI, or
-- cookies blocked) is `unknown`, as is every user from before this table.
-- No personal data: campaign parameters, click ids, the external referrer's
-- origin and path, the landing path.
CREATE TABLE IF NOT EXISTS signup_attribution (
  user_id       TEXT PRIMARY KEY,
  utm_source    TEXT,
  utm_medium    TEXT,
  utm_campaign  TEXT,
  utm_term      TEXT,
  utm_content   TEXT,
  gclid         TEXT,
  fbclid        TEXT,
  li_fat_id     TEXT,
  ref           TEXT,
  referrer      TEXT,
  landing_path  TEXT,
  first_seen_at INTEGER,          -- unix seconds the cookie was set
  channel       TEXT NOT NULL,    -- google_ads | other_paid | organic_search | social | referral | direct | unknown
  client        TEXT NOT NULL,    -- web | cli
  auth_method   TEXT,             -- WorkOS authentication_method
  plan_intent   TEXT,             -- pro | max from the pricing CTA
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signup_attribution_created_at ON signup_attribution(created_at);
