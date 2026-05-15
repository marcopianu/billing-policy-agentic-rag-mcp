# billing-policy-mcp

MCP policy server for a billing automation MVP built with Make.com, Airtable, and Vercel.

The server acts as a hard execution gate for invoice automation.
The AI agent may propose an action, but this MCP server decides what is actually allowed.

## Endpoint

```
https://billing-policy-mcp.vercel.app/api/mcp
```

The root page is only the default Next.js page. The MCP server runs on:

```
/api/mcp
```

> **Note:** Use the same hostname everywhere (`billing-policy-mcp.vercel.app`).
> Earlier versions of the Make.com scenario referenced `billing-policy.vercel.app` — that is wrong. The single source of truth is `billing-policy-mcp.vercel.app`.

## MCP tools

### `billing_policy_check`

Checks one invoice and returns the allowed billing action.

Possible decisions:

```
SEPA_ALLOWED
DUNNING_ALLOWED
BLOCKED
```

This tool also writes or updates the invoice record in Airtable.

### `attach_sepa_xml`

Stores generated SEPA XML in Airtable and marks the invoice as:

```
SEPA_XML_READY
```

This tool is only called after `billing_policy_check` returns `SEPA_ALLOWED`.

### `record_dispatch_outcome`

Records that a dunning email was sent, writes an audit log entry, and increments the dunning level.

This tool is only called after `billing_policy_check` returns `DUNNING_ALLOWED`.

## Policy logic

### SEPA allowed

SEPA collection is allowed only when:

- `payment_method = SEPA`
- `amount_eur > 0`
- `mandate_id` is present
- `debtor_iban` is present

Result:

```
SEPA_ALLOWED
```

### Dunning allowed

Dunning is allowed only when:

- `payment_method = INVOICE`
- `amount_eur > 0`
- `due_days_over >= 7`

Result:

```
DUNNING_ALLOWED
```

### Blocked

Everything else is blocked.

Typical blocked cases:

- missing SEPA mandate
- missing debtor IBAN
- invalid or zero amount
- unsupported payment method
- invoice not overdue enough
- unclear automation path

Result:

```
BLOCKED
```

Blocked invoices are written to the manual review queue in Airtable.

## Make.com workflow

The Make.com scenario works like this:

1. Parse a mock billing JSON export
2. Iterate over invoices
3. Let the AI agent propose `SEPA`, `DUNNING`, or `REVIEW`
4. Call the MCP tool `billing_policy_check`
5. Route only by the MCP result, not by the AI result
6. If `SEPA_ALLOWED`, generate SEPA XML and call `attach_sepa_xml`
7. If `DUNNING_ALLOWED`, send a dunning email and call `record_dispatch_outcome`
8. If `BLOCKED`, send the invoice to manual review

The important rule:

```
AI intent ≠ execution permission
```

The AI only proposes. The MCP server decides.

## Example result

```json
{
  "run_id": "BILLING-RUN-2026-04-MVP-001",
  "invoice_id": "INV-2026-0001",
  "requested_action": "SEPA",
  "executed_action": "SEPA_ALLOWED",
  "allowed": true,
  "action": "SEPA_ALLOWED",
  "risk_level": "low",
  "rule_ids": [
    "SEPA_MANDATE_PRESENT",
    "IBAN_PRESENT",
    "AMOUNT_POSITIVE"
  ],
  "reason": "SEPA collection is allowed because mandate and debtor account data are present."
}
```

## Airtable tables

The server writes to these Airtable tables:

```
Invoices
Billing_Audit_Log
Manual_Review_Queue
Alignment
```

Required environment variables:

```
AIRTABLE_TOKEN=
AIRTABLE_BASE_ID=
AIRTABLE_INVOICE_TABLE=
AIRTABLE_AUDIT_TABLE=
AIRTABLE_REVIEW_TABLE=
AIRTABLE_ALIGNMENT_TABLE=
```

## Run locally

```
npm install
npm run dev
```

Local MCP route:

```
http://localhost:3000/api/mcp
```

## Build

```
npm run build
```

## Deploy

This project is designed for Vercel.

After deployment, connect Make.com MCP Client to:

```
https://billing-policy-mcp.vercel.app/api/mcp
```

## MVP scope

This is a demo/MVP policy server.
For real production use, add:

- authentication
- request signing
- stronger audit logs
- idempotency keys
- tenant separation
- stricter SEPA validation
- proper error handling
- internal-only network access
- policy versioning
- human approval for high-risk cases
