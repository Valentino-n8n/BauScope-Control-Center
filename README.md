# BauScope Control Center — Slack Internal Tool Patterns

A reference for building a role-based internal operations tool inside
Slack, with DocuSign Connect integration and structured Excel state.

This repository documents the architecture decisions, code patterns, and
design trade-offs from a role-based Slack internal tool I built and
operate in production. The tool coordinates 3D scan operations, customer
consent workflows, and team management for a small operations team.

> Customer data, credentials, Slack workspace identifiers, user IDs,
> internal SharePoint references, DocuSign envelope IDs, HMAC secrets,
> and the live workflow JSON are not part of the public material. The
> patterns and JavaScript helpers below are generalized: field names use
> generic placeholders, project-specific identifiers are removed, and
> comments are translated to English.

---

## What this platform solves

A small operations team needs to coordinate 3D-scan work that includes a
digital consent step before any scan begins. Each case involves:

- Collecting structured customer and object data
- Generating a stable internal serial number (e.g. `FS-0161`)
- Sending a digitally-signable consent document via DocuSign
- Receiving and verifying the DocuSign completion event
- Storing the signed PDF in SharePoint
- Tracking case status in an Excel workbook
- Notifying the team in Slack when each case is ready to continue

Different team members have different responsibilities. A
super-administrator sees everything, including user management. An
administrator can create cases and run reports. A technician (German:
*Techniker*) sees scan-related actions. The same Slack app needs to
present a different interface to each role.

This platform brings all of that into Slack: App Home tab as the
dashboard, modals for structured input, DocuSign for the signing loop,
Excel as the durable state, and webhooks tying it together.

---

## Architecture at a glance

```
┌────── Slack UI ───────────────────────────────────────────────────┐
│  App Home tab — rendered per user, blocks vary by role             │
│  Modals — Einwilligung intake, user CRUD, search, reports          │
│  Confirmation DMs after every write                                │
└────────────────────────────────────────────────────────────────────┘
            │                                  │
            ▼                                  ▼
┌── Home Tab Workflow ──┐         ┌── Interaction Workflow ──────────┐
│  Listens on            │         │  Listens on Slack interactions   │
│  app_home_opened       │         │  webhook (button clicks +        │
│  Reads users table     │         │  view submissions)               │
│  Builds role-specific  │         │  Authorization layer first       │
│  blocks → publishes    │         │  Then routes to:                 │
└────────────────────────┘         │    • new Einwilligung            │
                                   │    • user CRUD                   │
                                   │    • search / details            │
                                   │    • reports                     │
                                   └──────────────────────────────────┘
                                              │
                                              ▼
┌── DocuSign Workflow ──┐         ┌── State (Microsoft Graph) ───────┐
│  Listens on DocuSign  │         │  Excel: cases table              │
│  Connect webhooks     │         │    case fields, status, envelope │
│  HMAC SHA256 verify   │         │    ID, sent/completed dates      │
│  Match envelope to    │◄───────►│  Excel: users table              │
│  Excel row → upload   │         │    user-to-Slack-ID mapping,     │
│  signed PDF, update   │         │    role, active status           │
│  status, notify Slack │         │  SharePoint: signed PDFs         │
└───────────────────────┘         └──────────────────────────────────┘
```

Three n8n workflows, three responsibilities. The split is documented in
[`docs/architecture.md`](docs/architecture.md).

---

## Repository structure

```
.
├── README.md                                  ← you are here
├── docs/
│   ├── architecture.md                        ← system overview, workflow split
│   ├── role-based-app-home-pattern.md         ← dynamic Home Tab per role
│   ├── docusign-hmac-verification.md          ← Connect webhook + HMAC SHA256
│   ├── excel-column-mapper-pattern.md         ← type-safe Excel access
│   └── multi-source-authorization.md          ← auth layer over 4 Slack event types
└── snippets/
    ├── README.md
    ├── role-based-home-tab.js                 ← dynamic blocks per role + user lookup
    ├── docusign-hmac-verifier.js              ← Connect HMAC SHA256 verification
    ├── excel-column-mapper.js                 ← type-safe column access class
    ├── excel-serial-date-utils.js             ← Excel date conversion (1900 leap-year bug)
    └── slack-authorization-extractor.js       ← multi-source user identity extraction
```

All snippets come from production Code nodes, generalized for public
release: field names use generic placeholders, project-specific
identifiers are removed, and comments are translated to English.

---

## Tech stack

- **Orchestration:** n8n (cloud)
- **UI:** Slack — App Home tab, modals, DMs
- **State:** Microsoft Excel + SharePoint via Microsoft Graph
- **Signing:** DocuSign + DocuSign Connect (webhooks)
- **Code:** in-node JavaScript, ~7,400 lines across the three workflows

---

## What this platform does and does not do

This is a focused internal tool for a small team. The trade-offs are
explicit:

- **Three roles, no general permission system.** Roles are a three-tier
  enum (`super_admin`, `admin`, `techniker`), not an attribute-based
  access system. Adequate for the team size; replace with a real RBAC
  for any larger use.
- **Excel is the bottleneck.** Microsoft Graph rate limits and Excel
  workbook locks are the failure modes you'll hit first under load.
- **Serial numbers are derived in two places.** The next number is
  *computed* in n8n (read max + 1 + format) but *committed* to a
  SharePoint list, which acts as the source of truth. This works
  because writes are infrequent; under high concurrency it would race.
- **HMAC verification protects DocuSign Connect.** It does not protect
  general Slack interactions; those are guarded by the authorization
  layer plus channel-membership checks.

---

## What this repo does NOT contain

Scope of this repository:

- **The DocuSign envelope-sending workflow** — the path that prepares
  the consent document, fills the template's text-tabs, and dispatches
  the envelope — is not in this repo. The pattern is similar to the
  one documented in
  [`Valentino-n8n/DISPO`](https://github.com/Valentino-n8n/DISPO) (which
  uses the same DocuSign template-tab approach for Haftungszertifikat).
- **The actual consent intake modal** ("Neue Einwilligung") is not
  reproduced verbatim — only the role-based platform that hosts it is.
- **Search workflow internals.** The case-search workflow has 40 Code
  nodes; only the small set of utility patterns useful in any internal
  tool (column mapper, date utils, authorization extractor) is
  documented here. The case-specific filtering is private.

---

## About

Built and maintained by [Valentino Veljanovski](https://valentinoveljanovski.de),
automation developer based in München. The full case study for the
production system this platform supports is at
[valentinoveljanovski.de/projects/matterport-pro3](https://valentinoveljanovski.de/projects/matterport-pro3).

Companion repositories cover related patterns:

- [`Valentino-n8n/DISPO`](https://github.com/Valentino-n8n/DISPO) —
  Microsoft 365 + DocuSign + AI-assisted operations
- [`Valentino-n8n/Reklamation`](https://github.com/Valentino-n8n/Reklamation) —
  Slack-based case management with App Home, modals, and LLM email assistant

---

## Viewing Notice

This repository is published for portfolio demonstration and educational
viewing only.

All code, documentation, diagrams, and content in this repository remain
the intellectual property of the author. **All rights reserved.**

No license is granted, expressed or implied, for reuse, redistribution,
modification, or commercial use of any material in this repository
without prior written permission from the author.

For licensing or collaboration inquiries, contact: <valentinoveljanovski@outlook.com>