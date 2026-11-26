import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  registrationError,
  registrationFields,
  registrationsPath,
  registrationSummary,
  submitRegistrationPayload,
  type WireRegistration,
} from "../src/commands/whatsapp-registrations";
import { createTestServer } from "./support/http-server";
import { runCli } from "./support/run-cli";

const registration = (overrides: Partial<WireRegistration> = {}): WireRegistration => ({
  id: "treg_2eqcmea000000000",
  templateId: "tmpl_2eqcmea000000000",
  publicationId: "tpub_2eqcmea000000000",
  templateChannelVariantId: "tvar_2eqcmea000000000",
  target: { provider: "whatsapp", wabaId: "1234567890" },
  name: "order_shipped",
  language: "en_US",
  status: "submitted",
  pendingTemplateChannelVariantId: null,
  category: "utility",
  providerCategory: null,
  providerTemplateId: null,
  reason: null,
  submittedAt: "2026-10-13T00:00:00.000Z",
  statusChangedAt: "2026-10-13T00:00:00.000Z",
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
  ...overrides,
});

describe("registrationsPath", () => {
  it("addresses the collection and one registration", () => {
    expect(registrationsPath("tmpl_a")).toBe("/v1/templates/tmpl_a/registrations");
    expect(registrationsPath("tmpl_a", "treg_b")).toBe("/v1/templates/tmpl_a/registrations/treg_b");
  });
});

describe("submitRegistrationPayload", () => {
  it("names WhatsApp and the business account only when given", () => {
    expect(submitRegistrationPayload(undefined)).toEqual({ provider: "whatsapp" });
    expect(submitRegistrationPayload("waba_x")).toEqual({
      provider: "whatsapp",
      businessAccountId: "waba_x",
    });
  });
});

it("sends all reviewed registration values and refuses a partial approval locally", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "samva-cli-whatsapp-registration-"));
  const submitted = registration();
  const requests: Array<{ path: string | undefined; body: unknown }> = [];
  const server = createTestServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push({ path: request.url, body: JSON.parse(raw) });
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify(submitted));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test HTTP port");
    const cli = (args: ReadonlyArray<string>) =>
      runCli(["whatsapp", "templates", "submit", submitted.templateId, "--json", ...args], {
        configHome,
        env: {
          SAMVA_API_URL: `http://127.0.0.1:${address.port}`,
          SAMVA_API_KEY: "sk_test_registration",
        },
      });
    const incomplete = await cli(["--publication", submitted.publicationId]);
    expect(incomplete.code).toBe(2);
    expect(requests).toEqual([]);

    const businessAccountId = "waba_2eqcmea000000000";
    const submittedResult = await cli([
      "--publication",
      submitted.publicationId,
      "--business-account",
      businessAccountId,
      "--waba-id",
      "1234567890",
      "--workspace-revision",
      "12",
    ]);
    expect(submittedResult.code, submittedResult.stderr).toBe(0);
    expect(JSON.parse(submittedResult.stdout)).toMatchObject({ data: submitted });
    expect(requests).toEqual([
      {
        path: `/v1/templates/${submitted.templateId}/registrations`,
        body: {
          provider: "whatsapp",
          approval: {
            publicationId: submitted.publicationId,
            businessAccountId,
            expectedWabaId: "1234567890",
            expectedWorkspaceRevision: "12",
          },
        },
      },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(configHome, { recursive: true });
  }
});

describe("registrationFields", () => {
  it("leads with identity and status and carries Meta's reason", () => {
    const fields = registrationFields(registration({ status: "rejected", reason: "Bad variable" }));
    expect(fields.slice(0, 4).map(([label]) => label)).toEqual([
      "Registration ID",
      "Template ID",
      "Publication ID",
      "Status",
    ]);
    expect(fields).toContainEqual(["Reason", "Bad variable"]);
    expect(fields).toContainEqual(["Business account", "1234567890"]);
  });
});

describe("registrationSummary", () => {
  it("says when nothing was submitted", () => {
    expect(registrationSummary([])).toBe("not submitted");
  });

  it("says an approved registration a submission has not settled sends nothing", () => {
    const held = registration({ status: "approved", pendingTemplateChannelVariantId: "tvar_b" });
    expect(registrationSummary([held])).toBe(
      "approved, sending held until a submission settles (submit again)",
    );
    expect(registrationFields(held)).toContainEqual([
      "Status",
      "approved, sending held until a submission settles (submit again)",
    ]);
  });

  it("names each status with its reason", () => {
    expect(
      registrationSummary([
        registration({ status: "approved" }),
        registration({ status: "rejected", reason: "Bad variable" }),
      ]),
    ).toBe("approved; rejected (Bad variable)");
  });
});

describe("registrationError", () => {
  it("keeps Meta's reason and names the recovery step", () => {
    const error = registrationError("submit the template registration")({
      _tag: "ValidationError",
      message: "Meta refused the template: body has too many variables.",
    });
    expect(error.message).toBe("Meta refused the template: body has too many variables.");
    expect(error.api?.next).toContain("Meta's reason");
  });

  it("explains an unpublished or in-review template", () => {
    const error = registrationError("submit the template registration")({
      _tag: "ConflictError",
      message: "The template is not published.",
    });
    expect(error.api?.status).toBe(409);
    expect(error.api?.next).toContain("samva templates publish");
  });
});
