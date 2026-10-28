-- slack_connect_invites (serverless-agents-ws 089): one Slack Connect invite per
-- signup, sent by the edge cron (src/slack_connect.ts). A row is the claim that
-- this user is handled: the cron never invites a user who has one. Work-email
-- signups from the same domain share one channel; free-email signups get their own.
CREATE TABLE IF NOT EXISTS slack_connect_invites (
  user_id      TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  channel_id   TEXT,              -- set once the channel exists
  status       TEXT NOT NULL,     -- pending | invited | skipped | failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  invite_id    TEXT,              -- Slack's invite id
  created_at   INTEGER NOT NULL,
  invited_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_slack_connect_invites_channel_name ON slack_connect_invites(channel_name);
