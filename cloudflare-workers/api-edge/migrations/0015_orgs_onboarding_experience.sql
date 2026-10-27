-- Administrator-managed landing experience. NULL preserves the default routing.
-- This controls onboarding presentation, never permissions or resource lifecycle.
ALTER TABLE orgs ADD COLUMN onboarding_experience TEXT
  CHECK (onboarding_experience IN ('computer', 'automations'));
