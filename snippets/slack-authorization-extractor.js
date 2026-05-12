/**
 * Slack Multi-Source Authorization Extractor
 * ==========================================
 *
 * The same Slack interactions endpoint receives events of several
 * shapes. The user identity is in a different field per shape.
 * This node extracts user ID, username, real name, channel, trigger
 * ID, event type, and the implied required permission into a single
 * flat object that downstream nodes consume.
 *
 * Supported event shapes:
 *
 *   1. block_actions (button click, select change)
 *      payload.user.id, payload.user.real_name, payload.actions[0]
 *
 *   2. view_submission (modal submit)
 *      payload.user.id, payload.view.callback_id, payload.view.state
 *
 *   3. event (Events API: app_home_opened, app_mention, etc.)
 *      body.event.user (just an ID string!)
 *
 *   4. slash_command (/cases ...)
 *      body.user_id, body.user_name, body.command
 *
 * Why this is a separate node:
 *   - Adding support for a fifth event shape becomes a one-line
 *     change here instead of touching every downstream node.
 *   - Permission decisions are made once, on a normalized object,
 *     rather than reimplemented per branch.
 *
 * Used in: n8n Code node, immediately after the Slack interactions
 * webhook. Output feeds the role-check / channel-membership node.
 */

const webhookData = $("Slack Webhook Entry").first().json;
const body = webhookData.body || {};
const headers = webhookData.headers || {};

// ── Hard-coded super-admin Slack IDs ─────────────────────────
// Bootstrap-and-recovery shortcut. For larger deployments, move
// this into a config table.
const SUPER_ADMIN_IDS = [
  "U_AAAAAAAAAA",
  "U_BBBBBBBBBB",
  "U_CCCCCCCCCC",
];

// ── Try to detect block_actions / view_submission first ──────
const payload = body.payload ? JSON.parse(body.payload) : null;

let userId = "";
let slackUserName = "";
let slackUserRealName = "";
let eventType = "";
let triggerType = "";
let requiredPermission = "view";
let channelId = "";
let triggerId = "";

if (payload) {
  // block_actions or view_submission
  userId = payload.user?.id || "";
  slackUserName = payload.user?.username || payload.user?.name || "";
  slackUserRealName =
    payload.user?.real_name || payload.user?.profile?.real_name || "";
  eventType = payload.type || "";
  triggerId = payload.trigger_id || "";
  channelId = payload.channel?.id || payload.container?.channel_id || "";

  if (eventType === "view_submission") {
    triggerType = "modal_submit";
    requiredPermission = "create";
  } else if (eventType === "block_actions") {
    triggerType = "button_click";
    const actionId = payload.actions?.[0]?.action_id || "";
    if (actionId.includes("delete")) {
      requiredPermission = "delete";
    } else {
      requiredPermission = "view";
    }
  } else if (eventType === "view_closed") {
    triggerType = "modal_close";
    requiredPermission = "view";
  }
} else if (body.event) {
  // Slack Events API (app_home_opened, app_mention, …)
  // body.event.user is just a string ID, not an object.
  userId = body.event.user || "";
  slackUserName = body.event.username || "";
  slackUserRealName = "";
  eventType = body.event.type || "";
  triggerType = "event";
  requiredPermission = "view";
  channelId = body.event.channel || "";
} else if (body.command) {
  // Slash command
  userId = body.user_id || "";
  slackUserName = body.user_name || "";
  slackUserRealName = "";
  eventType = "slash_command";
  triggerType = "slash_command";
  requiredPermission = "create";
  channelId = body.channel_id || "";
}

// ── Super-admin shortcut ─────────────────────────────────────
if (SUPER_ADMIN_IDS.includes(userId)) {
  return [
    {
      json: {
        authorized: true,
        role: "super_admin",
        authMethod: "hardcoded_admin",
        userId,
        slackUserName: slackUserName || "Unknown",
        slackUserRealName: slackUserRealName || slackUserName || "Unknown User",
        eventType,
        triggerType,
        requiredPermission,
        channelId,
        triggerId,
        payload,
        body,
        headers,
      },
    },
  ];
}

// ── Not super-admin → leave authorization to next node ───────
// Downstream node checks channel membership + role table.
return [
  {
    json: {
      authorized: null, // null = decision deferred
      userId,
      slackUserName: slackUserName || "Unknown",
      slackUserRealName: slackUserRealName || slackUserName || "Unknown User",
      eventType,
      triggerType,
      requiredPermission,
      channelId,
      triggerId,
      payload,
      body,
      headers,
    },
  },
];
