-- slack_alerts (serverless-agents-ws 090): one row per customer alert posted to
-- our own Slack (#signups), so webhook retries, concurrent projections and cron
-- re-runs post each one once. The INSERT OR IGNORE that writes the row is the
-- claim; a failed post deletes it so a later run can try again. `key` tells
-- repeatable events apart (an invitation id, a plan move and its day); events
-- that happen once per org use ''.
CREATE TABLE IF NOT EXISTS slack_alerts (
  org_id  TEXT NOT NULL,
  event   TEXT NOT NULL,
  key     TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, event, key)
);
