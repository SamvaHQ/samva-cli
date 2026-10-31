import { MailboxNeedsYou } from "@samva/core/mailboxes/needs-you";
import { Mailbox } from "@samva/core/mailboxes/resource";
import { MailboxSendReceipt } from "@samva/core/mailboxes/send";
import {
  MailboxMessage,
  MailboxThreadSummary,
  OrganizationMailboxThreadSummary,
} from "@samva/core/mailboxes/thread";
import { CursorPage } from "@samva/core/shared/cursor";
import { Effect, Schema } from "effect";

import { SamvaCliError } from "../errors";
import { getAuthenticatedJson, postAuthenticatedJson } from "./client";
import { mailboxApiError } from "./mailbox-errors";

// The public SDK publishes email mailboxes only, because WhatsApp and SMS endpoints, threads, and
// sends are staged behind launch flags. A command that reads a mailbox, its threads, or a message,
// or that creates a phone endpoint or sends on a phone channel, therefore calls the API directly
// with the CLI's credentials and reads the answer with the core schemas, in wire form.

const WireMailbox = Schema.toEncoded(Mailbox);
export type WireMailbox = typeof WireMailbox.Type;
export type WireEndpoint = WireMailbox["endpoints"][number];
const WireReceipt = Schema.toEncoded(MailboxSendReceipt);
export type WireReceipt = typeof WireReceipt.Type;
const WireThreadPage = Schema.toEncoded(CursorPage(MailboxThreadSummary));
export type WireThread = (typeof WireThreadPage.Type)["items"][number];
const WireMessage = Schema.toEncoded(MailboxMessage);
export type WireMessage = typeof WireMessage.Type;

const unreadable = (what: string) => () =>
  new SamvaCliError({ message: `The API answered with an unreadable ${what}.` });

/** `GET` a mailbox resource; the answer is the API's JSON, undecoded. */
export const getMailboxJson = (prefix: string, path: string) =>
  getAuthenticatedJson(path).pipe(Effect.mapError((e) => mailboxApiError(prefix, e)));

/** `POST` JSON to a mailbox resource; the answer is the API's JSON, undecoded. */
export const postMailboxJson = (
  prefix: string,
  path: string,
  body: unknown,
  headers?: Readonly<Record<string, string>>,
) =>
  postAuthenticatedJson(path, { body, ...(headers === undefined ? {} : { headers }) }).pipe(
    Effect.mapError((e) => mailboxApiError(prefix, e)),
  );

const decoder =
  <S extends Schema.Decoder<unknown>>(schema: S, what: string) =>
  (raw: unknown) =>
    Schema.decodeUnknownEffect(schema)(raw).pipe(Effect.mapError(unreadable(what)));

export const decodeMailbox = decoder(WireMailbox, "mailbox");
export const decodeReceipt = decoder(WireReceipt, "send receipt");
export const decodeThreadPage = decoder(WireThreadPage, "thread page");
export const decodeMessage = decoder(WireMessage, "message");

export const decodeOrganizationThreadPage = decoder(
  Schema.toEncoded(CursorPage(OrganizationMailboxThreadSummary)),
  "organization thread page",
);

export const decodeNeedsYou = decoder(Schema.toEncoded(MailboxNeedsYou), "needs-you page");
