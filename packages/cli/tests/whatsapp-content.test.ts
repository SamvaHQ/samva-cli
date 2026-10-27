import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { whatsappContentPayload } from "../src/commands/whatsapp";
import {
  parseWhatsappButton,
  parseWhatsappContent,
  resolveWhatsappContent,
  type WhatsAppContentFlags,
} from "../src/commands/whatsapp-content";

const none: WhatsAppContentFlags = {
  text: undefined,
  template: undefined,
  data: undefined,
  content: undefined,
  mediaUrl: undefined,
  mediaType: undefined,
  caption: undefined,
  filename: undefined,
  body: undefined,
  buttons: [],
  footer: undefined,
  react: undefined,
  emoji: undefined,
  flow: undefined,
  cta: undefined,
  flowScreen: undefined,
  flowData: undefined,
  flowToken: undefined,
  flowAction: undefined,
};

const resolve = (flags: Partial<WhatsAppContentFlags>) =>
  Effect.runPromise(
    Effect.result(resolveWhatsappContent({ ...none, ...flags })).pipe(
      Effect.provide(BunServices.layer),
    ),
  );

describe("resolveWhatsappContent", () => {
  it("builds each convenience source", async () => {
    expect(await resolve({ text: "Hi" })).toMatchObject({ success: { text: "Hi" } });
    expect(
      await resolve({ template: "tmpl_2eqcmea000000000", data: '{"orderNumber":"A-1"}' }),
    ).toMatchObject({
      success: { templateId: "tmpl_2eqcmea000000000", templateData: { orderNumber: "A-1" } },
    });
    expect(await resolve({ template: "order-shipped" })).toMatchObject({
      success: { templateSlug: "order-shipped" },
    });
    expect(await resolve({ template: "booking-invite", flowToken: "booking-4821" })).toEqual({
      success: { templateSlug: "booking-invite", flowToken: "booking-4821" },
    });
    expect(
      await resolve({ template: "tmpl_2eqcmea000000000", data: '{"a":"b"}', flowToken: "t" }),
    ).toEqual({
      success: { templateId: "tmpl_2eqcmea000000000", templateData: { a: "b" }, flowToken: "t" },
    });
    expect(
      await resolve({
        mediaUrl: "https://example.com/receipt.pdf",
        mediaType: "document",
        caption: "Your receipt",
        filename: "receipt.pdf",
      }),
    ).toMatchObject({
      success: {
        media: {
          type: "document",
          url: "https://example.com/receipt.pdf",
          caption: "Your receipt",
          filename: "receipt.pdf",
        },
      },
    });
    expect(
      await resolve({
        body: "Ship it today?",
        buttons: ["yes:Yes", "later:Not: yet"],
        footer: "Reply anytime",
      }),
    ).toMatchObject({
      success: {
        interactive: {
          type: "buttons",
          body: "Ship it today?",
          footer: "Reply anytime",
          buttons: [
            { id: "yes", title: "Yes" },
            { id: "later", title: "Not: yet" },
          ],
        },
      },
    });
    expect(await resolve({ react: "msg_01j8k3m5n7p9q2r4s6tv", emoji: "👍" })).toMatchObject({
      success: { reaction: { messageId: "msg_01j8k3m5n7p9q2r4s6tv", emoji: "👍" } },
    });
  });

  it("passes --content through verbatim, inline or from a file", async () => {
    const list = { interactive: { type: "list", body: "Pick", button: "Open", sections: [] } };
    expect(await resolve({ content: JSON.stringify(list) })).toMatchObject({ success: list });
    const dir = mkdtempSync(join(tmpdir(), "samva-whatsapp-content-"));
    const file = join(dir, "message.json");
    writeFileSync(file, JSON.stringify({ location: { latitude: 1, longitude: 2 } }));
    expect(await resolve({ content: `@${file}` })).toMatchObject({
      success: { location: { latitude: 1, longitude: 2 } },
    });
  });

  it("requires exactly one content source", async () => {
    expect(await resolve({})).toMatchObject({ failure: { code: "missing_content" } });
    expect(await resolve({ text: "Hi", template: "order" })).toMatchObject({
      failure: {
        code: "multiple_content_sources",
        message: "Provide exactly one content source; got --text and --template.",
      },
    });
    expect(
      await resolve({ content: "{}", body: "Pick", buttons: ["a:A"], react: "msg_x", emoji: "👍" }),
    ).toMatchObject({ failure: { code: "multiple_content_sources" } });
  });

  it("refuses a companion flag without its source", async () => {
    const cases: ReadonlyArray<readonly [Partial<WhatsAppContentFlags>, string]> = [
      [{ text: "Hi", data: "{}" }, "--data applies only with --template."],
      [{ text: "Hi", caption: "c" }, "--caption applies only with --media-url."],
      [{ text: "Hi", mediaType: "image" }, "--media-type applies only with --media-url."],
      [{ text: "Hi", filename: "a.pdf" }, "--filename applies only with --media-url."],
      [{ text: "Hi", footer: "f" }, "--footer applies only with --body and --button, or --flow."],
      [{ text: "Hi", emoji: "👍" }, "--emoji applies only with --react."],
      [{ footer: "f" }, "--footer applies only with --body and --button, or --flow."],
    ];
    for (const [flags, message] of cases) {
      expect(await resolve(flags)).toMatchObject({
        failure: { code: "flag_without_source", message },
      });
    }
  });

  it("validates each source's own flags", async () => {
    expect(await resolve({ mediaUrl: "https://example.com/a.png" })).toMatchObject({
      failure: { code: "missing_media_type" },
    });
    expect(
      await resolve({ mediaUrl: "https://example.com/a.mp3", mediaType: "audio", caption: "c" }),
    ).toMatchObject({ failure: { code: "caption_not_supported" } });
    expect(
      await resolve({ mediaUrl: "https://example.com/a.png", mediaType: "image", filename: "a" }),
    ).toMatchObject({ failure: { code: "filename_not_supported" } });
    expect(await resolve({ react: "msg_x" })).toMatchObject({ failure: { code: "missing_emoji" } });
    expect(await resolve({ buttons: ["a:A"] })).toMatchObject({
      failure: { code: "missing_body" },
    });
    expect(await resolve({ body: "Pick" })).toMatchObject({
      failure: { code: "invalid_button_count" },
    });
    expect(await resolve({ body: "Pick", buttons: ["a:A", "b:B", "c:C", "d:D"] })).toMatchObject({
      failure: { code: "invalid_button_count" },
    });
    expect(await resolve({ text: "   " })).toMatchObject({ failure: { code: "empty_text" } });
    expect(await resolve({ template: "order", data: "[1]" })).toMatchObject({
      failure: { message: "--data must be a JSON object." },
    });
  });

  it("builds a flow message from --flow, --cta, and --body", async () => {
    expect(await resolve({ flow: "waflow_abc", cta: "Book now", body: "Pick a time" })).toEqual({
      success: {
        interactive: { type: "flow", body: "Pick a time", flowId: "waflow_abc", cta: "Book now" },
      },
    });
    expect(
      await resolve({
        flow: "waflow_abc",
        cta: "Book",
        body: "Pick",
        footer: "Thanks",
        flowToken: "tok",
        flowScreen: "DETAILS",
        flowData: '{"plan":"pro"}',
      }),
    ).toEqual({
      success: {
        interactive: {
          type: "flow",
          body: "Pick",
          footer: "Thanks",
          flowId: "waflow_abc",
          cta: "Book",
          token: "tok",
          screen: "DETAILS",
          data: { plan: "pro" },
        },
      },
    });
  });

  it("carries --flow-action and refuses data_exchange with a screen or data", async () => {
    expect(
      await resolve({
        flow: "waflow_abc",
        cta: "Go",
        body: "Pick",
        flowAction: "data_exchange",
      }),
    ).toEqual({
      success: {
        interactive: {
          type: "flow",
          body: "Pick",
          flowId: "waflow_abc",
          cta: "Go",
          action: "data_exchange",
        },
      },
    });
    expect(
      await resolve({
        flow: "waflow_abc",
        cta: "Go",
        body: "Pick",
        flowAction: "navigate",
        flowScreen: "A",
        flowData: '{"a":1}',
      }),
    ).toMatchObject({
      success: { interactive: { action: "navigate", screen: "A", data: { a: 1 } } },
    });
    for (const extra of [{ flowScreen: "A" }, { flowData: '{"a":1}', flowScreen: "A" }]) {
      expect(
        await resolve({
          flow: "waflow_abc",
          cta: "Go",
          body: "Pick",
          flowAction: "data_exchange",
          ...extra,
        }),
      ).toMatchObject({ failure: { code: "flow_data_exchange_with_screen" } });
    }
    expect(await resolve({ text: "Hi", flowAction: "navigate" })).toMatchObject({
      failure: { message: "--flow-action applies only with --flow." },
    });
  });

  it("keeps --flow exclusive and complete", async () => {
    expect(
      await resolve({ flow: "waflow_abc", cta: "Go", body: "Pick", text: "Hi" }),
    ).toMatchObject({ failure: { code: "multiple_content_sources" } });
    expect(
      await resolve({ flow: "waflow_abc", cta: "Go", body: "Pick", buttons: ["a:A"] }),
    ).toMatchObject({ failure: { code: "multiple_content_sources" } });
    expect(await resolve({ flow: "waflow_abc", body: "Pick" })).toMatchObject({
      failure: { code: "missing_cta" },
    });
    expect(await resolve({ flow: "waflow_abc", cta: "Go" })).toMatchObject({
      failure: { code: "missing_body" },
    });
    expect(
      await resolve({ flow: "waflow_abc", cta: "Go", body: "Pick", flowData: "{}" }),
    ).toMatchObject({ failure: { code: "flow_data_without_screen" } });
    expect(
      await resolve({
        flow: "waflow_abc",
        cta: "Go",
        body: "Pick",
        flowScreen: "A",
        flowData: "[1]",
      }),
    ).toMatchObject({ failure: { message: "--flow-data must be a JSON object." } });
    // A flow token is for a flow message or a template send, never alongside another source.
    expect(await resolve({ template: "order", flow: "waflow_abc", flowToken: "t" })).toMatchObject({
      failure: { code: "multiple_content_sources" },
    });
    expect(await resolve({ flowToken: "t" })).toMatchObject({
      failure: {
        code: "flag_without_source",
        message: "--flow-token applies only with --flow or --template.",
      },
    });
    for (const [flags, message] of [
      [{ text: "Hi", cta: "Go" }, "--cta applies only with --flow."],
      [{ text: "Hi", flowScreen: "A" }, "--flow-screen applies only with --flow."],
      [{ text: "Hi", flowData: "{}" }, "--flow-data applies only with --flow."],
      [{ text: "Hi", flowToken: "t" }, "--flow-token applies only with --flow or --template."],
    ] as const) {
      expect(await resolve(flags)).toMatchObject({
        failure: { code: "flag_without_source", message },
      });
    }
  });

  it("names an unreadable --content source", async () => {
    expect(await resolve({ content: "@/nonexistent/samva-message.json" })).toMatchObject({
      failure: { code: "content_file_unreadable" },
    });
    expect(await resolve({ content: "@" })).toMatchObject({
      failure: { code: "missing_content_file" },
    });
  });
});

describe("parseWhatsappContent", () => {
  it("accepts a JSON object and refuses everything else", () => {
    const run = (raw: string) => Effect.runSync(Effect.result(parseWhatsappContent(raw)));
    expect(run('{"text":"Hi"}')).toMatchObject({ success: { text: "Hi" } });
    for (const raw of ["nope", "[1]", "3", "null"]) {
      expect(run(raw)).toMatchObject({ failure: { code: "invalid_content" } });
    }
  });
});

describe("parseWhatsappButton", () => {
  it("splits at the first colon", () => {
    const run = (raw: string) => Effect.runSync(Effect.result(parseWhatsappButton(raw)));
    expect(run("yes:Yes")).toMatchObject({ success: { id: "yes", title: "Yes" } });
    expect(run("a:b:c")).toMatchObject({ success: { id: "a", title: "b:c" } });
    for (const raw of ["yes", ":Yes", "yes:", " : "]) {
      expect(run(raw)).toMatchObject({ failure: { code: "invalid_whatsapp_button" } });
    }
  });
});

describe("whatsappContentPayload", () => {
  it("addresses one WhatsApp identity with the content verbatim", () => {
    expect(whatsappContentPayload("+14155550123", { text: "Hi" })).toEqual({
      channel: "whatsapp",
      to: [{ phone: "+14155550123" }],
      whatsapp: { text: "Hi" },
    });
  });
});
