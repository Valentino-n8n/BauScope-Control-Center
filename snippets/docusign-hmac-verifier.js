/**
 * DocuSign Connect HMAC Verifier
 * ==============================
 *
 * Verifies that an incoming webhook really came from DocuSign by
 * checking the HMAC SHA256 signature DocuSign attaches to every
 * Connect message.
 *
 * DocuSign signs the raw request body with a shared secret and puts
 * the result in a header named `x-docusign-signature-1` (one of up
 * to four; this implementation accepts only the first).
 *
 * Two pitfalls this snippet handles:
 *
 *   1. The body must be hashed in its raw form, before any JSON
 *      parsing. Re-stringifying parsed JSON often produces a
 *      different byte sequence than what DocuSign signed (key order,
 *      whitespace, escape characters), and the signatures won't
 *      match. n8n's webhook node may surface either the raw body as
 *      a string or the parsed object; we use whichever is present.
 *
 *   2. HTTP headers are case-insensitive but JavaScript object keys
 *      are not. n8n and proxies in front of it may surface the
 *      header in any case. We look up the common variants.
 *
 * Used in: n8n Code node, immediately after the DocuSign Connect
 * webhook trigger and before any further processing.
 *
 * Output: the verified webhook body, plus extracted envelope ID,
 * status, and event type ready for the next node.
 */

const crypto = require("crypto");

// ── Secret ─────────────────────────────────────────────────────
// Never inline the secret. Pull it from n8n credentials or env.
// Examples: $env.DOCUSIGN_HMAC_SECRET
//           $credentials.docusignHmac.secret
const HMAC_SECRET = $env.DOCUSIGN_HMAC_SECRET;
if (!HMAC_SECRET) {
  throw new Error("DOCUSIGN_HMAC_SECRET not configured");
}

// ── Optional opt-out for local testing only. ─────────────────
// MUST be false in production. Logged loudly when true.
const SKIP_VERIFICATION = false;

// ── Extract signature header ─────────────────────────────────
const headers = $json.headers || {};
const signatureHeader =
  headers["x-docusign-signature-1"] ||
  headers["X-DocuSign-Signature-1"] ||
  headers["X-DOCUSIGN-SIGNATURE-1"] ||
  $json["x-docusign-signature-1"];

// ── Verify ───────────────────────────────────────────────────
if (SKIP_VERIFICATION) {
  console.warn("⚠️  HMAC verification SKIPPED — for testing only");
} else {
  if (!signatureHeader) {
    throw new Error(
      "Missing DocuSign HMAC signature header. " +
        "Available headers: " +
        Object.keys(headers).join(", "),
    );
  }

  // Use the raw body bytes. If the framework already parsed JSON,
  // fall back to a re-stringified version — but be aware that key
  // ordering / whitespace differences may cause false negatives.
  const rawBody =
    typeof $json.body === "string"
      ? $json.body
      : $json.rawBody || JSON.stringify($json.body || {});

  const computed = crypto
    .createHmac("sha256", HMAC_SECRET)
    .update(rawBody)
    .digest("base64");

  if (computed !== signatureHeader) {
    // Don't log the computed signature in production — gives an
    // attacker a confirmation oracle.
    throw new Error("Invalid HMAC signature from DocuSign");
  }
}

// ── Parse the verified body ──────────────────────────────────
const body =
  typeof $json.body === "string" ? JSON.parse($json.body) : $json.body || {};

// ── Extract event details (Connect v2.1 shape) ───────────────
const eventType = body.event || ""; // 'envelope-completed', 'recipient-completed', etc.
const apiVersion = body.apiVersion || "";
const envelopeId = body.data?.envelopeId || null;
const envelopeStatus = body.data?.envelopeSummary?.status || "";
const completedDateTime =
  body.data?.envelopeSummary?.completedDateTime || null;

if (!envelopeId) {
  throw new Error("Verified webhook has no envelopeId — unexpected shape");
}

return [
  {
    json: {
      verified: true,
      eventType,
      apiVersion,
      envelopeId,
      envelopeStatus,
      completedDateTime,
      raw: body,
    },
  },
];
