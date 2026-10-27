import type { TemplateCatalogEntry } from "../../src/commands/templates/generated-module";

export const welcomeSchema = {
  type: "object",
  properties: {
    firstName: { type: "string", description: "Who the message greets." },
    plan: { enum: ["free", "pro"] },
    seats: { type: "integer" },
    invitedBy: { type: "string" },
  },
  required: ["firstName", "plan", "seats"],
  additionalProperties: false,
};

export const digestSchema = {
  type: "object",
  properties: {
    items: { type: "array", items: { $ref: "#/$defs/Item" } },
  },
  required: ["items"],
  additionalProperties: false,
  $defs: {
    Item: {
      type: "object",
      properties: {
        title: { type: "string" },
        children: { type: "array", items: { $ref: "#/$defs/Item" } },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
};

export const receiptSchema = {
  type: "object",
  properties: {
    orderId: { type: "string" },
    total: { type: "number" },
  },
  required: ["orderId", "total"],
  additionalProperties: { type: "string" },
};

export const catalog: readonly TemplateCatalogEntry[] = [
  {
    key: "receipt",
    templateId: "tmpl_6qece3pt000000000",
    publicationId: "tpub_6qece3pt000000000",
    inputContractId: "tcon_6qece3pt000000000",
    inputSchema: receiptSchema,
  },
  {
    key: "weekly-digest",
    templateId: "tmpl_3rgest0000000000",
    publicationId: "tpub_3rgest0000000000",
    inputContractId: "tcon_3rgest0000000000",
    inputSchema: digestSchema,
  },
  {
    key: "welcome",
    templateId: "tmpl_2eqcmea000000000",
    publicationId: "tpub_2eqcmea000000000",
    inputContractId: "tcon_2eqcmea000000000",
    inputSchema: welcomeSchema,
  },
];

const plans = Array.from({ length: 12 }, (_, index) => `annual-plan-tier-${index + 1}`);

/**
 * Shapes the repository formatter lays out by width and depth: a union too long for one line, nested
 * objects, an array of a union that holds an object, an array of a long enum, and a slug long enough
 * to break its map entry, nested lists, and an intersection with a union. The generated file for it is checked in and formatted with the repository,
 * so a layout the formatter would change fails `format:check`.
 */
export const wideCatalog: readonly TemplateCatalogEntry[] = [
  {
    key: "subscription-renewal-reminder-for-annual-plans",
    templateId: "tmpl_7qenewa000000000",
    publicationId: "tpub_7qenewa000000000",
    inputContractId: "tcon_7qenewa000000000",
    inputSchema: {
      type: "object",
      properties: {
        plan: { $ref: "#/$defs/Plan" },
        "next-charge": { type: "string" },
        contact: {
          type: "object",
          properties: {
            name: { type: "string" },
            billing: {
              type: "object",
              properties: { country: { type: "string" }, vatId: { type: "string" } },
              required: ["country"],
              additionalProperties: false,
            },
          },
          required: ["name"],
          additionalProperties: false,
        },
        lines: {
          type: "array",
          items: {
            anyOf: [
              {
                type: "object",
                properties: { label: { type: "string" }, amount: { type: "number" } },
                required: ["label", "amount"],
                additionalProperties: false,
              },
              { type: "string" },
            ],
          },
        },
        tiers: { type: "array", items: { enum: plans } },
        tuple: {
          type: "array",
          prefixItems: [{ type: "string" }, { type: "number" }],
          items: false,
        },
        notes: { type: "object", additionalProperties: { type: "string" } },
        grid: { type: "array", items: { type: "array", items: { type: "string" } } },
        both: {
          allOf: [
            {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
              additionalProperties: false,
            },
            {
              anyOf: [
                {
                  type: "object",
                  properties: { a: { type: "string" } },
                  required: ["a"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: { b: { type: "number" } },
                  required: ["b"],
                  additionalProperties: false,
                },
              ],
            },
          ],
        },
      },
      required: ["plan", "contact", "lines"],
      additionalProperties: false,
      $defs: { Plan: { enum: plans } },
    },
  },
];
