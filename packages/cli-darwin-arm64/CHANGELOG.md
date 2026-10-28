## @samva/cli-darwin-arm64@0.28.0

### One Idempotency Option Across the SDK

**Breaking:** Pass idempotency keys in the second options argument as `{ idempotencyKey }`.
Raw HTTP callers send `Idempotency-Key`; body and query spellings are removed. Both clients
supply a fresh key for every idempotent operation and reuse it across automatic retries.

The Promise client retries reads and idempotent mutations, accepts client-level and per-call
`maxRetries`, and adds lazy `.pages()` and `.items()` async iterators to cursor lists.
OAuth clients can select an organization with `orgSlug`.

**Breaking:** Import mailbox extension helpers from `samva/mailbox`, `samva/mailbox/test`, and
`samva/mailbox/webhook`. Handlers receive the normal client and call
`ctx.samva.mailboxes.reply({ id, messageId, text })`. Event dispatch preserves deterministic
send keys. The CLI extension scaffold uses these imports and flat calls.

For `samva events send`, pass `--idempotency-key` instead of embedding a key in `--data`.

### Templates build with authoring 0.22.0

`samva templates` commands bundle `@samva/markup` and `@samva/vite` 0.22.0. Issue layouts can place the issue's title and date with `<IssueTitle />` and `<IssueDate />`; `IssueDate` reads an optional `date: YYYY-MM-DD` frontmatter field. Output for existing templates is unchanged.

## @samva/cli-darwin-arm64@0.27.0

### Author newsletter issues and pin saved content to campaigns

The SDK adds `topicIssues` on the Promise client and `TopicIssues` at
`samva/effect/topic-issues`. The CLI adds `samva topics issues` for creating and editing Markdown
issues, checking and previewing email or web output, and saving commits. Listing issues returns
each draft's title and its latest campaign send, and needs messages read access beside contacts
read access. Issue authoring is Preview and requires access for your organization.

Campaigns accept `content.issue: { path, commit }` with `audience.topicId` to select a saved issue.
The saved title and preheader supply the email content, and each run keeps its selected path and
commit. Use the CLI's `--issue-path` and `--issue-commit` options to select that content.

### Use SML 0.21 for template projects

Update your project's `@samva/markup` and `@samva/vite` packages to 0.21.0. Compiled templates use
`sml: 2`; direct renderer calls select output with `{ target: "email" }` instead of
`{ channel: "email" }`.

### Publish sent newsletter issues on the web

Publication sites are Preview and available to selected organizations. Enable an opt-in topic's
archive with `archiveEnabled` and choose its `<publicationSlug>.samva.app` hostname. Sent issues
appear in the archive, RSS feed and sitemap; saving a draft does not publish it.

The SDK adds `topicPublicationDomains` on the Promise client and `TopicPublicationDomains` at
`samva/effect/publication-domains` to add, inspect and remove custom publication domains. The CLI
adds `--archive enabled|disabled` and `--publication-slug <label|none>` to topic settings.

Email sent with publication Preview access includes a private view-in-browser link to that
delivery's frozen content. Compiled templates must support SML's web renderer; raw API HTML and
text are also supported.

## @samva/cli-darwin-arm64@0.26.1

### Open every package README by saying what Samva is

The `samva`, `@samva/webhooks`, `@samva/cli`, native CLI, and `@samva/mailbox` READMEs now open
with a one-line description of Samva. `@samva/cli` describes itself as an email tool and drops the
`cpaas` and `messaging` keywords.

## @samva/cli-darwin-arm64@0.26.0

### Subscribe contacts to topics

**Breaking:** Topics replace unsubscribe groups. Use `client.topics` (Effect: `samva/effect/topics`),
`audience.topicId` on campaigns, and `topicId` when requesting a confirmation email. Set each
contact's `subscribed` or `unsubscribed` status per topic and channel with `topics.setSubscriptions`.
Existing opt-outs carry over, and `opt_in` topics reach only subscribed contacts.

- Webhooks: subscription events carry `topicId`, `topicName`, and `channel` instead of group fields.
  Skipped-recipient receipts report `topic-unsubscribe` with a `topicId`, in the SDKs and in mailbox
  extensions.
- CLI: manage topics with `samva topics`. `samva subscriptions subscribe` requires `--topic-id`; the
  contact-group and unsubscribe-group flags are removed.
- Confirmation: a confirmation request creates the contact only once the recipient confirms.
  Outstanding confirmation links that named no unsubscribe group no longer work.

### Handle template build failures as `TemplateSourceError`

**Breaking:** When a template's source fails to build, saving, opening, publishing, or restoring a
workspace fails with `TemplateSourceError` (HTTP `422`) instead of `ConflictError` (`409`). Catch
`TemplateSourceError` wherever you caught `ConflictError` to read build findings. It is a
validation error and not retryable; the Effect client exports it from `samva/effect/errors`.

Its `diagnostics` hold the compiler's findings, each with a code, severity, and `origins` locations;
a failure with no location is a single `sml/build-failed` finding. If a save pulled in an outside
commit before the build failed, the error includes `revision`: reload the workspace, fix the
source, and retry. `ConflictError` now means only a real conflict, such as a moved branch head, a
save already in progress, or a reused idempotency key.

The CLI prints each finding's location and how to fix it. `--json` and `--jsonl` include every
finding in `details.diagnostics` and the next step in `next`.

### Pass query values as numbers and booleans

**Breaking:** Query parameters take numbers and booleans instead of strings, in both SDKs and
`@samva/mailbox`: for example `limit: 20`, `urlExpiresIn: 60`, `isActive: false`, `sendable: true`,
`shared: true`, and the mailbox `unread`, `starred`, and `snoozed` filters. Replace values such as
`limit: "20"`.

A call whose body has only optional fields no longer needs one. `campaigns.scheduleRun({ id })`
schedules a run with its defaults, and the Effect `Organizations.update()` and
`Email.updateTrackingDefaults()` send `{}`. CLI flags are unchanged.

### Import subscriber lists as a background job

**Breaking:** `contacts.bulkImport` is removed. Plan an import with `contacts.planImport`, start it
with `contacts.startImport` using the plan's preview hash and an idempotency key, and follow it with
`contacts.getImportJob`. Imports run as a background job instead of returning per-contact results.
List import is in Preview and must be enabled for your organization.

Import related beehiiv, Substack, Kit, or Mailchimp exports together. When files disagree about a
contact, the most restrictive status wins, and reimports keep existing unsubscribes, suppressions,
and bounces. Contact detail shows which import a contact came from.

In the CLI, preview with `samva contacts import --preset --topic --file EVIDENCE=PATH --dry-run`,
start with an idempotency key, follow progress with `samva contacts import-status`, and resume an
eligible failed job with `samva contacts import-resume`.

### Read a campaign run's results

`campaigns.getRunReport` and `samva campaigns report <campaignId> <runId>` return a run's delivery
outcomes, replies, topic unsubscribes, and skipped recipients, counted once per recipient. Opens and
clicks are marked directional and leave out those classified as automated.

### Download the CLI from GitHub

Each release on [SamvaHQ/samva-cli](https://github.com/SamvaHQ/samva-cli) attaches the native
`samva` executable for macOS and Linux on arm64 and x64, with a `SHA256SUMS` file, so you can
install without npm. The repository is a read-only mirror of the CLI's source, updated with each
release. The npm `repository` and `bugs` links point there; report problems as issues on it.

### Every agent draws AI credits

**Breaking:** Organization usage no longer has a Standard allowance: `standardGranted`,
`standardRemaining`, and `standardResetsAt` are removed, and `samva org usage` no longer prints
them. Every agent draws the plan's monthly AI credits instead. Show the balance from
`includedAiCredits`, `usedAiCredits`, `aiPackCredits`, and `aiResetsAt`.

## @samva/cli-darwin-arm64@0.25.0

### Set custom headers with `samva email send --header`

`samva email send --header 'Name: Value'` (repeatable) sets `email.headers`. The name is the text
before the first colon and the value is the rest. A pair with no colon, no name, or no value is
rejected before the request. The API rejects reserved names and headers past its limits.

## @samva/cli-darwin-arm64@0.24.0

### Update the CLI's embedded Bun runtime

Build native CLI releases with Bun 1.4.4, which rejects certificate chains containing the compromised eMudhra public keys.

## @samva/cli-darwin-arm64@0.23.0

### Choose the sender with `--from`

`samva email send` and `samva scheduled-messages create` take `--from <address>` and an optional
`--from-name`. The address can be a verified sender or any address on a verified domain. Without
`--from`, the send uses your default sender, else your only verified sender.

### A send with no default sender says which addresses you can use

When a send omits `from` and no default sender applies, the API now answers `FromAddressRequiredError`
(`422`) with the verified domains you can send from. The CLI prints them and suggests passing `--from`
with an address on one of them, or adding a sender there and running
`samva email senders set-default`. Before, an organization that already had a verified domain was
told to add one.

## @samva/cli-darwin-arm64@0.22.2

### Clear errors when a template project is on another authoring release

`samva templates check` and `samva templates dev` now check your project's `@samva/markup` and
`@samva/vite` before running anything. A project on another release line than your CLI stops with
the version it found, the line the CLI drives, and the `npm install` command that updates it.
Before, `check` could report only TypeScript errors and `dev` could fail inside the compiler.

### Register a template without building the project

`samva templates add templates/reset.tsx` reads the `defineTemplate` id from the file, so it no
longer builds the whole project first. It still builds when the id is not written as a string
literal in the one `defineTemplate` call.

### More helpful template findings

A `missing-asset-base` finding names the origin Samva serves a published template's assets from,
so `--asset-base https://cdn.samva.dev` checks a Samva project as it publishes. A `no-template`
finding on a partial, such as a file under `templates/blocks/`, says to render a template that
imports it.

## @samva/cli-darwin-arm64@0.22.1

### `--help --json` describes the command instead of crashing

`samva <command> --help --json` and `--jsonl` print one result envelope on stdout and exit `0`.
Its `data` holds the command's `description`, `usage`, `flags`, `globalFlags`, positional `args`,
`subcommands`, and `examples`, so an agent can discover the CLI one command at a time. Before, any
command below the root exited `1` with "Samva CLI failed unexpectedly." The root `samva --help
--json` uses the same shape, with the commands listed under `subcommands`.

## @samva/cli-darwin-arm64@0.22.0

### Fix template commands on a project with a brand, assets, or an older toolchain

`samva templates check`, `render`, `build`, `export`, and `snapshot` now pass `--org`, `--profile`,
and `--api-url` to the `samva:brand` lookup, which looked the brand up in the signed-in profile's
organization whatever you passed.

`samva templates snapshot` shows a template's imported images from the project's own files, so it no
longer needs `--asset-base`. A project whose `@samva/markup` or `@samva/vite` is on another release
line than the CLI's is refused with the `npm install` command that updates it, in place of a crash
inside the compiler. `check` names the `tsconfig.json` entry that declares the `samva:brand` and
image modules when `tsc` cannot find them.

`samva templates workspace diff`, `check`, and `fixture` read the workspace's current revision when
`--revision` is omitted.

### Type a send that names its template by slug

`samva templates types --by slug` generates types for code that sends `{ templateSlug,
templateData }`. `templateContent("welcome", data)` returns that pair, checked against the
template's input, and the `TemplateSlug` type lets a mailer be generic over its templates. A send by
slug renders the template's current publication, so `--reference` does not apply, and `--check`
reports drift only when a template's input contract changes. `--by id` stays the default.

The generated file also improves in both modes:

- Its input is always accepted by `email.send`: lists and optional fields compile, and `undefined`
  properties are left out.
- `templateContent` works inside a generic function.
- It matches the repository formatter and passes strict lint configurations, so it no longer needs
  excluding from either.

Regenerate to pick these up; `--check` reports a file from an earlier version as hand-edited.

### Make a brand the default and delete brands from the CLI

`samva brands default <slug>` makes a brand the one bare `samva:brand` and domains without a brand
resolve to. `samva brands remove <slug>` deletes a brand; it asks for confirmation in a terminal and
needs `--yes` elsewhere. The default brand cannot be deleted, so make another brand the default
first. Both take `--dry-run` and `--json`.

## @samva/cli-darwin-arm64@0.21.0

### Set the organization avatar from the SDK and CLI

`Organization` has `avatarUrl`, the image the organization switcher shows, or `null` when none is
set. `organizations.createAvatarUpload()` returns `uploadUrl`, `maxBytes`, and `contentTypes`: PUT a
PNG, JPEG, or WebP image there with the same credential, then save the returned `src` with
`organizations.update({ avatarUrl: src })`. Pass `avatarUrl: null` to remove it.

`samva org avatar set <file>` uploads an image and saves it in one step, and checks its type and size
before sending it. `samva org avatar clear` removes the avatar.

### Read AI credits in organization usage

Organization usage reports AI credits apart from sending credits: `billing.includedAiCredits`,
`usedAiCredits`, `overageAiCredits`, and `overageAiCost`. Each is `null` when the workspace has no
metered AI plan, and `overageAiCost` is also `null` outside USD. `samva org usage` shows them next to
the sending credits.

## @samva/cli-darwin-arm64@0.20.0

### Breaking: `templates build` writes `compiled` where it wrote `ir`

A template's compiled form is now called the compiled template. The JSON file that
`samva templates build` writes uses `schemaVersion: 4`, and each template in it carries `compiled`
where it carried `ir`. Read `files[].template.compiled` instead of `files[].template.ir`. The
`buildSchemaVersion` in `samva templates check --json` is 4 as well.

The CLI bundles `@samva/markup` and `@samva/vite` 0.17.2 and their starter.

### The CLI compiles brand footers on one line

The CLI now bundles `@samva/markup` and `@samva/vite` 0.16.0, the release template projects and the
starter pin. Templates it checks and builds render `<BrandFooter />` with the company name, social
links and unsubscribe link on one line and the postal address below.

## @samva/cli-darwin-arm64@0.19.0

### `samva brands push` checks brand CSS with authoring release 0.15

The CLI now bundles `@samva/markup` and `@samva/vite` 0.15.0, the release template projects and the
starter pin, so `samva brands push` validates brand CSS with the same brand grammar that compiles
your templates' `samva:brand` import.

### Share templates with every namespace from the CLI

`samva templates list --shared true|false` lists only shared or only unshared templates, and each
listed template shows whether it is shared. `samva templates create --shared` creates a template
whose organization-level project is shared from the start, and
`samva templates update <id> --data '{}' --shared true|false` shares or stops sharing a template's
project, which applies to every template in it. A namespace-scoped key reads and sends shared
templates but cannot change them.

### Start a template project from a website

`templates.createFromWebsite` (`POST /v1/templates/from-website`) checks that a website is a public
page that answers, creates a template project, and returns the request that makes the editor's
assistant match the site's look. The assistant proposes a brand, and the brand changes nothing until
you apply it in the editor. A site Samva cannot use creates no project; the `422` message names the
cause: not a web address, not public, no answer, a missing page, refused automated visits, or not a
web page.

`samva templates from-website <url>` does the same from the CLI and prints the editor link.

### Subscribe a webhook to every event Samva delivers

`webhooks.create` and `webhooks.update` in the SDK, and `samva webhooks create` and
`samva webhooks update` in the CLI, now accept `template.registration.updated`,
`flow.registration.updated`, and `whatsapp.number.connected` in `eventTypes`. Before, they
rejected those values even though `@samva/webhooks` types the events, so a webhook's `eventTypes`
can now name every event `@samva/webhooks` verifies.

## @samva/cli-darwin-arm64@0.18.0

### Template themes use one set of color names and one dark mode block

`samva` now builds templates with authoring release 0.14. Theme tokens are renamed to a shared
vocabulary: `--color-brand` is `--color-primary`, `--color-brand-foreground` is
`--color-primary-foreground`, `--color-surface` is `--color-card`, `--color-muted` (text) is
`--color-muted-foreground`, `--font-body` is `--font-sans`, and `--radius-button` is `--radius`. The
matching utilities move with them (`bg-brand` is `bg-primary`, `text-muted` is
`text-muted-foreground`).

Dark mode has one form: set the same token inside
`@media (prefers-color-scheme: dark) { @theme { --color-primary: ... } }`. `-dark` suffix tokens such
as `--color-brand-dark` and utilities such as `dark:bg-brand-dark` are gone; write `bg-primary` once.
A build now also fails on text or a button whose contrast is unreadable in light or dark mode.

To move an existing project, rename the tokens in `starter.css` and `theme.css`, fold each `-dark`
value into the dark block under the renamed token, and rename the utilities in your templates.
Brands stored in Samva were rewritten to the new names.

### Read a webhook signing secret from the CLI

**Breaking:** `webhooks create` and `webhooks rotate-secret` JSON results no longer include
`displayOnce`. Remove checks for that field; signing secrets can be read again.

Run `samva webhooks secret <id>` to read the current signing secret, its creation time, and the
previous secret's verification deadline when one exists. `--json` returns
`{secret, createdAt, previousExpiresAt}` inside the result envelope. Requires `webhooks:update`.

## @samva/cli-darwin-arm64@0.17.0

### Mailbox commands take the mailbox ID as an argument

`samva mailboxes` commands no longer accept `--mailbox`. Pass the mailbox ID as the first argument
and the message, action, or endpoint ID after it:

```bash
samva mailboxes threads mbx_... --unread
samva mailboxes read mbx_... msg_...
samva mailboxes reply mbx_... msg_... --text "Thanks"
samva mailboxes send mbx_... --to ada@example.com --subject Hello --text "Hi"
samva mailboxes endpoints add mbx_... --address billing@acme.samva.email
samva mailboxes endpoints update mbx_... mbxep_... --default
samva mailboxes actions approve mbx_... mbxact_... --yes
samva mailboxes quarantine release mbx_... msg_...
```

The same order applies to `endpoints remove`, `actions list|get|cancel|retry|deny`, and
`quarantine list|discard`. `samva mailboxes events` takes any number of mailbox IDs as arguments
(`events mbx_... mbx_...`), or none to follow every mailbox the credential reads. Update scripts that
pass `--mailbox`; the flag is now rejected.

### API keys can be scoped to mailboxes from the CLI

`samva api-keys create` sets mailbox access without `samva api`. `--mailbox-permission
read|update|send|quarantine.read` (repeatable) grants mailbox actions, `--mailbox <id>` (repeatable)
confines them to specific mailboxes, `--send-mode approval` holds each send until a person other
than the key approves it, and `--namespace <id>` confines the key to one namespace. They combine with
`--grant`. `--mailbox` and `--send-mode` need a `--mailbox-permission`, and none of them combine with
`--full-access`.

`samva api-keys update <key-id> --send-mode send|approval` changes a mailbox key's send mode without
a new key; it needs a person signed in with `samva login`. Other access is still fixed at creation.
`--grant mailboxes=...` remains unsupported; use `--mailbox-permission`.

## @samva/cli-darwin-arm64@0.16.0

### Mailbox commands take a channel

`samva mailboxes create`, `endpoints add`, and `send` accept `--channel email|whatsapp|sms` (default
`email`). On a phone channel `--address` is a number you connected, in E.164 form, and `send` takes
one `--to` number with `--text`, or on WhatsApp an approved `--template <templateId>` with an
optional `--data` JSON object. Free-form WhatsApp text outside the customer's 24-hour window is
refused with `WhatsAppServiceWindowClosedError`; send a template instead.

`samva mailboxes reply` answers a WhatsApp or SMS message on its thread with `--text` or
`--template`, and `--all`, `--html`, and email recipients stay email-only. `mailboxes get`, `read`,
and `threads` print phone endpoints, chat messages (text, media, template), and the thread's channel.
`mailboxes reply --text` now reads the message first to learn its channel.

## @samva/cli-darwin-arm64@0.15.0

### `samva mailboxes events` reconnects after a dropped connection

A dropped connection no longer ends `samva mailboxes events`. The command reconnects from the last
event it handled, so an event can repeat but none is skipped, and keeps running until you stop it,
the stream's end, or an error that retrying cannot fix, such as a revoked credential or an expired
cursor.

Each reconnect prints one line to stderr. With `--jsonl`, stderr carries a warning envelope and
stdout stays event envelopes only:

```json
{
  "schemaVersion": 1,
  "type": "warning",
  "command": "mailboxes.events",
  "reason": "mailbox_events_reconnecting",
  "message": "Mailbox event stream dropped (closed with 1006). Reconnecting from cursor 42.",
  "details": { "cursor": "42", "attempt": 1 }
}
```

Pass `--no-reconnect` to keep the earlier behavior: the command exits `1` on the first drop and
names the cursor to resume from. `samva extensions dev` reconnects the same way.

### Templates build with authoring 0.13: WhatsApp names come from the handle

`samva templates` bundles `@samva/markup` and `@samva/vite` 0.13.1. `<WhatsApp>` no longer takes
`name`: Samva registers each WhatsApp template with Meta under its handle. A template that still
sets `name` fails with `whatsapp-template-name`; remove the attribute.

### See how a held send was resolved

A send held for approval now tells you how it ended, without polling.

- Every mailbox action carries `resolution`: `outcome` (`approved`, `denied`, or `cancelled`),
  the resolving `actor` (`kind`, `id`, optional `displayName`, and `source`), `resolvedAt`, and
  the denial `reason` (`null` otherwise). It is `null` while the action waits for approval and for
  an action that never needed one.
- A new `mailbox.action.resolved` event fires once when a held send is approved, denied, or
  cancelled, on webhooks, the mailbox event stream, and to extensions that list it in `events`. It
  carries the action and the same `resolution` object. An approved send still publishes
  `mailbox.message.sent` once its email is accepted.
- `samva mailboxes actions get|list|approve|deny` prints the resolution.

Types that list every mailbox event, such as an exhaustive `switch` over `MailboxEventType`, gain
`mailbox.action.resolved`.

## @samva/cli-darwin-arm64@0.14.0

### Journeys and contact events (preview)

The SDK and CLI now include operations for journeys and contact events. They are not available to
organizations yet: until they are enabled for yours, each call fails with `FlagDisabledError`
(HTTP 403). Guides will follow when they open.

- Journeys: `journeys.create`, `replaceDraft`, `publish`, `pause`, `resume`, `archive`, `stats`,
  `listRuns`, and `getRun`, and the `samva journeys` commands.
- Contact events: `events.create`, `events.batch`, and `contacts.listEvents`, and the
  `samva events send` and `samva contacts events` commands.

## @samva/cli-darwin-arm64@0.13.0

### Mailbox endpoints

**Breaking:** `samva mailboxes addresses add|remove` becomes `samva mailboxes endpoints
add|update|remove`, and mailbox `--json` output carries `endpoints` in place of `addresses` and
`defaultFrom`.

```bash
# Before
samva mailboxes addresses add --mailbox mbx_... --address billing@acme.samva.email
samva mailboxes addresses remove mbxaddr_... --mailbox mbx_... --yes

# After
samva mailboxes endpoints add --mailbox mbx_... --address billing@acme.samva.email
samva mailboxes endpoints update mbxep_... --mailbox mbx_... --display-name "Billing" --default
samva mailboxes endpoints remove mbxep_... --mailbox mbx_... --yes
```

`endpoints update` sets an endpoint's sender name (`--display-name`, `--clear-display-name`) and
makes it the mailbox's default (`--default`). `samva mailboxes update --data` no longer accepts
`defaultFrom`. `samva mailboxes create --address` is unchanged and creates an email endpoint.

### Set the default sender and default domain from the CLI

`samva email senders set-default <id>` makes a verified sender the organization default, and
`samva email domains set-default <id>` marks a verified domain as the default sending domain. Both
take `--dry-run` and `--json`. `samva email domains list` now shows a Default row for each domain.

**Breaking:** domains no longer carry their own default sender, so `--json` output from
`samva email domains list` no longer includes `defaultSenderId`. The organization default sender is
the only one.

### Manage API keys with `samva api-keys`

`samva api-keys` lists, reads, creates, updates, rotates, and revokes the organization's API keys.
`create` takes `--name`, optional `--description` and `--expires-at`, and exactly one of
`--full-access` or repeatable `--grant <resource>=read|write`. The secret is shown once: `--json`
returns `{apiKey, key, displayOnce, warning}`, so `samva api-keys create ... --json | jq -r .data.key`
yields the key. `rotate` and `revoke` ask for confirmation (`--yes` outside a terminal), and every
mutation supports `--dry-run`.

`samva org current` now works under `SAMVA_API_KEY`: it asks the API which organization the key
belongs to and prints its slug. With `--json` it adds the organization and the key's id and name.

### Call any API endpoint with `samva api`

`samva api <path>` sends an authenticated request to any public API endpoint with the credentials
the other commands use, and prints the response as the API returned it. It takes `-X` for the
method, `-f` and `-F` for string and typed fields (nested `a[b]=v`, arrays `a[]=v`, `@file`, `@-`),
`--input` for an exact body, `-H` for headers, `--paginate` with `--slurp` for lists, and `-i`,
`--silent`, and `--verbose` for inspection. A non-2xx response writes its body to stderr and exits
`4` for 401 and 403, otherwise `1`. Pipe the output to `jq` to filter it.

### Format human output for webhooks, usage, and templates

`samva webhooks logs`, `stats`, `retry`, and `update`, `samva org usage`, and `samva templates get`,
`create`, `update`, `remove`, and `export` print labeled rows in a terminal instead of a raw JSON
document, with the same facts as `--json`. The `--dry-run` previews of `webhooks create|update`,
`templates create|update`, and `mailboxes actions approve|deny` print a one-line summary. Machine
output is unchanged.

## @samva/cli-darwin-arm64@0.12.0

### Show the webhook signing secret on create

- `samva webhooks create` now prints the endpoint's signing secret, which it showed as
  `<redacted>` before. It is shown once, so store it when you create the endpoint.
- `samva mailboxes actions get`, `cancel`, and `retry` name their own command in `--json` output.

### Create a mailbox from one address and a name

**Breaking:** `samva mailboxes create` takes one `--address` and a `--name`.

```bash
# Before
samva mailboxes create --slug support --name Support --address support@acme.samva.email

# After
samva mailboxes create --address support@acme.samva.email --name Support
```

- `--slug` is optional and defaults to the address's local part. If that slug is taken, pass your
  own.
- `samva mailboxes update --data` and mailbox JSON output use `name` instead of `displayName`.
- Add and remove addresses with `samva mailboxes addresses add` and `samva mailboxes addresses
  remove`. Removing asks for confirmation, or `--yes` outside a terminal.
- Mail from a mailbox with no sender name now shows the mailbox's `name` instead of a bare address.

## @samva/cli-darwin-arm64@0.11.0

### Request recipient confirmation before subscribing

Use `client.subscriptions.subscribe` or `samva subscriptions subscribe` to send a confirmation email
from your sender. The recipient joins the selected contact group only after confirming the link.
Choose a published template for the confirmation email, or use the default message.

### Breaking: mailbox sends report their progress

Mailbox send commands return a receipt with the send's `state` instead of a sent confirmation, and a
rate-limited or not-yet-ready send is queued instead of failing. Follow it with
`samva mailboxes actions get`. Signed in as a person, stop it before acceptance with
`actions cancel` or resume an eligible ended send with `actions retry`.

### Breaking: separate contact lookup from creation

`contacts.findOrCreate` takes `lookup: { type, value }` instead of competing lookup fields and
returns `{ contact, created }`. Put initial attributes in `create`, including `externalId`,
`identities`, and `profile.customFields`. Existing contacts return unchanged with `created: false`;
use `contacts.update` to change them. Conflicting external IDs or addresses return `ConflictError`
(HTTP 409) and roll back creation.

### Inspect contacts and custom fields

`contacts.list` can select defined custom fields with `fields` and filter one field by JSON scalar
equality with `customField` and `customFieldValue`.

`samva contacts list|get` supports search and custom-field inspection, bounded JSON output, and
streaming list pages with `list --all --jsonl`.

## @samva/cli-darwin-arm64@0.10.0

### Attach files to an email

`samva email send --attach ./report.pdf` attaches a file; repeat the flag for more. The CLI checks
every file against the attachment limits before sending, and files past the 4 MiB inline limit
upload through media first.

### `samva mailboxes remove`

`samva mailboxes remove <mailbox-id>` deletes a mailbox with its addresses, threads, drafts, and
history; the messages it received stay with the organization. It asks for confirmation in a
terminal, needs `--yes` in automation, and previews with `--dry-run`.

### Follow mailbox send refusal guidance

Mailbox sends and approval execution retain rate-limit retry delays, sender-readiness details, and onboarding review recovery fields in machine-readable errors. Human output names the appropriate wait or review step.

### Upgrade mailbox extensions in place

`samva extensions upgrade <installation-id>` moves an installation to a published version without
replacing its identity or credentials. Preview with `--dry-run`, then explicitly acknowledge every
added permission or event subscription with `--accept-permissions`. `--yes` confirms the change;
it does not acknowledge added grants. Use `--version` to select a target or roll back.

### Inspect and review mailbox work

Manage mailboxes with `get`, `update`, `pause`, and `resume`. Review pending sends with
`mailboxes actions list`, `approve`, and `deny`; decisions require a person signed in with
`samva login` and support confirmation and dry-run previews.

Mailbox and extension human output carries the same facts as JSON, including sending waits,
thread state, message attachments and authentication, quarantine results, installation scope,
and run details. Extension starters write consistently indented manifests, and webhook creation
help uses the API's `eventTypes` field.

## @samva/cli-darwin-arm64@0.9.0

### Breaking: the mailbox event stream uses pings

The mailbox event stream no longer sends `heartbeat` frames. The SDK and `samva mailboxes events`
now send `{"kind":"ping"}` every 30 seconds, and the stream answers with `{"kind":"pong"}`. Upgrade
the SDK or CLI before you rely on a long-lived stream: an earlier version reads the silence of a
quiet mailbox as a dropped connection and reconnects about every 90 seconds.

If you read the WebSocket directly, send the ping yourself and treat three silent intervals as a
dropped connection. A live stream also receives a `progress` frame carrying the position it has
passed, at most every 5 minutes; resume from it when nothing is pending. Samva now re-checks an open stream's credential every 5 minutes instead of
every minute, so a revoked key can keep receiving events for up to that long.

## @samva/cli-darwin-arm64@0.8.0

### Mailboxes for agents

`samva mailboxes` creates mailboxes, reads threads, and sends and replies from them.
`samva mailboxes events` follows events live, and `samva mailboxes quarantine` lets you `release` or
`discard` held mail. `samva extensions` scaffolds, runs, publishes and installs mailbox extensions
(`init`, `dev`, `build`, `publish`, `install`, `runs`). See
[Mailboxes CLI](https://samva.dev/docs/mailboxes/cli).

### Breaking: page and date flags

- `--cursor` replaces `--page`, and `--json` prints `{ items, nextCursor }`.
- `--after` and `--before` replace `--start-date`, `--end-date` and `--period`.

### Also new

- **Clearer errors:** messages name the cause and the next step. With `--json`, `reason` is the API
  error name, and a rejected key or missing permission exits with code `4`.
- **Feedback:** `samva feedback send "<message>"` tells our team what went wrong.
- **Templates:** `samva templates` and new template projects use SML 0.12.0.

## @samva/cli-darwin-arm64@0.6.1

### Stable Effect 4 support

**Breaking for Effect users:** If you use `samva/effect` or `@samva/webhooks/effect`, upgrade your application's `effect` dependency to `4.0.0` alongside this release. `4.0.0-rc.117` is no longer supported. The Promise SDK and Promise webhook helpers still work without installing Effect.

The Effect SDK preserves the API's string limits for idempotency keys, URLs, template entry paths, and workspace asset paths. The `idempotency-key` header allows at most 255 UTF-16 code units, as counted by JavaScript's `string.length`: 127 emoji plus one ASCII character fits; 128 emoji does not. API limits are unchanged.

The CLI bundles the updated SDK and stable Effect runtime. You can keep your existing commands and configuration.

### Complete JSON output through pipes

Wait for stdout and stderr writes to finish before completing CLI commands, so large JSON results remain valid when piped to tools such as `jq` or captured with shell command substitution. JSON Lines output also waits for each record to finish writing.

### Breaking: supply brand resolution to the authoring toolchain

`@samva/vite` accepts `brandResolver` and `brandPlugin` on the editor plugin and its dev, project,
build, render and export APIs. A brand import without a resolver fails with `brand-unavailable`.
Standalone callers supply a resolver; the package does not read Samva credentials, invoke the
Samva CLI or load Samva brand snapshots. The `offline` option and Samva snapshot helpers move to
the CLI.

`samva templates dev`, `check`, `build`, `render`, `snapshot` and `export` supply the Samva resolver
and brand plugin, preserving live lookup, cached snapshots and brand diagnostics.

## @samva/cli-darwin-arm64@0.4.0

### Breaking: `samva templates publish` selects entries, not a template id

A template project holds several emails, and `publish` picks which to publish at one clean, pushed
commit: `samva templates publish emails/reset.tsx` (an entry path or template id), `--all` for
every active template in the project, or no argument for a project with one active template.
`--template-id` and `--entry` are removed; the project comes from `--project-id` or the clone's
`samva.projectId`, and `samva.templateId` and `samva.entryPath` are no longer read.

`--json` returns every entry's result instead of one publication:

```json
{
  "action": "templates.publish",
  "commitSha": "3f9c2e1",
  "publications": [
    {
      "templateId": "tmpl_abc123",
      "slug": "reset",
      "entryPath": "emails/reset.tsx",
      "ok": true,
      "publicationId": "tpub_abc123",
      "status": "published"
    }
  ],
  "unregistered": []
}
```

When any entry fails, the rest still publish, the command exits `1` with `template_publish_failed`
and the same result, and rerunning it is safe. `--all` lists `defineEmail` files that are not
registered in `unregistered`.

### Register and move template entries

`samva templates add emails/reset.tsx` registers another email in the project under its
`defineEmail` id; `--slug` and `--name` choose others, or register an entry before its file exists.
After `git mv`, `samva templates move <old-path> <new-path>` points the template at the new file and
keeps its id, handle, and publications. `samva templates clone` accepts a project id (`tproj_…`) as
well as the id of any template in it.

`samva templates remove` says what it does: it deactivates the template, and its file and
publications remain. Adding the same entry again brings it back.

### Add images and fonts to a hosted workspace

`samva templates workspace add-asset <template-id> <file>` writes a PNG, JPEG, GIF, WebP, or WOFF2
file of at most 1 MiB into the workspace as an unsaved change, at `assets/<file name>` unless
`--path` names another path. `--replace` is required to change a file that already exists.

### Breaking: `samva email design` is `samva brands`

`samva email design pull` and `samva email design push` are removed. An organization's look lives in
brands, which a template imports with `@import "samva:brand";`:

```sh
samva brands list
samva brands pull              # snapshot the default brand
samva brands push brand.css --brand acme --dry-run
```

`samva brands pull [slug]` writes `.samva/brands/<slug>.json`, which `samva:brand` resolves from
when the API is unreachable; it never writes `theme.css`, so keep `.samva` gitignored.
`samva brands push <file>` validates the CSS against the brand grammar first and exits `1` with
`invalid_brand_css` and every finding at `file:line:column`, uploading nothing; otherwise it
replaces the CSS of the `--brand` it names, or of the default brand. `--dry-run` validates without
credentials. Published templates keep their brand until they are republished.

`samva templates export` reads the current directory's `theme.css`, as `check` and `build` do, so a
theme and its `samva:brand` import style the exported HTML.

### Held messages show why they wait

`samva email send`, `samva messages get`, and `samva messages wait` report `waitReason` and
`reviewExpectedAt` in JSON and a `Waiting` line in human output, such as
`content review (expected by 2026-09-27T12:00:00.000Z)`, while Samva reviews a message before it
sends.

### JSON envelopes name nested commands

The `command` field of a `--json` envelope names the full path for `org usage`, `email review`,
`email tracking`, `email domains rotate-dkim`, `email domains custom-tracking`,
`scheduled-messages resume`, and `templates credential`, instead of their parent command.

## @samva/cli-darwin-arm64@0.3.2

### `samva` no longer reads `.env` from the current directory

Set `SAMVA_API_KEY`, `SAMVA_API_URL`, or `SAMVA_PROFILE` in your environment to use them.

## @samva/cli-darwin-arm64@0.3.1

### The macOS arm64 binary runs again

`@samva/cli-darwin-arm64` shipped with an invalid code signature, so macOS killed `samva` on
launch. It is now built with a valid ad-hoc signature.

## @samva/cli-darwin-arm64@0.3.0

### Breaking: profiles no longer carry a target

`samva profile create` drops `--target`. If a command fails with `unsupported_profile_target`,
remove `target` from `~/.config/samva/config.json`; use `--api-url` or `SAMVA_API_URL` for a
non-production API.

## @samva/cli-darwin-arm64@0.2.1

### Name the flag behind a gated refusal

A call refused by a feature gate printed the operation prefix and a dangling colon. It now reads
`Could not send message: feature flag 'sms' is disabled`, so the flag to enable is in the line you
already read.

## @samva/cli-darwin-arm64@0.2.0

### Breaking: check, publish and export executable email templates

Email projects now use default-exported `defineEmail` objects with an input schema, named fixtures
and `render(input)`. Upgrade the CLI to 0.2.0 and the project's `@samva/markup` and `@samva/vite`
dependencies to 0.2.0, update email imports to the new `/email` runtime and components, and regenerate
the project lockfile. Replace old function-based email entries before checking or publishing.

- `samva templates check` type-checks the project and validates compiled fixtures, reporting source
  locations and email-client diagnostics. `--watch` streams bounded JSONL observations and keeps
  feedback current as source changes.
- `samva templates build` writes a reusable JSON build artifact.
- `samva templates export` renders local fixtures to HTML, text and assets with a catalog; it does
  not export hosted SML snapshots. `samva templates pull` is removed; use `samva templates clone`
  and ordinary Git for hosted project source.
- `samva templates publish` publishes a clean commit as an immutable executable with its input
  contract and locked dependencies. Republish migrated projects and update old publication references.
- `samva templates types` generates typed caller inputs and template references from the hosted
  catalog. `samva templates types --check` detects catalog drift in CI.

Sends support exact `email.publicationId` selection or latest-compatible `email.inputContractId`
selection alongside `email.templateId`. Source workspace commands expose revision-aware editing
and checking through the same authoring operations used by the hosted editor.

### Name the layer behind a 500, 502, or 504

A `500` used to arrive with an empty body, so the SDK surfaced it as a generic transport error and
the CLI printed a bare status. It now carries the same flat `InternalError` body every other API
error uses, so `samva` throws the typed, retryable `InternalError` and the CLI prints its message.

A `504` now carries a `GatewayTimeoutError` body and a `Retry-After` header instead of nothing, so a
client can tell a request that ran out of time from one that was refused.

Both responses also carry `x-samva-error-layer`, naming `sql`, `deadline`, or `provider` — the
database, the API's time limit, or a service Samva calls. See the
[error reference](https://samva.dev/docs/developers/error-reference) for the retry guidance.

### Identify first-party API clients in developer logs

The TypeScript Promise and Effect SDKs now identify their surface and package version on API
requests. The Samva CLI identifies itself as the outermost caller, so developer logs and operational
telemetry can distinguish CLI traffic from direct SDK use.

### Make sender lifecycle operations replay-safe

Sender creation now supports stable idempotency keys and reports provider provisioning separately
from mailbox verification. Sender deletion remains observable until provider cleanup finishes, and
the CLI now displays the provider lifecycle for sender records.

## @samva/cli-darwin-arm64@0.1.2

### Stage sending domains before provider verification

Email domains now expose exact DNS instructions and a typed verification lifecycle before provider provisioning begins. SDK and CLI consumers can read stored verification state and explicitly advance verification without a read causing provider mutations.

## @samva/cli-darwin-arm64@0.1.1

### Release the 0.1.1 package family

This package is the macOS arm64 native executable for `@samva/cli`. The supported install is the
`@samva/cli` selector on npm. Depend on `@samva/cli`. Do not depend on this package directly.

The current Tegami plugin does not attach CLI binaries to GitHub Releases. npm optional
dependencies install this executable when the platform matches.
