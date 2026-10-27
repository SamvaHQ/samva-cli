/**
 * The process boundary reads these two functions once per run: `processErrorCode`
 * decides the exit code an automation branches on, and `formatApiError` decides
 * the single stderr line a human reads. A regression in either is invisible to
 * command tests, so both are pinned here against errors the CLI really produces.
 */
import { describe, expect, it } from "@effect/vitest";
import { TemplateSourceError } from "@samva/core/templates/source-error";
import * as CliError from "effect/cli/CliError";
import * as Effect from "effect/Effect";
import { ConflictError, FlagDisabledError, ResourceNotFoundError } from "samva/effect";

import { messageLifecycleError, type MessageProjection } from "../src/commands/messages";
import { decodeStoredCredentials } from "../src/config/store";
import {
  CliConfigError,
  CliResultError,
  CliUsageError,
  formatApiError,
  formatErrorDetails,
  processErrorCode,
  processErrorReason,
  apiErrorGuidance,
  toCliApiError,
} from "../src/errors";
import { validateProcessArgs } from "../src/lib/runtime";

interface FormattingCase {
  readonly name: string;
  readonly prefix: string;
  readonly error: unknown;
  readonly expected: string;
}

/**
 * A fixed input/expected table. `formatApiError` walks a fallback ladder, so the
 * expected strings are written out rather than recomputed from the ladder.
 */
const formattingCases: ReadonlyArray<FormattingCase> = [
  {
    name: "a conflict keeps the server's own explanation",
    prefix: "Could not publish template",
    error: new ConflictError({
      message: "Template tmpl_0000000000000000 already has an identical publication",
      resource: "Template",
      id: "tmpl_0000000000000000",
    }),
    expected: "Template tmpl_0000000000000000 already has an identical publication",
  },
  {
    name: "a transport failure keeps the underlying Error message",
    prefix: "Could not list messages",
    error: new Error("socket hang up"),
    expected: "Could not list messages: socket hang up",
  },
  {
    name: "a non-object failure leaves the operation prefix alone",
    prefix: "Could not send email",
    error: "Internal Server Error",
    expected: "Could not send email",
  },
  {
    name: "a failure with no message field leaves the operation prefix alone",
    prefix: "Could not send email",
    error: { status: 503 },
    expected: "Could not send email",
  },
  {
    name: "a feature-gate refusal names the flag that refused the call",
    prefix: "Could not send message",
    error: new FlagDisabledError({
      flag: "sms",
      message:
        "Feature 'sms' is not enabled for your organization. Email support@samva.dev to request access.",
    }),
    expected:
      "Feature 'sms' is not enabled for your organization. Email support@samva.dev to request access.",
  },
  {
    name: "a tagged failure with no message text leaves the operation prefix alone",
    prefix: "Could not send email",
    error: new ConflictError({
      message: "",
      resource: "Message",
      id: null,
    }),
    expected: "Could not send email",
  },
];

/** A wait that timed out: the projection the CLI still holds when the deadline passes. */
const pendingMessage = (): MessageProjection => {
  const observedAt = new Date().toISOString();
  return {
    id: "msg_1234567890abcdefgh",
    channel: "email",
    status: "sent",
    from: "hello@example.com",
    conversationId: null,
    createdAt: observedAt,
    updatedAt: observedAt,
    deliveries: [{ status: "sent", recipient: "rcpt_1234567890abcdefgh" }],
    skippedRecipients: [],
    waitReason: null,
    reviewExpectedAt: null,
  };
};

describe("API error formatting", () => {
  it("retains resource identity from generated not-found errors", () => {
    const error = new ResourceNotFoundError({
      message: "Message 'msg_0000000000000000' not found. Call messages.list to find valid ids.",
      resource: "Message",
      id: "msg_0000000000000000",
    });

    expect(formatApiError("Could not get message", error)).toBe(error.message);
  });

  for (const formattingCase of formattingCases) {
    it(formattingCase.name, () => {
      expect(formatApiError(formattingCase.prefix, formattingCase.error)).toBe(
        formattingCase.expected,
      );
    });
  }
});

describe("process exit codes", () => {
  it("an unrecognized flag exits 2", () => {
    const error = new CliError.UnrecognizedOption({
      option: "--recipient",
      command: ["samva", "email", "send"],
      suggestions: ["--to"],
    });

    expect(processErrorCode(error)).toBe(2);
  });

  it.effect("asking for two output modes at once exits 2", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        validateProcessArgs(["messages", "list", "--json", "--quiet"]),
      );

      expect(error).toBeInstanceOf(CliUsageError);
      expect(processErrorCode(error)).toBe(2);
    }),
  );

  it.effect("an unreadable stored credential record exits 2", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeStoredCredentials("default", "{ not json"));

      expect(error).toBeInstanceOf(CliConfigError);
      expect(processErrorCode(error)).toBe(2);
    }),
  );

  it("a command that completed with an authoritative failure result exits 1", () => {
    const error = new CliResultError({
      code: "template_check_failed",
      message: "Template check failed (1 problem(s)).",
      result: { action: "templates.check", ok: false },
      human: "Template check failed (1 problem(s)).",
    });

    expect(processErrorCode(error)).toBe(1);
  });

  it("a message that never left its pending status exits 124", () => {
    const error = messageLifecycleError(
      "message_wait_timeout",
      "Timed out waiting for message msg_1234567890abcdefgh; it remains sent.",
      pendingMessage(),
    );

    expect(processErrorCode(error)).toBe(124);
  });

  it("a message that reached a terminal failure exits 1", () => {
    const error = messageLifecycleError(
      "message_terminal_failure",
      "Message msg_1234567890abcdefgh reached terminal status failed.",
      { ...pendingMessage(), status: "failed" },
    );

    expect(processErrorCode(error)).toBe(1);
  });

  it("an unrecognized failure exits 1", () => {
    expect(processErrorCode(new Error("socket hang up"))).toBe(1);
  });
});

describe("API recovery metadata", () => {
  it("preserves readonly compiler diagnostics through the command wrapper", () => {
    const diagnostics = [
      {
        code: "unsupported-element",
        severity: "error",
        message: "Use a supported email element.",
        origins: [
          { fileName: "emails/welcome.tsx", lineNumber: 12, columnNumber: 3 },
          { fileName: "components/card.tsx", lineNumber: 7, columnNumber: 5 },
        ],
      },
      { code: "no-template", severity: "error", message: "Declare a template.", origins: [] },
    ] as const;
    const error = toCliApiError(
      "Could not save workspace",
      new TemplateSourceError({ message: "Template source did not compile.", diagnostics }),
    );

    expect(error.message).toBe("Template source did not compile.");
    expect(processErrorReason(error)).toBe("TemplateSourceError");
    expect(processErrorCode(error)).toBe(1);
    expect(apiErrorGuidance(error)).toEqual({
      reason: "TemplateSourceError",
      status: 422,
      details: { diagnostics },
      next: "Fix the template source at the listed diagnostics, then save again.",
    });
    expect(formatErrorDetails(error)).toBe(
      "\n  emails/welcome.tsx:12:3 error unsupported-element: Use a supported email element." +
        "\n    via components/card.tsx:7:5" +
        "\n  Template source error no-template: Declare a template.",
    );
  });

  it("keeps internal diagnostics private while genuine conflicts retain their recovery step", () => {
    const error = toCliApiError("Could not save workspace", {
      _tag: "ConflictError",
      message: "The workspace revision moved.",
      resource: "TemplateProject",
      diagnostics: [{ secret: "private" }],
      diagnosticContext: "private",
    });

    expect(apiErrorGuidance(error)).toEqual({
      reason: "ConflictError",
      status: 409,
      details: { resource: "TemplateProject" },
      next: "Read the resource and resolve the conflict before retrying.",
    });
  });

  it("preserves the refused Save revision and asks the caller to reload before repairing", () => {
    const error = toCliApiError("Could not save workspace", {
      _tag: "TemplateSourceError",
      message: "Compilation refused",
      diagnostics: [],
      revision: "2",
    });
    expect(apiErrorGuidance(error)).toMatchObject({
      details: { diagnostics: [], revision: "2" },
      next: "Reload the template workspace at the returned revision, fix the source at the listed diagnostics, then save again.",
    });
  });

  it("filters runtime diagnostics even beside public compiler findings", () => {
    const error = toCliApiError("Could not save workspace", {
      _tag: "TemplateSourceError",
      message: "Template source did not compile.",
      diagnostics: [],
      diagnosticContext: { secret: "private" },
      cause: "private",
      _internal: "private",
    });
    expect(apiErrorGuidance(error)?.details).toEqual({ diagnostics: [] });
  });

  it("keeps validation paths through the command wrapper", () => {
    const error = toCliApiError("Could not send", {
      _tag: "ValidationError",
      message: "Invalid request",
      fields: { "email.to": "Expected string" },
      cause: new Error("private"),
    });
    expect(error.message).toBe("Invalid request");
    expect(processErrorReason(error)).toBe("ValidationError");
    expect(apiErrorGuidance(error)).toMatchObject({
      status: 422,
      details: { fields: { "email.to": "Expected string" } },
    });
    expect(apiErrorGuidance(error)?.details).not.toHaveProperty("cause");
  });
  it("names the verified domains for FromAddressRequiredError", () => {
    const error = toCliApiError("Could not send", {
      _tag: "FromAddressRequiredError",
      message: "No default sender for this organization.",
      verifiedDomains: ["acme.test"],
    });
    expect(apiErrorGuidance(error)).toMatchObject({
      status: 422,
      details: { verifiedDomains: ["acme.test"] },
      next: "Pass --from with an address on acme.test, or add a sender there and run samva email senders set-default.",
    });
    expect(
      apiErrorGuidance(
        toCliApiError("Could not send", {
          _tag: "FromAddressRequiredError",
          message: "Cannot resolve `from`.",
          verifiedDomains: [],
        }),
      )?.next,
    ).toContain("Verify a domain or a sender");
  });
  it.each(["UnauthorizedError", "ForbiddenError"])("uses auth exit code for %s", (tag) => {
    expect(
      processErrorCode(
        toCliApiError("Could not read", { _tag: tag, message: "Credential refused" }),
      ),
    ).toBe(4);
  });
});
