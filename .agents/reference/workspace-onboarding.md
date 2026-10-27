# Workspace onboarding selection

`orgs.onboarding_experience` in production D1 selects the workspace's dashboard
landing experience. `/api/dashboard/me` reads the current organization's value
on every request; the UI refreshes it on a full page reload. It is not stored in
the WorkOS user, session token, or browser storage.

- `NULL`: existing behavior (empty workspaces go to Computer when enabled,
  otherwise project onboarding; workspaces with active or archived automation
  projects see the project list).
- `computer`: `/` and `/getting-started` go to `/computer`, including workspaces
  with projects. Computer setup shows the remaining steps from its actual state.
- `automations`: `/` and `/getting-started` go to `/automations`, including empty
  workspaces.

Explicit `/automations`, `/computer`, project links, and `/new` retain their
behavior. The Computer availability gate still applies; the override grants no
permissions and does not create a VM, delete projects, or reset connections.
No customer-facing preference endpoint can update it. This is a narrow exception
to the general rule against feature flags, approved by Igor on 2026-10-27.

## Operator procedure

After migration `0015_orgs_onboarding_experience.sql` has shipped, first resolve
and verify the intended workspace (one user can belong to multiple):

```sql
SELECT o.id, o.name, o.onboarding_experience, u.email
FROM orgs o
JOIN org_memberships m ON m.org_id = o.id
JOIN users u ON u.id = m.user_id
WHERE lower(u.email) = lower(?);
```

Set the verified workspace's value with bound parameters:

```sql
UPDATE orgs SET onboarding_experience = 'computer' WHERE id = ?;
```

Verify with `SELECT id, name, onboarding_experience FROM orgs WHERE id = ?`.
Set the value back to `NULL` to restore default routing. Obtain any production
SQL approval required by `AGENTS.md` before executing a write. These examples
are an operator procedure, not a record that the statements were executed.
