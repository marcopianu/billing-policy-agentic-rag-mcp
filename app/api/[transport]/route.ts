import { z } from "zod";
import { createMcpHandler } from "mcp-handler";

type Action = "SEPA_ALLOWED" | "DUNNING_ALLOWED" | "BLOCKED";

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN!;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID!;
const AIRTABLE_INVOICE_TABLE = process.env.AIRTABLE_INVOICE_TABLE!;
const AIRTABLE_REVIEW_TABLE = process.env.AIRTABLE_REVIEW_TABLE!;

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const BILLING_FROM_EMAIL = process.env.BILLING_FROM_EMAIL || "";
const MANUAL_REVIEW_EMAIL = process.env.MANUAL_REVIEW_EMAIL || "";

function nowIso() {
  return new Date().toISOString();
}

function escapeXml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function formatAmount(value: number) {
  return value.toFixed(2);
}

async function findRecordByFormula(table: string, formulaRaw: string) {
  const formula = encodeURIComponent(formulaRaw);

  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${table}?filterByFormula=${formula}`,
    {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    }
  );

  if (!res.ok) throw new Error(`Airtable lookup failed: ${await res.text()}`);

  const data = await res.json();
  return data.records?.[0] || null;
}

async function findRecordIdByFormula(table: string, formulaRaw: string) {
  const record = await findRecordByFormula(table, formulaRaw);
  return record?.id || null;
}

async function findInvoiceRecord(invoiceId: string) {
  return findRecordByFormula(AIRTABLE_INVOICE_TABLE, `{invoice_id} = "${invoiceId}"`);
}

async function findInvoiceRecordId(invoiceId: string) {
  return findRecordIdByFormula(AIRTABLE_INVOICE_TABLE, `{invoice_id} = "${invoiceId}"`);
}

async function createRecord(table: string, fields: Record<string, unknown>) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${table}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });

  if (!res.ok) throw new Error(`Airtable create failed: ${await res.text()}`);
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

  if (!res.ok) throw new Error(`Airtable update failed: ${await res.text()}`);
  return res.json();
}

async function upsertInvoiceByInvoiceId(invoiceId: string, fields: Record<string, unknown>) {
  const recordId = await findInvoiceRecordId(invoiceId);
  if (recordId) return updateRecord(AIRTABLE_INVOICE_TABLE, recordId, fields);
  return createRecord(AIRTABLE_INVOICE_TABLE, fields);
}

async function upsertManualReviewByInvoiceId(invoiceId: string, fields: Record<string, unknown>) {
  const recordId = await findRecordIdByFormula(AIRTABLE_REVIEW_TABLE, `{invoice_id} = "${invoiceId}"`);
  if (recordId) return updateRecord(AIRTABLE_REVIEW_TABLE, recordId, fields);
  return createRecord(AIRTABLE_REVIEW_TABLE, fields);
}

async function sendEmail(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY || !BILLING_FROM_EMAIL) {
    throw new Error("Missing RESEND_API_KEY or BILLING_FROM_EMAIL");
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: BILLING_FROM_EMAIL,
      to,
      subject,
      html,
    }),
  });

  if (!res.ok) throw new Error(`Email send failed: ${await res.text()}`);
  return res.json();
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

        if (input.payment_method === "SEPA" && input.amount_eur > 0 && input.mandate_id && input.debtor_iban) {
          allowed = true;
          action = "SEPA_ALLOWED";
          risk_level = "low";
          rule_ids = ["SEPA_MANDATE_PRESENT", "IBAN_PRESENT", "AMOUNT_POSITIVE"];
          reason = "SEPA collection is allowed because mandate and debtor account data are present.";
        } else if (input.payment_method === "INVOICE" && input.amount_eur > 0 && input.due_days_over >= 7) {
          allowed = true;
          action = "DUNNING_ALLOWED";
          risk_level = "medium";
          rule_ids = ["INVOICE_OVERDUE", "DUNNING_THRESHOLD_REACHED", "AMOUNT_POSITIVE"];
          reason = "Dunning is allowed because the invoice is overdue and the amount is positive.";
        } else {
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
            created_at: nowIso(),
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

        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      }
    );

    server.tool(
      "generate_sepa_xml",
      "Generates SEPA pain.008.001.02 XML server-side.",
      {
        run_id: z.string(),
        airtable_record_id: z.string(),
        invoice_id: z.string(),
        customer_name: z.string(),
        amount_eur: z.number(),
        mandate_id: z.string(),
        debtor_iban: z.string(),
        debtor_bic: z.string().optional().default(""),
      },
      async (input) => {
        const amount = formatAmount(input.amount_eur);
        const createdAt = nowIso().replace(/\.\d{3}Z$/, "");
        const collectionDate = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);

        const sepa_xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.02">
  <CstmrDrctDbtInitn>
    <GrpHdr>
      <MsgId>${escapeXml(input.run_id)}-${escapeXml(input.invoice_id)}</MsgId>
      <CreDtTm>${createdAt}</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <CtrlSum>${amount}</CtrlSum>
      <InitgPty><Nm>Demo Billing GmbH</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>PMT-${escapeXml(input.invoice_id)}</PmtInfId>
      <PmtMtd>DD</PmtMtd>
      <BtchBookg>false</BtchBookg>
      <NbOfTxs>1</NbOfTxs>
      <CtrlSum>${amount}</CtrlSum>
      <PmtTpInf>
        <SvcLvl><Cd>SEPA</Cd></SvcLvl>
        <LclInstrm><Cd>CORE</Cd></LclInstrm>
        <SeqTp>OOFF</SeqTp>
      </PmtTpInf>
      <ReqdColltnDt>${collectionDate}</ReqdColltnDt>
      <Cdtr><Nm>Demo Billing GmbH</Nm></Cdtr>
      <CdtrAcct><Id><IBAN>DE02120300000000202051</IBAN></Id></CdtrAcct>
      <CdtrAgt><FinInstnId><BIC>BYLADEM1001</BIC></FinInstnId></CdtrAgt>
      <ChrgBr>SLEV</ChrgBr>
      <CdtrSchmeId>
        <Id><PrvtId><Othr><Id>DE98ZZZ09999999999</Id><SchmeNm><Prtry>SEPA</Prtry></SchmeNm></Othr></PrvtId></Id>
      </CdtrSchmeId>
      <DrctDbtTxInf>
        <PmtId><EndToEndId>${escapeXml(input.invoice_id)}</EndToEndId></PmtId>
        <InstdAmt Ccy="EUR">${amount}</InstdAmt>
        <DrctDbtTx><MndtRltdInf><MndtId>${escapeXml(input.mandate_id)}</MndtId><DtOfSgntr>2024-01-01</DtOfSgntr></MndtRltdInf></DrctDbtTx>
        <DbtrAgt><FinInstnId><BIC>${escapeXml(input.debtor_bic)}</BIC></FinInstnId></DbtrAgt>
        <Dbtr><Nm>${escapeXml(input.customer_name)}</Nm></Dbtr>
        <DbtrAcct><Id><IBAN>${escapeXml(input.debtor_iban)}</IBAN></Id></DbtrAcct>
        <RmtInf><Ustrd>Invoice ${escapeXml(input.invoice_id)}</Ustrd></RmtInf>
      </DrctDbtTxInf>
    </PmtInf>
  </CstmrDrctDbtInitn>
</Document>`;

        const result = { ...input, sepa_xml, executed_action: "SEPA_XML_GENERATED" };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
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

        const result = { ...input, sepa_xml_attached: true, executed_action: "SEPA_XML_ATTACHED" };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      }
    );

    server.tool(
      "send_dunning_email",
      "Sends a German dunning email. Recipient is loaded from Airtable.",
      {
        run_id: z.string(),
        airtable_record_id: z.string(),
        invoice_id: z.string(),
      },
      async (input) => {
        const record = await findInvoiceRecord(input.invoice_id);
        if (!record) throw new Error("Invoice not found");

        const f = record.fields;
        const html = `<p>Hallo ${escapeXml(f.customer_name)},</p>
<p>die Rechnung <strong>${escapeXml(f.invoice_id)}</strong> über <strong>${escapeXml(f.amount_eur)} EUR</strong> ist seit <strong>${escapeXml(f.due_days_over)}</strong> Tagen überfällig.</p>
<p>Bitte begleichen Sie den offenen Betrag zeitnah.</p>
<p>Viele Grüße<br>Billing Team</p>`;

        await sendEmail(String(f.customer_email), `Zahlungserinnerung zu Rechnung ${f.invoice_id}`, html);

        const result = {
          run_id: input.run_id,
          airtable_record_id: input.airtable_record_id,
          invoice_id: input.invoice_id,
          recipient: f.customer_email,
          executed_action: "DUNNING_EMAIL_SENT",
        };

        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      }
    );

    server.tool(
      "send_manual_review_email",
      "Sends a manual review notice to the fixed ops recipient.",
      {
        run_id: z.string(),
        airtable_record_id: z.string(),
        invoice_id: z.string(),
        reason: z.string().optional().default("Manual review required."),
      },
      async (input) => {
        if (!MANUAL_REVIEW_EMAIL) throw new Error("Missing MANUAL_REVIEW_EMAIL");

        const html = `<p><strong>Manual review required</strong></p>
<p>Invoice <strong>${escapeXml(input.invoice_id)}</strong> needs manual review.</p>
<p>${escapeXml(input.reason)}</p>`;

        await sendEmail(MANUAL_REVIEW_EMAIL, `[Manual Review] ${input.invoice_id}`, html);

        await upsertManualReviewByInvoiceId(input.invoice_id, {
          run_id: input.run_id,
          invoice_id: input.invoice_id,
          reason: input.reason,
          review_status: "OPEN",
          created_at: nowIso(),
        });

        const result = { ...input, recipient: MANUAL_REVIEW_EMAIL, executed_action: "MANUAL_REVIEW_EMAIL_SENT" };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      }
    );

    server.tool(
      "record_dispatch_outcome",
      "Records dispatch outcome and increments dunning level.",
      {
        run_id: z.string(),
        airtable_record_id: z.string(),
        invoice_id: z.string(),
        outcome: z.string(),
        recipient: z.string().optional().default(""),
        old_dunning_level: z.number().int(),
      },
      async (input) => {
        const newDunningLevel = input.old_dunning_level + 1;

        await upsertInvoiceByInvoiceId(input.invoice_id, {
          invoice_id: input.invoice_id,
          status: "DUNNING_EMAIL_SENT",
          dunning_level: newDunningLevel,
        });

        const result = { ...input, executed_action: "DUNNING_EMAIL_SENT", new_dunning_level: newDunningLevel };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      }
    );

    server.tool(
      "airtable_update_invoice",
      "Updates only final status and last action timestamp on an invoice.",
      {
        invoice_id: z.string(),
        final_status: z.string(),
        last_action_at: z.string().optional().default(""),
      },
      async (input) => {
        await upsertInvoiceByInvoiceId(input.invoice_id, {
          invoice_id: input.invoice_id,
          status: input.final_status,
          last_action_at: input.last_action_at || nowIso(),
        });

        const result = { ...input, updated: true };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      }
    );
  },
  {},
  {
    basePath: "/api",
    maxDuration: 60,
    verboseLogs: true,
  }
);

export { handler as GET, handler as POST, handler as DELETE };
