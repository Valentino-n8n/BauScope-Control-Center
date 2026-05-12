# Multi-Source Authorization Pattern

A Slack interactions endpoint receives events of several different
shapes. The same logical question — *who is the user making this
request?* — is answered in a different field of the payload
depending on what kind of event it is. Worse, some Slack event
types nest the user under different paths even within the same
top-level type.

This pattern is the small layer that sits in front of every
authorization decision: extract the user identity from whichever
shape this event has, then make one consistent permission decision
on the resulting normalized object.

## The four event shapes this platform handles

```js
// 1. Block actions (button clicks, select changes)
{
  type: "block_actions",
  user: { id: "U…", username: "valentino", real_name: "Valentino V." },
  actions: [{ action_id: "view_users", value: "..." }],
  trigger_id: "...",
  channel: { id: "C…" }, // sometimes; not for App Home
}

// 2. View submissions (modal submits)
{
  type: "view_submission",
  user: { id: "U…", username: "valentino", real_name: "Valentino V." },
  view: {
    callback_id: "create_user_submit",
    state: { values: { ... } },
    private_metadata: "...",
  },
}

// 3. Slack Events API (app_home_opened, app_mention, etc.)
{
  event: {
    type: "app_home_opened",
    user: "U…",   // just an ID string, not an object!
    channel: "D…",
  },
}

// 4. Slash commands
{
  command: "/cases",
  user_id: "U…",
  user_name: "valentino",
  channel_id: "C…",
}
```

The user ID is in:

- `payload.user.id` for `block_actions` and `view_submission`
- `body.event.user` for events
- `body.user_id` for slash commands

If a workflow handles all four (this one does), every authorization
check has to know which path to take. Doing this inline in every
permission check means the check has to be reimplemented every
time, with the same off-by-one risk every time.

---

## The pattern: extract once, decide once

A single Code node early in the interaction workflow:

1. Inspects the payload to identify which shape it is.
2. Extracts user ID, username, real name, channel, trigger ID,
   event type, required permission level into a flat object.
3. Returns that object.

Every downstream node — the role check, the channel-membership
check, the action dispatcher — reads from this normalized object
instead of poking at the original payload. Adding support for a
fifth event shape (`view_closed`, `message_action`, etc.) means
adding one branch to this single extractor; nothing else changes.

The full implementation is in
[`../snippets/slack-authorization-extractor.js`](../snippets/slack-authorization-extractor.js).

---

## Mapping events to permissions

Different event types implicitly require different permissions:

| Event | Required permission |
|---|---|
| `block_actions` (button click) | usually `view`; `delete` if the action_id contains "delete" |
| `view_submission` (modal submit) | `create` (the user is creating or modifying state) |
| `view_closed` | `view` (just dismissing a modal) |
| `app_home_opened` | `view` |
| Slash command | `create` (commands trigger work) |

The extractor sets `requiredPermission` to one of these defaults
based on event shape. The downstream role check then says: *does
this user's role have `create` permission?*

This default mapping is conservative — it errs toward asking for
more permission than less. A better-than-default would override on
a per-action basis (e.g. `block_actions` with `action_id ==
view_users` should require `admin` permission specifically). The
pattern supports that: pass an action-id-to-permission map into
the extractor and consult it after the default is set.

---

## Hard-coded super-admins

A small but important shortcut: if the user's Slack ID is in a
hard-coded `SUPER_ADMIN.users` list, skip every other check and
authorize. Two reasons:

- **Bootstrap.** The first user on the system has to authorize
  themselves to add other users. A hard-coded super-admin breaks
  the chicken-and-egg.
- **Recovery.** If the users table gets corrupted, the super-admin
  list still works. The system stays administrable.

The trade-off: hard-coded user IDs are operational state that
lives in the workflow definition rather than in data. Changing the
super-admin list requires editing and redeploying the workflow.
For a single-team internal tool that's fine; for a larger system
move it to a config table.

---

## Channel-membership fallback

For non-super-admin users, the platform requires the user to be a
member of a specific Slack channel before allowing the action.
This is a coarse "is this person on the team" check that
complements the role-based permission check.

Why both? They answer different questions:

- **Channel check:** is this person on the team at all?
- **Role check:** within the team, what level of access do they have?

Channel check failure → user gets "you don't have access" — they're
probably a former team member or someone testing the bot from a
different workspace.

Role check failure → user gets "your role doesn't permit this
action" — they're on the team but trying something above their
level (e.g. a technician trying to delete a user).

Two distinct failure messages, two distinct causes, easier to
diagnose than a single generic "denied".

---

## Failure modes

| Failure | Cause | Mitigation |
|---|---|---|
| Extractor returns empty `userId` | Payload format we haven't seen before | Log the unrecognized shape; add a branch for it; until then, fail closed |
| User found in users table but `role` column is empty or unrecognized | Manual editing of the users table | Treat as no permission. Log with enough detail for an admin to fix the row. |
| Hard-coded super-admin list still has a former team member | Operational drift | Audit the super-admin list quarterly; add a "last verified" date next to each entry in a comment |
| Channel ID hard-coded; team moves to a new channel | Coordination failure | Surface the channel ID in a config block in the workflow's first node; one place to update |
