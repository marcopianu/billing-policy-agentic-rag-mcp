import { z } from "zod";
import { createMcpHandler } from "mcp-handler";

type Action = "SEPA_ALLOWED" | "DUNNING_ALLOWED" | "BLOCKED";

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN!;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID!;
const AIRTABLE_INVOICE_TABLE = process.env.AIRTABLE_INVOICE_TABLE!;
const AIRTABLE_AUDIT_TABLE = process.env.AIRTABLE_AUDIT_TABLE!;
const AIRTABLE_REVIEW_TABLE = process.env.AIRTABLE_REVIEW_TABLE!;
const AIRTABLE_ALIGNMENT_TABLE = process.env.AIRTABLE_ALIGNMENT_TABLE!;

async function findRecordIdByFormula(table: string, formulaRaw: string) {
  const formula = encodeURIComponent(formulaRaw);

  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${table}?filterByFormula=${formula}`,
    {
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      },
    }
  );

  if (!res.ok) {
    throw new Error(`Airtable lookup failed: ${await res.text()}`);
  }

  const data = await res.json();
  return data.records?.[0]?.id || null;
}

async function findInvoiceRecordId(invoiceId: string) {
  return findRecordIdByFormula(AIRTABLE_INVOICE_TABLE, `{invoice_id} = "${invoiceId}"`);
}

async function createRecord(table: string, fields: Record<string, unknown>) {
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${table}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields }),
    }
  );

  if (!res.ok) {
    throw new Error(`Airtable create failed: ${await res.text()}`);
  }

  return res.json();
}

async function updateRecord(table: string, recordId: string, fields: Record<string, unknown>) {
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${table}/${recordId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields }),
    }
  );

  if (!res.ok) {
    throw new Error(`Airtable update failed: ${await res.text()}`);
  }

  return res.json();
}

async function upsertInvoiceByInvoiceId(
  invoiceId: string,
  fields: Record<string, unknown>
) {
  const recordId = await findInvoiceRecordId(invoiceId);

  if (recordId) {
    return updateRecord(AIRTABLE_INVOICE_TABLE, recordId, fields);
  }

  return createRecord(AIRTABLE_INVOICE_TABLE, fields);
}

async function upsertManualReviewByInvoiceId(
  invoiceId: string,
  fields: Record<string, unknown>
) {
  const recordId = await findRecordIdByFormula(
    AIRTABLE_REVIEW_TABLE,
    `{invoice_id} = "${invoiceId}"`
  );

  if (recordId) {
    return updateRecord(AIRTABLE_REVIEW_TABLE, recordId, fields);
  }

  return createRecord(AIRTABLE_REVIEW_TABLE, fields);
}

async function upsertAlignmentByInvoiceId(
  invoiceId: string,
  fields: Record<string, unknown>
) {
  const recordId = await findRecordIdByFormula(
    AIRTABLE_ALIGNMENT_TABLE,
    `{Invoice} = "${invoiceId}"`
  );

  if (recordId) {
    return updateRecord(AIRTABLE_ALIGNMENT_TABLE, recordId, fields);
  }

  return createRecord(AIRTABLE_ALIGNMENT_TABLE, fields);
}

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "billing_policy_check",
      "Checks whether an overdue invoice is allowed for SEPA collection, dunning, or manual review.",
      {
        run_id: z.string(),
        airtable_record_id: z.string(),
        invoice_id: z.string(),
        customer_email: z.string(),
        customer_name: z.string(),
        requested_action: z.string(),
        payment_method: z.string(),
        amount_eur: z.number(),
        due_days_over: z.number().int(),
        dunning_level: z.number().int(),
        mandate_id: z.string().optional().default(""),
        debtor_iban: z.string().optional().default(""),
        debtor_bic: z.string().optional().default(""),
      },
      async (input) => {
        let action: Action = "BLOCKED";
        let allowed = false;
        let risk_level: "low" | "medium" | "high" = "high";
        let rule_ids: string[] = [];
        let reason = "";

        if (
          input.payment_method === "SEPA" &&
          input.amount_eur > 0 &&
          input.mandate_id &&
          input.debtor_iban
        ) {
          allowed = true;
          action = "SEPA_ALLOWED";
          risk_level = "low";
          rule_ids = ["SEPA_MANDATE_PRESENT", "IBAN_PRESENT", "AMOUNT_POSITIVE"];
          reason = "SEPA collection is allowed because mandate and debtor account data are present.";
        } else if (
          input.payment_method === "INVOICE" &&
          input.amount_eur > 0 &&
          input.due_days_over >= 7
        ) {
          allowed = true;
          action = "DUNNING_ALLOWED";
          risk_level = "medium";
          rule_ids = ["INVOICE_OVERDUE", "DUNNING_THRESHOLD_REACHED", "AMOUNT_POSITIVE"];
          reason = "Dunning is allowed because the invoice is overdue and the amount is positive.";
        } else {
          allowed = false;
          action = "BLOCKED";
          risk_level = "high";
          rule_ids = ["NO_SAFE_AUTOMATION_PATH"];
          reason = "No safe automation path: missing SEPA mandate/IBAN, invalid amount, unsupported payment method, or dunning not eligible.";
        }

        await upsertInvoiceByInvoiceId(input.invoice_id, {
          airtable_record_id: input.airtable_record_id,
          invoice_id: input.invoice_id,
          customer_email: input.customer_email,
          customer_name: input.customer_name,
          payment_method: input.payment_method,
          status: "OVERDUE",
          amount_eur: input.amount_eur,
          due_days_over: input.due_days_over,
          dunning_level: input.dunning_level,
          mandate_id: input.mandate_id,
          debtor_iban: input.debtor_iban,
          debtor_bic: input.debtor_bic,
        });

        if (action === "BLOCKED") {
          await upsertManualReviewByInvoiceId(input.invoice_id, {
            run_id: input.run_id,
            invoice_id: input.invoice_id,
            customer_email: input.customer_email,
            customer_name: input.customer_name,
            requested_action: input.requested_action,
            executed_action: action,
            reason,
            rule_ids: rule_ids.join(", "),
            review_status: "OPEN",
            created_at: new Date().toISOString(),
          });

          await upsertAlignmentByInvoiceId(input.invoice_id, {
            Invoice: input.invoice_id,
            "AI intent": input.requested_action,
            "MCP/result": "BLOCKED",
            "Airtable result": "stays OVERDUE, no XML, manual review case",
            Alignment: "Correct",
          });
        }

        const result = {
          run_id: input.run_id,
          airtable_record_id: input.airtable_record_id,
          invoice_id: input.invoice_id,
          customer_email: input.customer_email,
          customer_name: input.customer_name,
          requested_action: input.requested_action,
          executed_action: action,
          allowed,
          action,
          risk_level,
          rule_ids,
          reason,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }
    );

    server.tool(
      "attach_sepa_xml",
      "Stores the generated SEPA XML for an invoice.",
      {
        run_id: z.string(),
        airtable_record_id: z.string(),
        invoice_id: z.string(),
        sepa_xml: z.string(),
      },
      async (input) => {
        await upsertInvoiceByInvoiceId(input.invoice_id, {
          invoice_id: input.invoice_id,
          SEPA_XML: input.sepa_xml,
          status: "SEPA_XML_READY",
        });

        await upsertAlignmentByInvoiceId(input.invoice_id, {
          Invoice: input.invoice_id,
          "AI intent": "SEPA",
          "MCP/result": "SEPA_ALLOWED",
          "Airtable result": "SEPA_XML_READY + XML stored",
          Alignment: "Correct",
        });

        const result = {
          run_id: input.run_id,
          airtable_record_id: input.airtable_record_id,
          invoice_id: input.invoice_id,
          sepa_xml_attached: true,
          executed_action: "SEPA_XML_ATTACHED",
          reason: "SEPA XML was stored in Airtable and the invoice was marked SEPA_XML_READY.",
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }
    );

    server.tool(
      "record_dispatch_outcome",
      "Records that a dunning email was sent and increments the dunning level.",
      {
        run_id: z.string(),
        airtable_record_id: z.string(),
        invoice_id: z.string(),
        outcome: z.string(),
        recipient: z.string(),
        old_dunning_level: z.number().int(),
      },
      async (input) => {
        const newDunningLevel = input.old_dunning_level + 1;

        await upsertInvoiceByInvoiceId(input.invoice_id, {
          invoice_id: input.invoice_id,
          status: "DUNNING_EMAIL_SENT",
          dunning_level: newDunningLevel,
        });

        await createRecord(AIRTABLE_AUDIT_TABLE, {
          run_id: input.run_id,
          invoice_id: input.invoice_id,
          executed_action: "DUNNING_EMAIL_SENT",
          outcome: input.outcome,
          recipient: input.recipient,
          old_dunning_level: input.old_dunning_level,
          new_dunning_level: newDunningLevel,
          timestamp: new Date().toISOString(),
        });

        await upsertAlignmentByInvoiceId(input.invoice_id, {
          Invoice: input.invoice_id,
          "AI intent": "DUNNING",
          "MCP/result": "DUNNING_ALLOWED / email sent",
          "Airtable result": `DUNNING_EMAIL_SENT, level ${input.old_dunning_level} → ${newDunningLevel}`,
          Alignment: "Correct",
        });

        const result = {
          run_id: input.run_id,
          airtable_record_id: input.airtable_record_id,
          invoice_id: input.invoice_id,
          executed_action: "DUNNING_EMAIL_SENT",
          outcome: input.outcome,
          recipient: input.recipient,
          old_dunning_level: input.old_dunning_level,
          new_dunning_level: newDunningLevel,
          reason: "Dunning email outcome was recorded and dunning level was incremented.",
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }
    );
  },
  {},
  { basePath: "/api" }
);

export { handler as GET, handler as POST, handler as DELETE };
