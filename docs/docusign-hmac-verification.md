# DocuSign Connect Webhook with HMAC Verification

DocuSign Connect is DocuSign's webhook system: configure a URL,
DocuSign POSTs to it on envelope events. To prove that a webhook
really came from DocuSign (and not from a random attacker), DocuSign
signs every request with HMAC. Your endpoint verifies the signature
before doing any work.

## Why this matters

The DocuSign workflow updates production data: marks cases as
completed, downloads signed PDFs, posts Slack notifications. If an
attacker can fake a webhook, they can mark cases as completed
without the customer actually signing. HMAC verification is the
control that prevents that.

DocuSign's own documentation calls HMAC validation the recommended
mechanism for Connect message authenticity. Skipping it in
production is a vulnerability with real teeth.

---

## How HMAC verification works

DocuSign computes:

```
signature = HMAC_SHA256(secret, raw_request_body)
```

…and sends it in a header named `x-docusign-signature-1` (DocuSign
supports up to four secrets, with `-1` through `-4`; we use one).
Your endpoint:

1. Reads the raw request body — **before any JSON parsing** — and
   the signature header.
2. Computes its own HMAC SHA256 of the body using the shared secret.
3. Compares the computed value to the header.
4. Proceeds only on match.

Two pitfalls catch most implementations:

**Pitfall 1: parsing the body before hashing.** If your framework
auto-parses JSON and you then hash the parsed-and-restringified
body, the byte sequence may not match what DocuSign signed (key
ordering, whitespace, escaped characters). Always hash the raw
bytes as received.

**Pitfall 2: header case sensitivity.** HTTP headers are
case-insensitive per spec, but JavaScript object lookups are case-
sensitive. n8n's webhook node may surface headers as
`x-docusign-signature-1`, `X-DocuSign-Signature-1`, or all-uppercase,
depending on configuration. Look up all variants.

---

## Implementation in n8n

The Code node that does the verification:

```js
const crypto = require("crypto");
const HMAC_SECRET = $env.DOCUSIGN_HMAC_SECRET; // never inline the secret

const headers = $json.headers || {};
const signature =
  headers["x-docusign-signature-1"] ||
  headers["X-DocuSign-Signature-1"] ||
  headers["X-DOCUSIGN-SIGNATURE-1"];

if (!signature) {
  throw new Error("Missing DocuSign signature header");
}

// Use the raw request body, not a re-stringified version
const rawBody =
  typeof $json.body === "string"
    ? $json.body
    : $json.rawBody || JSON.stringify($json.body);

const computed = crypto
  .createHmac("sha256", HMAC_SECRET)
  .update(rawBody)
  .digest("base64");

if (computed !== signature) {
  throw new Error("Invalid HMAC signature from DocuSign");
}
```

The full snippet, with debug logging and an opt-out flag for
testing, is in
[`../snippets/docusign-hmac-verifier.js`](../snippets/docusign-hmac-verifier.js).

---

## After verification — the DocuSign event handler

Once the signature is valid, the handler:

1. Parses the JSON body. DocuSign Connect v2.1 has a clean shape:
   ```js
   {
     event: "envelope-completed",
     apiVersion: "v2.1",
     data: {
       envelopeId: "...",
       envelopeSummary: { ... },
       recipients: { ... }
     }
   }
   ```
2. Extracts `envelopeId`, `event` type, and `completedDateTime`.
3. Reads the Excel cases table, finds the row where
   `docusignEnvelopeId` matches.
4. Downloads the signed PDF from DocuSign.
5. Uploads it to SharePoint.
6. PATCHes the Excel row: status = `completed`, completion date.
7. Posts a Slack DM to the case creator.

Each step has its own failure mode (envelope ID not found in Excel
= operational issue, not a security one — log and notify a human;
DocuSign download fails = retry; SharePoint upload fails = retry
with backoff). The handler handles each independently rather than
treating "anything went wrong" as a single error.

---

## Failure modes

| Failure | Cause | Response |
|---|---|---|
| Missing signature header | Misconfigured DocuSign Connect, or attacker not bothering to forge it | Reject with 400 |
| Signature mismatch | Wrong secret, or actual forgery attempt | Reject with 401, log the attempt |
| Body is empty or malformed JSON after verification | Connect misconfiguration | Reject with 400, alert on-call |
| Envelope ID not found in Excel | Case was deleted, or this envelope is for a different system | Log and ignore (don't 500 — it would cause Connect to retry forever) |
| Excel PATCH fails | Microsoft Graph 5xx or token expiry | Retry with backoff; if still failing, queue for manual reconciliation |
| Slack post fails | Slack outage or workspace removal | Best-effort; the case state is correct in Excel even without the notification |

---

## Secret management

The HMAC secret is **not** in the workflow JSON. Options:

- **n8n credentials** — store as a credential (type "header auth" or
  generic), reference via `$credentials.docusignHmac.secret`.
- **Environment variable** — `$env.DOCUSIGN_HMAC_SECRET` if the n8n
  instance supports it.
- **External secrets manager** — Vault, AWS Secrets Manager, Azure
  Key Vault. The workflow fetches it at runtime via an HTTP node.

Hard-coding the secret in the Code node is the failure mode this doc
exists to prevent. Anyone with read access to the workflow JSON
(another developer, a misconfigured backup, a leaked export) gets
the secret and can forge webhooks.

---

## Rotating the secret

DocuSign Connect supports up to four secrets simultaneously, with
headers `x-docusign-signature-1` through `-4`. To rotate without
downtime:

1. Generate a new secret in DocuSign.
2. Configure it as the second secret slot (so DocuSign now signs
   with both).
3. Update your verification code to accept either signature
   (compute against secret 1 OR secret 2; accept on either match).
4. Wait long enough for any in-flight messages to flush.
5. Remove the old secret in DocuSign.
6. Update verification code to only accept the new secret.
