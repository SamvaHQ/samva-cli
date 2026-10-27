# Samva CLI consumer guide

Use `samva --help` and `samva <command> --help` as the command contract. `--help --json` (or
`--jsonl`) prints that contract as one result envelope: `data` carries `description`, `usage`,
`flags`, `globalFlags`, `args`, `subcommands`, and `examples`. For automation, prefer
`SAMVA_API_KEY`, `--json` for one bounded result, and `--jsonl` with `--all` for streamed lists.
Machine-readable results go to stdout; warnings and typed errors go to stderr. Error envelopes carry
`schemaVersion`, `type`, `command`, `reason`, `message`, and optional `next`. For API failures,
`reason` is the API `_tag`, `status` is the HTTP status, and `details` preserves the public error
fields. Follow `next` and fix `details.fields` before retrying. API 401 and 403 exit with code `4`;
other operational failures exit with code `1`. Human mode prints the same message and recovery step.

`samva api <path>` is the floor under every command: it calls any public endpoint with the CLI's
credentials (`SAMVA_API_KEY`, or the signed-in profile and its organization) and prints the API
response as returned, not the `{schemaVersion,...}` envelope, so `--json` and `--jsonl` are refused
(exit `2`). The path is relative to the API URL (`email/domains` and `/v1/email/domains` are the same
request); a full URL is refused so credentials reach only the selected API URL, and redirects are not
followed. The method is `GET`, or `POST` once a field or `--input` is given. `-f` adds a string field,
`-F` a typed one (`true`, `false`, `null`, integers, `@file`, `@-`), `a[b]=v` nests, `a[]=v` appends;
on a `GET` or with `--input` fields go to the query string. `--paginate` follows `nextCursor` through
the `cursor` query parameter and prints one page per line, `--slurp` one JSON array. A non-2xx
response writes its body to stderr and exits `4` for 401 and 403, otherwise `1`. Pipe to `jq`; there
is no built-in filter.

`samva api-keys` manages the organization's keys: `list`, `get`, `create`, `update`, `rotate`, and
`revoke`. `create` takes `--name` and either `--full-access` or restricted access built from repeatable
`--grant <resource>=read|write` and mailbox access: repeatable `--mailbox-permission
read|update|send|quarantine.read`, optionally narrowed to repeatable `--mailbox <id>` (default:
every mailbox the owner reaches) with `--send-mode approval` (each send waits for a person other
than the key). `--namespace <id>` confines a restricted key to one namespace. Passing no access, or both
`--full-access` and restricted access, exits `2`, as does `--mailbox` or `--send-mode` without a
`--mailbox-permission`. `--description` and `--expires-at` are optional. `update` renames a key,
sets its description, or changes a mailbox key's `--send-mode` (a person signed in with `samva
login`); every other part of a key's access is fixed at creation. The API refuses a key with more access than the
caller holds. `create` and `rotate` return the secret once: `--json` carries `{apiKey, key,
displayOnce, warning}`, so `samva api-keys create ... --json | jq -r .data.key` yields the key, and
human mode prints it to stdout with the warning on stderr. `rotate` and `revoke` require
confirmation (`--yes` outside a terminal), and every mutation supports `--dry-run`. Under
`SAMVA_API_KEY`, `samva org current` asks the API who the key is (`GET /v1/whoami`) and reports its
organization and key; with OAuth it reports the profile's selected organization.

`samva webhooks secret <id>` reads the current signing secret with `webhooks:update` permission.
Human output includes the secret, its creation time, and when the previous secret stops verifying
if one exists. `--json` returns `{secret, createdAt, previousExpiresAt}` inside the result envelope.
`create` and `rotate-secret` return readable secrets too; retrieve them again with `secret <id>`.
Their JSON results contain `secret` and `warning` (`create` also includes `endpoint`).

`samva templates export --out <dir>` renders every local template's fixtures to HTML
and text with the asset manifest, needing a Samva credential only to resolve a live `samva:brand`; `--asset-base <origin>` is for an
export that will be delivered, which cannot carry a relative reference.
`samva templates check --watch` is the continuous authoring gate. Human mode prints observations;
machine watch output uses `--jsonl`. `--json` remains one-shot.
`samva mailboxes events` is a stream: human mode prints one raw record per line, `--jsonl` one result
envelope per event, `--quiet` nothing, and `--json` is refused (exit 2) with a pointer to `--jsonl`.
A dropped connection reconnects from the last handled cursor, so an event can repeat but none is
lost; each reconnect is one stderr line in human mode and one `type: "warning"` envelope
(`reason: "mailbox_events_reconnecting"`, `details.cursor`, `details.attempt`) in `--jsonl`, never a
stdout record. `--no-reconnect` ends the command on the first drop, exit `1` with the last cursor.
A close that retrying cannot fix (`4401`, `4403`, an expired cursor) still ends the command.

The developer loop for a template project is `samva templates dev` (the local visual editor, no
`vite.config.ts`), `check` (type-check, compile, and render every fixture), `render <template>
--fixture <name>` (subject, preheader, and plain-text body; `--format html`, `--channel sms|whatsapp`),
and `snapshot <template> --fixture <name>` (desktop and mobile PNGs, light and dark, in
`.samva/snapshots`, needing `playwright` in the project or a system Chrome; imported images come
from the project's own files unless an HTTPS `--asset-base` is given). The commands run the project's
installed `@samva/markup` and `@samva/vite`, which must be on the release line the CLI drives; any
other line stops with the `npm install` command that fixes it. With `--json`, every
finding carries `code`, `severity`, `message`, `file`, `line`/`column`, `range`, and, where the
compiler has them, `fix`, a machine-applicable `edit`, and `upgrade`, the instructions for migrating
a template written in a format the compiler rejects. Templates live in `templates/` and
`emails/`; a template is a `.tsx` file that default-exports `defineTemplate`, and the compiler reads
it without running it.

`samva email send` and `samva scheduled-messages create` take `--from <address>` (a verified sender or
any address on a verified domain) and `--from-name`; omitted, the send uses the default sender, else the
only verified sender, and otherwise fails with `FromAddressRequiredError`. `--from-name` without
`--from` exits `1`.

`samva email send --attach <path>` (repeatable) attaches local files; the filename is the basename and
the content type comes from the extension (`application/octet-stream` when unknown). The CLI reads
and budget-checks every file before any request (at most 10 files, 25 MiB each and in total) and
exits `2` naming the path or limit. Past the 4 MiB inline limit, the largest files upload through
`/v1/media` first and travel by `mediaId`; the send's retries reuse them, and rerunning the command
uploads again. `--dry-run` lists each attachment and uploads nothing.

`samva email send --header 'Name: Value'` (repeatable) sets `email.headers`. The name is the text
before the first colon and the value is the rest, both trimmed. A pair with no colon, no name, or
no value exits `2`. Reserved names and size limits are rejected by the API.

`--publication-id` and `--input-contract-id` on `email send`, `scheduled-messages create`, and
`campaigns create`/`update` choose which publication a template send renders: one exact publication,
or the newest publication that still validates input identically. They are mutually exclusive and
each requires `--template-id`, because a reference is a statement about one template's history.

`samva templates list --shared true|false` filters by whether the template's project is shared with
every namespace, and every listed template reports `shared`. Sharing belongs to an organization-level
project: `templates create --shared` shares the new project and refuses a namespace (exit `2`), and
`templates update <id> --data '{}' --shared true|false` shares or unshares the project for every
entry in it. `--shared` that disagrees with `shared` in `--data` exits `2`. A namespace-scoped key
lists, reads, and sends shared templates but gets 403 changing them, and the API refuses moving a
shared project into a namespace.

`samva templates workspace <open|diff|patch|add-asset|check|fixture|save|history|publish>` is the
hosted project workspace over the CLI, for a caller with no clone: an agent in a sandbox, a CI job,
a script. It reaches the same operations the hosted MCP tools reach, so an agent can start a journey in one
and finish it in the other; `add-asset` alone has no MCP twin, because a chat client holds no file
bytes to send. Every subcommand prints its complete
result as JSON because these outputs — revisions, digests, diagnostics — are inputs to the next
call. `open` returns the revision every other subcommand is fenced to; a workspace that moved refuses
them, and reopening is the recovery. The reads (`diff`, `check`, `fixture`) fence to the current
revision when `--revision` is omitted. A source that does not build is a successful call carrying a
null declaration and located findings, not a failed one. `add-asset <template-id> <file>` writes one
image or font as unsaved bytes at `assets/<file name>` unless `--path` names another project path;
`--replace` is required to change a path that already holds a file. The Git commands remain the way
to author a project you have cloned.

`samva brands pull [slug]` writes the brand snapshot `.samva/brands/<slug>.json` that the CLI
resolves `samva:brand` from offline; bare `pull` snapshots the default brand, and `theme.css` is
never written. Keep `.samva` gitignored. `samva brands push <file>` validates brand CSS locally,
exits `1` with located findings when it is outside the brand grammar, and otherwise replaces the
CSS of the brand `--brand <slug>` names, or of the default brand; `--name` also sets its display name. `--dry-run` validates offline.

`samva templates types --out <file>` writes one TypeScript module from the authenticated template
catalog: the input each published template accepts, and the reference a send carries. The default
reference is each template's current publication, so a generated file keeps sending the same
message until it is regenerated; `--reference contract-latest` follows new publications while the
input contract holds. `--by slug` writes the helper for callers that send by template slug: it
returns `{ templateSlug, templateData }`, renders the template's current publication (the API takes a
publication or contract reference only beside a template id), types the input from the current input
contract, and refuses `--reference`. Both modes export `TemplateSlug`, and `templateData` is typed to
what `email.send` accepts. `--check` writes nothing and exits `1` when the file no longer describes the
catalog, naming what moved. A schema the generator cannot express as a checking type is refused
with the template and the JSON pointer rather than generated as `unknown`.

`samva topics issues` edits a topic's shared Markdown workspace. Commands return the complete JSON
result, including the revision or saved commit the next fenced operation consumes. Read the latest
revision with `list` or `open`, name it with `--revision` for edits, and use `save` to obtain the
commit for a campaign's `--issue-path` and `--issue-commit`. Creating or updating a draft does not
send email. The API requires the `issueContent` and `email` features for the organization.

`samva templates init --name <name>` creates a starter-backed Artifact project and clones its Git
repository. `samva templates clone <project-or-template-id>` clones an existing project. Both configure a
repository-local credential helper that exchanges Samva authorization for a short-lived,
repository-scoped credential; the token is never stored in the remote URL or Git config. Normal
`git fetch`, `git pull`, `git add`, `git commit`, and `git push` remain the synchronization commands.
A pushed commit is picked up on the next hosted workspace open; independent draft edits rebase,
and overlapping edits produce explicit conflicts.
Install from the project's lockfile (`bun install --frozen-lockfile` or `npm ci`) before `samva templates check` or `samva templates build`, then
publish a clean, pushed commit with `samva templates publish`. Publish checks that the selected
commit is an ancestor of the fetched `origin/<default-branch>` and creates an immutable receipt; it
does not push or rewrite history. A project holds several emails: `samva templates add
<templates/x.tsx>` registers another entry under its `defineTemplate` id, `samva templates publish --all`
publishes every active entry at one commit and exits non-zero if any failed, and `samva templates
move <old> <new>` follows a `git mv`. The CLI loads the project's installed authoring toolchain so its
compiler and editor versions stay pinned by the project lockfile.
Template authoring commands run that toolchain under Node.js and name the Node.js version they need
when it is missing; other CLI commands are self-contained.

`@samva/cli` ships the JavaScript implementation and its runtime dependencies. Its launcher prefers
the matching platform-specific `@samva/cli-*` executable and falls back to the packaged JavaScript
CLI through Bun when npm omits optional dependencies. Depend on `@samva/cli`, never a native
artifact directly.

Keep Samva brand resolution in the CLI and pass `samvaBrandPlugin` to the project's authoring
toolchain, so standalone `@samva/vite` stays independent of Samva authentication and storage.
Standalone callers supply their own resolver. The README owns resolution order and configuration.

`samva extensions` is the mailbox extension developer loop: `init` scaffolds an authoring project,
`dev` handles mailbox events locally, `publish` records an immutable version, and `install` grants
that version scoped mailbox permissions. Hosted extensions run on Samva; webhook extensions use
the installation credentials returned once at install. Publishing and installation management
require a person signed in with `samva login`. `upgrade <installation-id>` selects the latest
published version, or `--version <version-or-id>` selects one. `--dry-run` asks the API for the
from/to versions and added/removed grants without changing the installation; the installation
shown in a preview is its current state. Applying requires confirmation (`--yes` outside a
terminal) and an exact, repeatable `--accept-permissions` acknowledgement for each added grant,
such as `permission:send` or `event:mailbox.message.sent`. Local development with that login attributes tool
calls to you, rather than to an installation. Read what exists with `list`, `versions <name>`,
`version <name> <version>`, `installations`, `installation <id>`, `runs <id>` (outcomes only), and
`run <id> <run-id>` (adds the handler's log lines); the list commands page with `--limit`,
`--cursor`, and `--all --jsonl`.

`samva mailboxes` reads and sends as a mailbox. Every command except `list` and `create`
takes the mailbox ID as its first argument and the message, action, or endpoint ID second,
as in `read <mailbox-id> <message-id>` and `endpoints update <mailbox-id> <endpoint-id>`; `events`
takes any number of mailbox IDs, or none for every mailbox the credential reads. `list` pages with `--limit`, `--cursor`, `--after`,
and `--before`. `create --address <address> --name <name>` makes a mailbox with one email endpoint; the
slug defaults to the address's local part, and a collision asks for `--slug` rather than suffixing.
`get <id>` inspects a mailbox; `update <id> --data <JSON-or-@file>` changes
`name` or `metadata` (merges by key, `null` deletes a key); a mailbox's endpoints, their
sender names, and its default are `endpoints add|update|remove`. `pause <id>`
stops sending and receiving, and `resume <id>` resumes without backfilling mail received while
paused. These mutations support `--dry-run`. `remove <id>` deletes a mailbox (`--yes` outside a terminal, `--dry-run` to
preview), `threads` searches, `read` prints a message (human output marks the body as
untrusted email), and `send` and `reply` take `--idempotency-key` so a retry cannot send twice.
`create`, `endpoints add`, and `send` take `--channel email|whatsapp|sms` (default `email`); on a
phone channel the address is a connected number in E.164 form, and `send` takes one `--to` number
with `--text` or, on WhatsApp, an approved `--template <templateId>` with `--data`. `reply` answers a
WhatsApp or SMS message on its thread; a bare `--text` reply reads the message first to learn its
channel. Free-form WhatsApp text outside the customer's 24-hour window fails with
`WhatsAppServiceWindowClosedError`; send a template. These commands call the API directly because the
public SDK describes email only.
Quarantine `list` pages the same way, bounded by `--after` and `--before` on when a message was
held; `release` and `discard` take the held message's `id` and require a person signed in with
`samva login`. Discard requires confirmation (`--yes` outside a terminal) and supports `--dry-run`.
`actions list <mailbox-id>` filters by `--state` and pages with `--limit`, `--cursor`, and
`--all --jsonl`. `actions approve <mailbox-id> <action-id>` and `actions deny <mailbox-id>
<action-id> [--reason <text>]` require a person different from the proposer, confirmation
(`--yes` outside a terminal), and offer `--dry-run`.
Human mailbox and extension results retain the same facts as JSON: mailbox endpoints (channel, address,
sender name, default), thread state and activity, message bodies, attachments, authentication and actor,
receipt waits and skipped recipients, held-mail results, and installation/run details.
`samva mailboxes events` reads the SDK event stream, which reconnects (`--no-reconnect` turns that
off), and prints one record per event, `{cursor, id, event}` (`--jsonl` wraps each in a result
envelope, `--quiet` prints none, `--json` is refused). A refusal, or a drop under
`--no-reconnect`, ends the command with the server's `_tag` as
the error `reason`, its `status` and `details`, and a `Try:` line; the last handled cursor, which
`--cursor` resumes from, goes to stderr in human mode and into `details.lastCursor` otherwise.
`samva extensions dev` follows the same output modes. 401 and 403 exit 4. An expired
cursor exits 1 and the next step is to start without `--cursor`. Ctrl+C exits cleanly.

`samva subscriptions subscribe` requests one email confirmation with `--email`,
`--topic-id`, and `--from`. Optional flags record signup context or select a template. A successful
receipt means the request was accepted; the contact and subscription are created after recipient
confirmation on the hosted page.

`samva topics` manages topics with `list`, `get`, `create`, `update`, `remove`, and `default`.
`subscriptions list <topic-id>` pages explicit records; `subscriptions check` resolves effective
status, including defaults, for exactly one `--contact-id`, `--email`, or `--phone` and `--channel`.
`subscriptions set <topic-id> --channel email --status subscribed|unsubscribed` writes explicit
status for repeatable `--contact-id`, `--email`, or `--phone` values, with optional `--source`.
Mutations support `--dry-run`; removal requires `--yes` outside a terminal. `--all --jsonl` streams
subscription pages. `samva campaigns report <campaignId> <runId>` shows an email run’s recipient report,
including delivery outcomes, replies, topic unsubscribes, and skip reasons. Opens and clicks are
directional unique-recipient counts with machine observations excluded; `--json` preserves the
`engagement.measurement` marker.

`campaigns create` requires `--topic-id`; replacing an audience with
`campaigns update` also requires it. `email send --topic-id` and `scheduled-messages create --topic-id` select the topic for that send.

The WhatsApp command family remains outside the released root command registry. Within that family,
`samva whatsapp status` lists connected numbers with verification and credential status, the default
marker, activity, quality, and messaging tier and limit. `--page` and `--limit` select a bounded page;
`--json` returns `{items, pagination}` inside the result envelope, using the API field names.
An empty organization succeeds with no items; human output points to the dashboard or
`samva whatsapp setup-links create` to connect a number. A disabled channel returns
`FlagDisabledError` (exit `4`). `samva whatsapp message status <id>` reads a WhatsApp message's
lifecycle status and waiting reason; `--json` returns `{id, channel, status, waitReason,
reviewExpectedAt, createdAt, updatedAt}`. An id belonging to another channel exits `1`.
