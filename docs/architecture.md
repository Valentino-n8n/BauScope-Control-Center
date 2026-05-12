# System Architecture

The platform is split into three n8n workflows over a shared
Microsoft 365 state layer:

1. **Home Tab workflow** — handles the Slack `app_home_opened` event.
   Reads the users table, finds the requesting user, builds a
   role-specific block list, publishes via `views.publish`.
2. **Interaction workflow** — receives Slack interactions (button
   clicks, modal submissions). Runs the authorization layer first,
   then routes by `action_id` or `callback_id` into the matching
   branch (new Einwilligung, user CRUD, search, reports, details).
3. **DocuSign Connect workflow** — receives DocuSign webhook events.
   Verifies the HMAC SHA256 signature, parses the envelope ID, finds
   the matching Excel row, downloads the signed PDF, uploads to
   SharePoint, updates the case status, notifies Slack.

Three workflows because the trigger types are completely different
(one Slack events stream, one Slack interactions URL, one DocuSign
Connect URL) and the latency requirements differ. Splitting them
keeps each one focused and lets one slow path not block the others.

## Why this isn't one mega-workflow

n8n lets you cram any number of triggers into a single workflow. For
this platform, that would mean one canvas with the home-tab logic,
the interaction router, and the DocuSign processor all tangled
together. A few reasons we don't:

- **Different SLA per trigger type.** When a user opens the Home
  tab, they want to see their dashboard within ~500ms. When DocuSign
  fires a completion event, latency doesn't matter as long as we
  acknowledge the webhook quickly. Mixing them risks one slow path
  affecting the other's perceived responsiveness.
- **Different deploy cadence.** The interaction workflow grows fast
  (new actions, new modals); the Home Tab workflow is mostly stable;
  the DocuSign workflow rarely changes. Splitting lets each evolve at
  its own rate without retesting unrelated parts.
- **Easier failure isolation.** A bug in the user-CRUD branch can't
  brick the Home Tab. A change to HMAC verification can't break Slack
  interactions.

## Why three and not five

The interaction workflow itself has 40 Code nodes covering many
action types. We could split it further: one workflow per action.
We don't, for the reason documented in
[`Valentino-n8n/Reklamation`](https://github.com/Valentino-n8n/Reklamation):
the pre-routing prefix (parse Slack payload → check user → detect
trigger type) is shared by every action, and duplicating it per
workflow is worse than keeping one large workflow with clear node
naming.

The escape hatch for the next size jump is `executeWorkflow`: keep
the parser and dispatcher in the router, move each action's logic
into its own called workflow.

---

## Workflow 1 — Home Tab

### Trigger

Slack fires `app_home_opened` whenever a user opens the bot's home
tab. The event payload contains the requesting user's Slack ID.

### Steps

1. Extract user ID from the event.
2. Read the users table from the Excel workbook (Microsoft Graph).
3. Find the row where `slack_id` matches.
4. Branch on user state:
   - **Not found** → render an "access denied, contact admin" block.
   - **Inactive** → render an "account deactivated" block.
   - **Active** → branch on role and render role-appropriate blocks.
5. `views.publish` to update the home tab.

### Block content per role

- **Super admin** sees everything: dashboard, all quick actions,
  user management entry point, compliance center, system settings.
- **Admin** sees the dashboard and most quick actions, but no user
  management.
- **Technician** (Techniker) sees only scan-related actions.

The role-checking pattern is documented in
[`role-based-app-home-pattern.md`](./role-based-app-home-pattern.md).

---

## Workflow 2 — Interaction router

### Trigger

A single Slack interactions URL receives all interactive events:
button clicks, modal submissions, view-closed events, slash commands.
The `payload` field arrives URL-encoded as JSON.

### Authorization layer

Before any action runs, an authorization node:

1. Parses the payload and extracts the user identity from one of
   four shapes (`block_actions`, `view_submission`, `event`,
   `slash_command`). The same user ID lives in different paths
   depending on the event type.
2. Determines the required permission for this action (`view`,
   `create`, `delete`).
3. Short-circuits with `authorized: true` for hard-coded
   super-admins; otherwise checks channel membership.
4. If unauthorized, posts a polite "no access" response and stops.

The four-source extraction pattern is in
[`multi-source-authorization.md`](./multi-source-authorization.md).

### Action dispatch

After authorization, a chain of switches routes by event type +
callback ID + action ID:

- `view_submission` + `einwilligung_submit` → create new case
- `view_submission` + `create_user_submit` → create new user row
- `view_submission` + `delete_user_submit` → deactivate user
- `block_actions` + `action_id starts with create_` → open create
  modal (new Einwilligung, new user, etc.)
- `block_actions` + `action_id` `view_users` → open users-list modal
- `block_actions` + `action_id` `case_details_*` → open case-details
  modal
- ... and so on for ~10 more branches

Each branch reads from or writes to the Excel state, builds a Slack
response, and acknowledges the webhook within Slack's 3-second window.

---

## Workflow 3 — DocuSign Connect

### Trigger

A webhook URL configured in DocuSign Connect. DocuSign calls it on
envelope status changes. The events that matter for this platform
are `envelope-completed` and `recipient-completed`.

### Steps

1. Extract the HMAC signature header
   (`x-docusign-signature-1`, with case-insensitive lookups).
2. Compute HMAC SHA256 of the raw request body using the shared
   secret. Compare to the header value. If mismatched, abort.
3. Parse the JSON body (DocuSign Connect v2.1 format) to extract
   `envelopeId`, `status`, `completedDateTime`.
4. Read the Excel cases table.
5. Find the row whose `docusignEnvelopeId` column matches.
6. Download the signed PDF from DocuSign.
7. Upload to SharePoint at a deterministic path derived from the
   case data (e.g. `BauScope/Einwilligungen/<year>/<serial>.pdf`).
8. PATCH the Excel row to set `docusignCompletedDate`,
   `fmptsStatus = 'completed'`.
9. Post a Slack DM to the case creator: "✅ Signed. Scan can start."

The HMAC pattern is documented in
[`docusign-hmac-verification.md`](./docusign-hmac-verification.md).

---

## Shared state — Excel

### Cases table

Each row is one case. Columns (in order):

```
0   entryId               (auto-incrementing integer)
1   fmptsNumber           (e.g. "FS-0161" — display string)
2   fmptsItemId           (SharePoint list item ID — source of truth)
3   createdDate           (Excel serial date)
4   createdBy             (Slack handle of creator)
5   objektStrasse         (object street)
6   objektOrt             (object city)
7   objektAdresse         (concatenated full address)
8   kundenname            (customer name)
9   kundenEmail           (customer email — for DocuSign delivery)
10  kundenTelefon         (customer phone)
11  interneNotiz          (internal note from creator)
12  docusignSentDate      (when envelope was sent)
13  docusignCompletedDate (when envelope was signed)
14  docusignEnvelopeId    (DocuSign GUID — primary key for webhook lookup)
15  fmptsStatus           ('pending' | 'sent' | 'completed' | 'cancelled')
```

Hardcoded indexes (`row.values[0][14]` etc.) are fragile when columns
get added or reordered. The
[Excel column mapper pattern](./excel-column-mapper-pattern.md) gives
a name-based access layer over the raw indexes.

### Users table

Each row is one user. Columns: index, name, email, slack_id,
slack_handle, (reserved), role, active, created_date, created_by,
(reserved), (reserved), description, scan_count, einwilligung_count,
permission_score.

The role column is the platform's primary access-control axis.

### Serial generation

The next serial is derived as `max(existing IDs) + 1`, padded to four
digits, prefixed with `FS-`. The number is computed in n8n at modal-
open time (so the user sees their next serial in the modal) but
*committed* to a SharePoint list on form submission, which acts as
the durable source of truth.

This means: if two users open the same modal at the exact same
moment, both see the same number; whichever submits first commits;
the second submission gets a duplicate-key error from SharePoint and
needs to retry. For the team's volume (single-digit cases per day)
this hasn't happened. For higher concurrency, replace with a server-
side increment that returns the new ID atomically (e.g. SharePoint
list's auto-numbering with a `POST` that returns the assigned ID).

---

## SharePoint — signed PDFs

Signed Einwilligung PDFs are stored at a deterministic path:

```
BauScope/Einwilligungen/<year>/<serial>.pdf
```

Path is built from the case data, not from DocuSign's response —
so the path is predictable from the case ID alone. Useful for later
auditing without having to query DocuSign for every envelope.

---

## Where to look next

- **Role-based App Home rendering** → [`role-based-app-home-pattern.md`](./role-based-app-home-pattern.md)
- **DocuSign Connect HMAC** → [`docusign-hmac-verification.md`](./docusign-hmac-verification.md)
- **Type-safe Excel access** → [`excel-column-mapper-pattern.md`](./excel-column-mapper-pattern.md)
- **Multi-source Slack auth** → [`multi-source-authorization.md`](./multi-source-authorization.md)
- **Code snippets** → [`../snippets/README.md`](../snippets/README.md)
