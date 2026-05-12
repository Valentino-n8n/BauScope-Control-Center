/**
 * Role-Based Slack App Home Tab Builder
 * =====================================
 *
 * Builds a per-user, per-role Slack App Home block list.
 *
 *   1. Looks up the requesting user in an Excel users table.
 *   2. If the user isn't found or is inactive, renders an
 *      access-denied / deactivated home tab.
 *   3. Otherwise, branches on the user's role and renders a block
 *      list with the actions appropriate to that role:
 *         - super_admin: all features + admin section
 *         - admin: all user-level features, no admin section
 *         - techniker (technician): scan-related actions only
 *
 * The Slack API: views.publish takes a user_id and a view object,
 * and updates that one user's home tab.
 *
 * Used in: n8n Code node, after a Microsoft Graph node has fetched
 * the users table and the App Home Opened event has been received.
 *
 * Outputs the body for a subsequent HTTP Request node configured to
 * POST to https://slack.com/api/views.publish
 */

// ── Inputs ──────────────────────────────────────────────────
const event = $("App Home Webhook").item.json;
const usersTable = $("Get Users Table").item.json.value || [];
const currentUserId = event.body.event?.user || event.body.user_id;

// ── Find the user in the users table ────────────────────────
// Adjust column indexes to match your users sheet.
// In this layout: 0=id, 1=name, 2=email, 3=slack_id, 4=handle,
//                 6=role, 7=active
let currentUser = null;
for (const row of usersTable) {
  const v = row.values[0];
  if (v[3] === currentUserId) {
    currentUser = {
      id: v[0],
      name: v[1],
      email: v[2],
      slack_id: v[3],
      slack_handle: v[4],
      role: v[6],
      active: v[7],
    };
    break;
  }
}

// ── Not found → render access-denied home tab ────────────────
if (!currentUser) {
  return [
    {
      json: buildResponse(currentUserId, [
        section(
          "*❌ Access denied*\n\nYour account was not found.\nContact an administrator.",
        ),
      ]),
    },
  ];
}

// ── Inactive → render deactivated home tab ───────────────────
if (currentUser.active !== "Yes") {
  return [
    {
      json: buildResponse(currentUserId, [
        section(
          "*🔴 Account deactivated*\n\nYour account is currently deactivated.\nContact an administrator.",
        ),
      ]),
    },
  ];
}

// ── Build the role-specific block list ───────────────────────
const isSuperAdmin = currentUser.role === "super_admin";
const isAdmin = currentUser.role === "admin";
const isTechniker = currentUser.role === "techniker";

const roleNames = {
  super_admin: "Super Administrator",
  admin: "Administrator",
  techniker: "Techniker",
};
const roleIcons = { super_admin: "👑", admin: "👔", techniker: "🔧" };

// Berlin time for greeting — adjust to your timezone
const berlinTime = new Date(
  new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }),
);
const hour = berlinTime.getHours();
const greeting =
  hour < 12 ? "Guten Morgen" : hour < 18 ? "Guten Tag" : "Guten Abend";
const time = berlinTime.toLocaleTimeString("de-DE", {
  hour: "2-digit",
  minute: "2-digit",
});
const date = berlinTime.toLocaleDateString("de-DE", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const blocks = [];

// Header & user info — same for everyone
blocks.push({
  type: "header",
  text: { type: "plain_text", text: `${greeting}, ${currentUser.name}` },
});

blocks.push(
  section(
    `${roleIcons[currentUser.role]} *${roleNames[currentUser.role]}*\n` +
      `📧 ${currentUser.email}\n🆔 ${currentUser.slack_handle}`,
  ),
);

blocks.push({
  type: "context",
  elements: [{ type: "mrkdwn", text: `📅 ${date} • 🕐 ${time}` }],
});

blocks.push({ type: "divider" });

// Branding
blocks.push(
  section(
    "📷 *Internal Operations Hub*\n_Internal team tool — restricted access_",
  ),
);

blocks.push({ type: "divider" });

// Quick actions — present for everyone
blocks.push(section("⚡ *Quick actions*"));
blocks.push({
  type: "actions",
  elements: [
    button("📝 New case", "create_case", "primary"),
    button("🔍 Search", "search_open"),
    button("📁 My cases", "my_cases"),
  ],
});

// Admin-and-above actions
if (isSuperAdmin || isAdmin) {
  blocks.push({
    type: "actions",
    elements: [button("📊 Reports", "reports_open"), button("❓ Help", "help_open")],
  });
}

// Super-admin-only section
if (isSuperAdmin) {
  blocks.push({ type: "divider" });
  blocks.push(section("*🔒 Administration*"));
  blocks.push({
    type: "actions",
    elements: [
      button("👥 Users", "view_users"),
      button("⚙️ Settings", "system_settings"),
      button("🔐 Compliance", "compliance_center"),
    ],
  });
}

// Footer
blocks.push({ type: "divider" });
blocks.push({
  type: "context",
  elements: [
    { type: "mrkdwn", text: "🚀 *Operations Hub* v2.5" },
    { type: "mrkdwn", text: "🟢 All systems operational" },
    { type: "mrkdwn", text: `🔄 Sync: ${time}` },
  ],
});

return [{ json: buildResponse(currentUserId, blocks) }];

// ── Helpers ──────────────────────────────────────────────────
function buildResponse(userId, blocks) {
  return { user_id: userId, view: { type: "home", blocks } };
}

function section(text) {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function button(text, action_id, style) {
  const el = {
    type: "button",
    text: { type: "plain_text", text, emoji: true },
    action_id,
  };
  if (style) el.style = style;
  return el;
}
