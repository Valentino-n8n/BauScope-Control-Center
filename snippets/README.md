# Code Node Snippets

JavaScript helpers from the production interaction and DocuSign
workflows, generalized and stripped of internal identifiers.

| File | Purpose |
|---|---|
| `role-based-home-tab.js` | Build a role-specific App Home block list. Looks up the user in an Excel users table, branches on role (super_admin / admin / techniker), renders different action sets. |
| `docusign-hmac-verifier.js` | Verify DocuSign Connect webhook authenticity via HMAC SHA256 over the raw request body. Handles header-case variations, supports a testing-only opt-out flag. |
| `excel-column-mapper.js` | Type-safe access to Excel rows fetched via Microsoft Graph. Replaces hard-coded `row.values[0][14]` with `mapper.get(row, 'envelopeId')`. Includes write-side helpers for building rows. |
| `excel-serial-date-utils.js` | Convert between Excel serial dates (e.g. `45234.5833`) and JavaScript Date objects. Handles Excel's 1900 leap-year bug. Locale-aware formatting helpers. |
| `slack-authorization-extractor.js` | Normalize user identity across four Slack event shapes (`block_actions`, `view_submission`, events, slash commands) into a single flat object. Maps event type to default required permission. |

## How to use

Drop the snippet into an n8n **Code** node, adjust constants and
column names to match your data, and connect upstream/downstream
per the snippet's doc-comment.

All snippets assume the standard n8n Code-node context (`$input`,
`$json`, `$()`, `$env`, `items`).

## Conventions

- Secrets (HMAC keys, DocuSign API keys) are referenced via `$env`
  or `$credentials` — never inlined.
- User and Slack IDs in the example arrays use placeholders like
  `U_AAAAAAAAAA` rather than real Slack IDs.
- Internal customer-domain references are replaced with example
  domains.
