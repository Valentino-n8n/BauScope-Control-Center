# Role-Based App Home Pattern

The Slack App Home tab is the bot's "home page" — a one-on-one
private space between the app and a single user. Calling
`views.publish` with the user's ID updates that user's view; other
users don't see the change. This makes App Home a natural place to
render a per-user, per-role dashboard.

## What this pattern adds beyond a basic Home Tab

A basic Home Tab renders the same content for every user. This
pattern renders **different content per user** based on a row in an
Excel-backed users table, with three role tiers:

- **`super_admin`** — sees all features, including user management
  and compliance center
- **`admin`** — sees most features but no user management
- **`techniker`** — sees only scan-related actions

The role check is performed on every Home Tab render, not cached.
Any change to a user's role (or to their `active` status) is visible
the next time they re-open the home tab.

## What this pattern is NOT

- **Not a real RBAC system.** Three hard-coded roles, three branches
  in the renderer. There's no permission inheritance, no group-based
  access, no audit trail of permission grants.
- **Not real-time.** If an admin changes a user's role, the user has
  to close and reopen the home tab to see the new view. There's no
  push notification.
- **Not a substitute for server-side checks.** The role-based UI
  hides actions, but the *backend* (interaction workflow) re-checks
  the user's role before executing any action. Hiding a button isn't
  security; the server-side recheck is.

---

## Trigger and data flow

```
1. User opens the bot's Home tab in Slack
       ▼
2. Slack fires app_home_opened with the user's Slack ID
       ▼
3. n8n: read the Excel users table via Microsoft Graph
       ▼
4. n8n: find the row where slack_id == event.user
       ▼
5. Branch on user state:
     - not found     → access-denied block
     - active = "No" → account-deactivated block
     - role-based    → role-specific blocks
       ▼
6. Call Slack views.publish with the user-scoped block list
```

Step 3 is the hottest read in the platform. Optimization: the users
table is small (single-digit rows), so the cost is one Microsoft
Graph call per home-tab open. For larger user populations, cache the
users table (e.g. an n8n static-data Memory node refreshed every 5
minutes).

---

## Role check

The cleanest implementation reads the user's row, then sets three
booleans:

```js
const isSuperAdmin = currentUser.role === "super_admin";
const isAdmin       = currentUser.role === "admin";
const isTechniker  = currentUser.role === "techniker";
```

Then builds the block list conditionally:

```js
const blocks = [];

// Header & user info — same for everyone
blocks.push(/* greeting */, /* role badge */, /* divider */);

// Branding — same for everyone
blocks.push(/* product name + tagline */);

// Quick actions — present in all three roles
blocks.push({
  type: "actions",
  elements: [
    button("New Einwilligung", "create_einwilligung"),
    button("Search", "search_open"),
    button("My cases", "my_cases"),
  ],
});

// Admin-only actions
if (isSuperAdmin || isAdmin) {
  blocks.push({
    type: "actions",
    elements: [
      button("Reports", "reports_open"),
      button("Help", "help_open"),
    ],
  });
}

// Super-admin-only actions
if (isSuperAdmin) {
  blocks.push(
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: "*🔒 Administration*" },
    },
    {
      type: "actions",
      elements: [
        button("👥 Users", "view_users"),
        button("⚙️ Settings", "system_settings"),
        button("🔐 Compliance", "compliance_center"),
      ],
    },
  );
}

// Footer — same for everyone
blocks.push(/* version + sync time */);
```

The full implementation is in
[`../snippets/role-based-home-tab.js`](../snippets/role-based-home-tab.js).

---

## Server-side rechecks

Hiding a button doesn't prevent a determined user from constructing
the underlying interaction payload manually and sending it to the
Slack interactions URL. Slack will dutifully forward it to your
webhook. So:

- The interaction workflow's authorization layer runs *before* any
  branch executes
- It re-reads the user's role from the same users table
- It rejects the action if the user's role doesn't have permission

This means the role-based Home Tab is a **convenience layer** for
the user's eyes, not the security boundary. The security boundary
is the server-side recheck.

The auth-layer pattern is documented in
[`multi-source-authorization.md`](./multi-source-authorization.md).

---

## Failure modes

| Failure | What you see | Mitigation |
|---|---|---|
| User row missing from Excel | "Access denied — contact admin" home tab | Expected; user really isn't onboarded |
| User row has `active = "No"` | "Account deactivated" home tab | Expected; deactivation flow does this |
| Microsoft Graph 401 | Empty or stale home tab | Refresh the OAuth token; n8n's OAuth credentials handle this if configured |
| Microsoft Graph rate limit (429) | Empty home tab; user re-opens and it works | Acceptable for low traffic; for higher, cache the users table |
| Block Kit JSON exceeds 100 blocks | `views.publish` returns `invalid_blocks` | Slack hard limit. Trim sections or paginate. |
| `slack_id` column has a typo | User sees "access denied" despite being onboarded | Add admin tooling to surface mismatches; common cause is copy-paste of Slack ID with leading/trailing whitespace |

---

## Time and locale

The Home Tab renders a greeting based on time of day. The platform
operates in `Europe/Berlin`, so the renderer explicitly converts
the current UTC time to Berlin time before deciding "Guten Morgen /
Tag / Abend". Skipping this conversion gives a wrong greeting
during n8n's UTC nights for any deployment outside the
Europe/Berlin timezone.

```js
const berlinTime = new Date(
  new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }),
);
const hour = berlinTime.getHours();
const greeting =
  hour < 12 ? "Guten Morgen" : hour < 18 ? "Guten Tag" : "Guten Abend";
```

This is the kind of detail that's easy to skip and hard to debug
later when users report "the bot says good morning at 11 PM".
