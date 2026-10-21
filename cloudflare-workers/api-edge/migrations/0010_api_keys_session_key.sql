-- api_keys.session_key — the computer session a one-hour computer key was
-- minted for (serverless-agents-ws work 080). Set only on keys created by
-- /internal/computer-keys (created_by = 'computer'); NULL for every other key.
-- Forwarded to managed agents as the assertion's session_key claim, so grants
-- made to one thread resolve for that thread's keys only.
ALTER TABLE api_keys ADD COLUMN session_key TEXT;
