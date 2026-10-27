import { describe, expect, it } from "@effect/vitest";
import { FlagDisabledError } from "samva/effect";

import {
  createFlowPayload,
  ENCRYPTION_KEY_ROTATE_PATH,
  flowEncryptionKeyFields,
  flowEndpointFields,
  flowError,
  flowFields,
  flowVersionFields,
  rotateEncryptionKeyPayload,
  setEndpointPayload,
  flowRegistrationFields,
  flowsPath,
  registerFlowPayload,
  type WireFlow,
  type WireFlowRegistration,
  type WireFlowVersion,
} from "../src/commands/whatsapp-flows";

const flow = (overrides: Partial<WireFlow> = {}): WireFlow => ({
  id: "waflow_2eqcmea000000000",
  projectId: "tproj_2eqcmea000000000",
  handle: "appointment",
  path: "flows/appointment.json",
  categories: ["APPOINTMENT_BOOKING", "LEAD_GENERATION"],
  endpoint: null,
  currentVersion: null,
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
  ...overrides,
});

const registration = (overrides: Partial<WireFlowRegistration> = {}): WireFlowRegistration => ({
  id: "wafreg_2eqcmea000000000",
  flowId: "waflow_2eqcmea000000000",
  versionId: "waflowv_2eqcmea000000000",
  versionNumber: 2,
  wabaId: "1234567890",
  providerFlowId: "9876543210",
  name: "appointment v2",
  status: "draft",
  validationErrors: [],
  endpointAlerts: [],
  publishedAt: null,
  statusChangedAt: "2026-10-17T00:00:00.000Z",
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
  ...overrides,
});

describe("flowsPath", () => {
  it("addresses the collection, one flow, and its sub-resources", () => {
    expect(flowsPath()).toBe("/v1/whatsapp/flows");
    expect(flowsPath("waflow_a")).toBe("/v1/whatsapp/flows/waflow_a");
    expect(flowsPath("waflow_a", "versions")).toBe("/v1/whatsapp/flows/waflow_a/versions");
    expect(flowsPath("waflow_a", "registrations")).toBe(
      "/v1/whatsapp/flows/waflow_a/registrations",
    );
  });
});

describe("endpoint paths and payloads", () => {
  it("addresses the endpoint and its secret rotation", () => {
    expect(flowsPath("waflow_a", "endpoint")).toBe("/v1/whatsapp/flows/waflow_a/endpoint");
    expect(flowsPath("waflow_a", "endpoint/rotate-secret")).toBe(
      "/v1/whatsapp/flows/waflow_a/endpoint/rotate-secret",
    );
    expect(ENCRYPTION_KEY_ROTATE_PATH).toBe("/v1/whatsapp/flows/encryption-key/rotate");
  });

  it("carries the url, and the business account only when named", () => {
    expect(setEndpointPayload("https://example.com/flows")).toEqual({
      url: "https://example.com/flows",
    });
    expect(rotateEncryptionKeyPayload(undefined)).toEqual({});
    expect(rotateEncryptionKeyPayload("waba_a")).toEqual({ businessAccountId: "waba_a" });
  });
});

describe("endpoint output", () => {
  it("shows the endpoint on a flow, or how to set one", () => {
    expect(flowFields(flow()).find(([label]) => label === "Endpoint")?.[1]).toContain(
      "flows endpoint set",
    );
    expect(
      flowFields(
        flow({
          endpoint: { url: "https://example.com/flows", updatedAt: "2026-10-18T00:00:00.000Z" },
        }),
      ).find(([label]) => label === "Endpoint")?.[1],
    ).toBe("https://example.com/flows (updated 2026-10-18T00:00:00.000Z)");
  });

  it("flags a data-exchange version", () => {
    const version = {
      id: "waflowv_2eqcmea000000000",
      flowId: "waflow_2eqcmea000000000",
      number: 1,
      commitSha: "a".repeat(40),
      digest: `sha256:${"b".repeat(64)}`,
      jsonVersion: "7.3",
      screens: ["WELCOME"],
      dataExchange: true,
      createdAt: "2026-10-17T00:00:00.000Z",
    } as WireFlowVersion;
    expect(flowVersionFields(version).find(([label]) => label === "Data exchange")?.[1]).toContain(
      "yes",
    );
    expect(
      flowVersionFields({ ...version, dataExchange: false }).find(
        ([label]) => label === "Data exchange",
      )?.[1],
    ).toBe("no");
  });

  it("lists each endpoint alert on a registration", () => {
    const fields = flowRegistrationFields(
      registration({
        endpointAlerts: [
          {
            kind: "ENDPOINT_LATENCY",
            message: "p90 too slow",
            value: 6200,
            threshold: 5000,
            activatedAt: "2026-10-18T00:00:00.000Z",
          },
          {
            kind: "CLIENT_ERROR_RATE",
            message: "Clients fail",
            value: null,
            threshold: null,
            activatedAt: "2026-10-18T01:00:00.000Z",
          },
        ],
      }),
    );
    expect(fields).toContainEqual([
      "Alert",
      "ENDPOINT_LATENCY: p90 too slow (6200 against 5000) since 2026-10-18T00:00:00.000Z",
    ]);
    expect(fields).toContainEqual([
      "Alert",
      "CLIENT_ERROR_RATE: Clients fail since 2026-10-18T01:00:00.000Z",
    ]);
  });

  it("prints the endpoint and the rotated key", () => {
    expect(
      flowEndpointFields({
        url: "https://example.com/flows",
        updatedAt: "2026-10-18T00:00:00.000Z",
      }),
    ).toEqual([
      ["Endpoint", "https://example.com/flows"],
      ["Updated", "2026-10-18T00:00:00.000Z"],
    ]);
    expect(
      flowEncryptionKeyFields({
        wabaId: "1234567890",
        publicKey: "-----BEGIN PUBLIC KEY-----",
        phoneNumberIds: ["111", "222"],
        createdAt: "2026-10-18T00:00:00.000Z",
      }),
    ).toContainEqual(["Numbers updated", "111, 222"]);
  });
});

describe("payloads", () => {
  it("carries the create fields", () => {
    expect(createFlowPayload("tproj_a", "appointment", ["OTHER"])).toEqual({
      projectId: "tproj_a",
      handle: "appointment",
      categories: ["OTHER"],
    });
  });

  it("names the business account only when given", () => {
    expect(registerFlowPayload(undefined)).toEqual({});
    expect(registerFlowPayload("1234567890")).toEqual({ businessAccountId: "1234567890" });
  });
});

describe("flowFields", () => {
  it("says when no version is recorded and names the current one after", () => {
    expect(flowFields(flow())).toContainEqual([
      "Current version",
      "none (record one with `samva whatsapp flows publish`)",
    ]);
    expect(flowFields(flow()).find(([label]) => label === "Categories")?.[1]).toBe(
      "APPOINTMENT_BOOKING, LEAD_GENERATION",
    );
    expect(
      flowFields(
        flow({
          currentVersion: {
            id: "waflowv_2eqcmea000000000",
            flowId: "waflow_2eqcmea000000000",
            number: 3,
            commitSha: "a".repeat(40),
            digest: `sha256:${"b".repeat(64)}`,
            jsonVersion: "7.3",
            screens: ["WELCOME"],
            createdAt: "2026-10-17T00:00:00.000Z",
          } as WireFlow["currentVersion"] & object,
        }),
      ),
    ).toContainEqual(["Current version", `v3 at ${"a".repeat(40)}`]);
  });
});

describe("flowRegistrationFields", () => {
  it("lists each validation finding Meta gave", () => {
    const fields = flowRegistrationFields(
      registration({
        validationErrors: [
          { error: "INVALID_PROPERTY_VALUE", message: "Bad value", path: "$.screens[0]" },
          { error: "MISSING_PROPERTY", message: "Missing id" },
        ],
      }),
    );
    expect(fields).toContainEqual(["Status", "draft"]);
    expect(fields).toContainEqual([
      "Validation",
      "INVALID_PROPERTY_VALUE: Bad value ($.screens[0])",
    ]);
    expect(fields).toContainEqual(["Validation", "MISSING_PROPERTY: Missing id"]);
  });
});

describe("flowError", () => {
  it("keeps Meta's reason and names the recovery step", () => {
    const error = flowError("register the flow")({
      _tag: "ValidationError",
      message: "Meta refused the flow: INVALID_PROPERTY_VALUE.",
    });
    expect(error.message).toBe("Meta refused the flow: INVALID_PROPERTY_VALUE.");
    expect(error.api?.next).toContain("Flow JSON");
  });

  it("names a handle clash or a stale workspace", () => {
    const error = flowError("create the flow")({ _tag: "ConflictError", message: "Taken." });
    expect(error.api?.status).toBe(409);
    expect(error.api?.next).toContain("unique");
  });

  it("names a disabled channel", () => {
    const error = flowError("list flows")(
      new FlagDisabledError({ flag: "whatsapp", message: "Feature 'whatsapp' is not enabled." }),
    );
    expect(error.api?.next).toBe("WhatsApp is not enabled for this organization.");
  });
});
