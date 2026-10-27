# @samva/cli

Samva is the email API for your app: transactional and campaign sending, inbound mail, and webhooks behind one API.

The `samva` CLI sends and operates email from a terminal. The npm package includes
the JavaScript implementation and selects a self-contained native executable when
one is available. Template authoring commands run the project's `@samva/vite`
toolchain under Node.js 22 or newer.

## Install

```sh
npm install -g @samva/cli
samva --help
```

The npm package prefers the matching macOS or Linux executable. If npm omits
optional dependencies, the same command falls back to the packaged JavaScript
implementation when Bun is installed. Native executables for each platform, with a `SHA256SUMS`
file, are also attached to the CLI's [GitHub releases](https://github.com/SamvaHQ/samva-cli/releases),
beside its source.

## Shell completions

Generate a completion script from the installed CLI. Regenerate it after upgrading the CLI.

```sh
# Bash
samva --completions bash >> ~/.bashrc

# Zsh
mkdir -p ~/.zsh/completions
samva --completions zsh > ~/.zsh/completions/_samva
# Add ~/.zsh/completions to fpath, then run `autoload -Uz compinit && compinit` in .zshrc.

# Fish
mkdir -p ~/.config/fish/completions
samva --completions fish > ~/.config/fish/completions/samva.fish

# sh is an alias for the Bash-compatible script
samva --completions sh
```

## Authentication and execution context

For agents and CI, set an organization-scoped API key:

```sh
export SAMVA_API_KEY="samva_sk_live_..."
```

For interactive use, sign in with OAuth and choose an organization:

```sh
samva login
samva org list
samva org use <slug>
```

`SAMVA_API_KEY` takes precedence over a stored OAuth credential. An API key is already scoped to
one organization, so `--org` and `SAMVA_ORG` are rejected when it is set. With OAuth, organization
selection resolves as `--org`, then `SAMVA_ORG`, then the selected profile's organization.

`samva login` is interactive. In a non-TTY, use `SAMVA_API_KEY` for automation or explicitly choose
the device flow with `samva login --no-browser`; `--no-input`, `--json`, and `--jsonl` reject login.
If a stored OAuth record is malformed, run `samva logout` and then `samva login`; API-key calls do
not read or decode stored OAuth credentials.

Profiles hold non-secret organization settings. Credentials stay in the OS keyring.

```sh
samva profile create acme --org acme
samva profile use acme
samva --profile acme email doctor
```

The profile resolves as `--profile`, then `SAMVA_PROFILE`, then the active profile, then `default`.
The API URL resolves as `--api-url`, then `SAMVA_API_URL`, then `https://api.samva.dev`. Profiles
do not select an API; a config whose profile sets `target` fails to load and names these overrides.

## Common operations

```sh
# Send an inline email. --to is repeatable.
samva email send --to ada@example.com --subject "Hello" --text "Hi!"

# Pipe the plain-text body from stdin.
printf 'Hi from a pipeline' | samva email send \
  --to ada@example.com --subject "Hello" --text -

# Pipe a rendered HTML body from stdin.
render-email | samva email send \
  --to ada@example.com --subject "Hello" --html -

# Render a published template.
samva email send --to ada@example.com --template-slug welcome-email \
  --template-data '{"name":"Ada"}'

# Wait for delivery or a terminal delivery outcome.
samva email send --to ada@example.com --subject "Hello" --text "Hi!" \
  --wait --timeout 2m

# Inspect a message and its events.
samva messages get <message-id>
samva messages events <message-id> --json

# Inspect configuration and remote email state without mutating it.
samva email doctor --json

# Read and set organization open/click tracking defaults.
samva email tracking defaults get
samva email tracking defaults set --opens on --clicks off

```

## DKIM rotation

Stage a new selector with an explicit retry key:

```sh
samva email domains rotate-dkim dom_abc123 --idempotency-key rotation-2026-09 --dry-run
samva email domains rotate-dkim dom_abc123 --idempotency-key rotation-2026-09 --json
```

Reuse the same key for retries. Publish the returned `record`, then run
`samva email domains check dom_abc123` to advance verification and cut over.
Keep `formerRecord` published. `minimumRetainUntil` is only a minimum retention horizon;
retirement requires separate approval and verification that at least two actual former-record
TTLs have elapsed. The command never removes DNS records.

## Template projects

Create a starter-backed project, or clone an existing template project. Samva creates the project
identity and Artifact repository; Git owns the local checkout and synchronization:

```sh
samva templates init --name "Welcome email" --dir welcome-email
# samva templates clone tproj_abc123 --dir welcome-email
cd welcome-email
bun install --frozen-lockfile
bun run dev
```

The starter repository contains `@samva/markup`, `@samva/vite`, Vite, the project theme, and its
lockfile. The CLI deliberately loads `@samva/vite` from the current project, so local preview,
check, render, and build use the compiler version recorded in that lockfile. A project without
`@samva/markup`, `@samva/vite`, and `vite` fails with the install command
(`npm install --save-dev @samva/markup @samva/vite vite`). The clone has a normal HTTPS
`origin`; its repository-local credential helper obtains a one-hour, repository-scoped Artifact
credential from Samva when Git needs one. The credential is not written to the remote URL or Git
configuration.

```sh
samva templates dev
samva templates check
samva templates check --json
samva templates render welcome --fixture default
samva templates snapshot welcome --fixture default
samva templates build --out dist/templates.json
samva templates check --watch
samva templates check --watch --jsonl
git add templates theme.css
git commit -m "feat: update welcome email"
git push origin main
samva templates publish --commit HEAD --json
```

A project holds as many emails as you need, sharing its components, theme, and lockfile. Write
another entry, register it, then publish every entry at one commit:

```sh
samva templates add templates/reset.tsx
git add templates && git commit -m "feat: add password reset" && git push origin main
samva templates publish --all
```

`add` uses the entry's `defineTemplate` id as the template's handle; pass `--slug` and `--name` to
choose others or to register an entry before the file exists. `publish --all` publishes every
active template in the project, reports each result, exits non-zero when any entry failed, and
lists `defineTemplate` files under `templates/` or `emails/` that are not registered. Rerunning it after a partial failure is safe.
After `git mv`, `samva templates move <old-path> <new-path>` points the template at the new file
and keeps its id, handle, and publications.

Templates live in `templates/`, and `emails/` is also recognized; every authoring command scans
whichever exist, and `--dir <dir>` scans only that one. A template is a `.tsx` file that
default-exports `defineTemplate` with an input schema, declared fixtures, and an `email`, `sms`, or
`whatsapp` body. The compiler reads the file without running it, so top-level code in a template
does not execute. `check` type-checks the project, compiles every template, and renders every
fixture through every channel the template declares; `build` writes those rendered fixtures, each
template's input schema, and its compiled template. Modules without a template default export are
helpers, and every template needs a unique id.

The JSON file written by `build` uses `schemaVersion: 4`. Its `result` is the `@samva/vite/build`
result: `files[]`, one per template entry, each with `ok`, `diagnostics`, and a `template` carrying
`template` (the id), `channels`, `source`, `inputSchema`, `compiled`, `fixtures[]` (each with its `email`
subject, preheader, HTML and text, its `sms` text, or its `whatsapp` message), and `compatibility`
findings. The former `preview.kind` `"email"` and `"structured"` shapes no longer exist. The CLI's
stdout envelope remains version 1.

For imported email assets, pass their actual serving base to `check` or `build`, for example
`samva templates build --out dist/templates.json --asset-base https://cdn.example.com/email`.
These commands require an HTTPS base for delivery; they do not invent a URL or upload assets.
`templates export --out dist/email` remains the way to write a local HTML/text export
with relative asset URLs, plus `<fixture>.sms.txt` and `<fixture>.whatsapp.json` for those channels.
Like `check` and `build`, it treats the current directory as the project: its `theme.css` themes
the export and `samva:brand` resolves live or from `.samva/brands`.

`git fetch`, `git pull`, `git add`, `git commit`, and `git push` are ordinary Git operations.
The next hosted workspace open picks up a pushed commit, rebases independent draft edits, and
records explicit conflicts for overlapping edits.

The CLI's `init` and `clone` commands configure the repository-local helper; `publish` does not push
for you. It accepts a clean commit that is reachable from the fetched `origin/<default-branch>`
and publishes that exact commit. A clone records its project in `samva.projectId`; pass
`--project-id` from a checkout that `samva templates init` or `clone` did not create.

The helper is invoked by Git using its credential protocol. It accepts only an HTTPS host and path
matching the project's repository, then exchanges the current Samva credential for a read or write
Artifact credential. `samva templates credential` is an internal helper command, not a general
credential store. Local OAuth credentials remain in the OS keyring; `SAMVA_API_KEY` remains the
automation path.

`samva templates dev [--dir <dir>] [--port <n>] [--host <name>] [--open]` starts the local visual
editor from the project's `@samva/vite/dev` under Node.js, with no `vite.config.ts`. It prints the
editor URL and runs until interrupted; `SIGINT` and `SIGTERM` close the server.

The CLI supplies Samva brand resolution to `dev`, `check`, `build`, `render`, `snapshot` and
`export`. An imported `samva:brand` uses `SAMVA_API_KEY` from the environment or project `.env`
(and `SAMVA_API_URL` for another endpoint), or `samva brands get --json` on `PATH` with your login
session. Live answers refresh `.samva/brands/<slug>.json`; an unavailable live brand falls back to
that snapshot with `brand-offline`. A changed live digest reports `brand-snapshot-stale`. With
neither a live answer nor a snapshot, the command fails with `brand-unavailable`. Keep `.samva/`
gitignored. Standalone `@samva/vite` callers configure a resolver themselves.

`samva templates check` runs the project's TypeScript configuration, then uses the project's
`@samva/vite/build` to compile every template, render every fixture, and report located findings
plus email-client compatibility findings. It writes no files and exits non-zero on TypeScript,
compile, fixture, or breaking compatibility errors. `--watch` reuses one compiler session across
template, dependency, and theme changes. Human mode prints each observation; machine watch mode
requires `--jsonl`. `--json` remains a bounded one-shot result. `SIGINT` and `SIGTERM` close the
watcher and keep the CLI's documented interrupt exit codes.

Every finding in `check --json` (`problems[]`), `build --json`, `render --json`, and `export --json`
has the same fields: `code`, `severity`, `message`, `file`, `line` and `column` when located,
`range` (the located extent), `fix` (what to write instead) when the compiler has one, and `edit`
(a machine-applicable change) when it offers one; `check` and `build` add `phase`, and a finding
tied to one fixture names it in `fixture`. Human output prints
`file:line:column severity code: message` and the fix beneath it. `check --json` also carries
`warnings[]` for compile warnings and `compatibility` for client findings.

`samva templates render <template> --fixture <name>` renders one fixture of a local template
through the project's `@samva/vite/render`. `<template>` is a template id or its `.tsx` path.
`--channel email|sms|whatsapp` picks the body (default `email`), `--locale` and `--time-zone`
set formatter locale and IANA zone, `--asset-base` and `--offline` behave as for `check`, and
`--dir` narrows discovery. The default output is the subject, preheader, and plain-text body;
`--format html` prints the HTML and `--format json` (or `--json`) prints
`{ action: "templates.render", ok, template, fixture, subject, preheader?, html, text, diagnostics }`
(an SMS render carries `channel` and `text`; a WhatsApp render carries `channel` and `message`).
`--out <file>` writes the selected format to a file. A template or fixture that does not exist, or
a template that does not compile, exits `1` with located findings; an unknown name lists the valid
ones.

`samva templates snapshot <template> --fixture <name>` renders the email and screenshots it in a
headless browser at `desktop` (1280px) and `mobile` (390px) widths, in `light` and `dark` color
schemes, as full-page PNGs at `<out>/<template>-<fixture>-<viewport>-<scheme>.png` (default
`--out .samva/snapshots`). `--viewport desktop,mobile` and `--scheme light,dark` narrow the set.
`--json` prints `{ action: "templates.snapshot", ok, template, fixture, browser, out, files: [{ viewport,
scheme, width, path }] }`. The browser is the `playwright` (or `playwright-core`) your project
installs; without it, a system Google Chrome or Chromium, found in the usual locations or at
`SAMVA_CHROME`. With neither the command fails and names both remedies. Screenshots emulate the
color scheme; they do not reproduce a particular mail client's rendering.

`samva templates build` runs the same compiler gate and writes the complete compiled result as a
versioned JSON artifact for package and deployment pipelines. Its terminal/JSON result stays
bounded and reports only the destination, compiler version, and file count.

`samva templates publish` resolves the requested revision to an exact commit, verifies the working
tree is clean and the commit is an ancestor of the fetched `origin` default branch, then creates an
immutable publication receipt for each selected entry: the named entry, every active entry with
`--all`, or the project's only entry. It does not rewrite Git history or alter the working tree.

`templates list`, `get`, `create`, `update`, and `remove` operate on template metadata. They do not
replace the project repository, workspace, or native Git history. `remove` deactivates a template;
its file and publications remain.

Inline email requires `--subject` and exactly one body source: `--html` or `--text`. Pass `-` as
the value to read that body from stdin: `--text -` reads a plain-text body and `--html -` reads an
HTML body. Only one body may come from stdin, so passing both `--text -` and `--html -` is rejected.
Template sends use exactly one of `--template-id` or `--template-slug`, with optional
`--template-data`, and omit `--subject`.

`--wait` polls until the message is delivered or read, or reaches a terminal failure. It defaults
to a two-minute timeout. `--timeout` is valid only with `--wait`, and `--wait` cannot combine with
`--dry-run`, since a dry run makes no API call and has nothing to wait on. A timeout or terminal
delivery failure returns non-zero after printing the last message state.

## Brands

A template reaches its organization's brand with `@import "samva:brand";` (the default brand) or
`"samva:brand/<slug>"` in `theme.css`. The brand lives in Samva, not in the project, and these
commands work with it:

```sh
samva brands list
samva brands get acme --json
samva brands pull              # the default brand
samva brands pull acme
samva brands push brand.css --brand acme --dry-run
samva brands push brand.css    # updates the default brand
samva brands push brand.css --name "Acme"   # also renames it
```

`samva brands pull [slug]` writes `.samva/brands/<slug>.json` in the project (`--project <dir>`,
default the current directory). `@samva/vite` resolves `samva:brand` from that snapshot when it
cannot reach the live brand, so builds and previews work offline. Pull never touches `theme.css`;
keep `.samva` in `.gitignore`, because the API owns the brand.

`samva brands push <file>` validates the file against the brand CSS grammar before uploading:
`@theme` variables, one dark-mode `@theme` of colors, and `@font-face` rules with https WOFF2
sources. CSS outside it exits `1` with every finding located at `file:line:column`, and nothing is
uploaded. `--brand <slug>` names the brand to replace; without it, push updates the organization's
default brand. `--name <name>` also sets the brand's display name in the same update. `--dry-run` validates without credentials or an API call. Published templates keep
the brand they were built against until they are republished.

## Scheduling and campaigns

```sh
samva scheduled-messages create --to ada@example.com --template-slug welcome-email \
  --template-data '{"name":"Ada"}' --at 2026-08-01T09:00:00Z \
  --timezone America/New_York --idempotency-key welcome-ada
samva scheduled-messages list --status pending
samva scheduled-messages get <scheduled-message-id>
samva scheduled-messages cancel <scheduled-message-id> --yes

samva campaigns create --name "August launch" --template-slug august-launch \
  --include-tags newsletter
samva campaigns runs create <campaign-id> --at 2026-08-01T09:00:00Z \
  --idempotency-key august-launch
samva campaigns runs recipients <campaign-id> <run-id> --status failed
```

`--at` is an absolute ISO 8601 instant. `--timezone` is display and audit metadata for a
scheduled message. Campaign definitions freeze after their first run. Cancelling a scheduled
message or campaign run requires confirmation, and dispatch already in progress may still finish.

## Contacts

```sh
samva contacts list --search ada --limit 25
samva contacts list --fields plan,score --json
samva contacts list --custom-field plan --custom-field-value '"pro"' --json
samva contacts list --all --jsonl
samva contacts get contact_7q2xk9mvt4znw8rh --json
```

`list` returns a bounded page with a `nextCursor`; pass it as `--cursor` to resume. `--fields`
selects the custom-field keys included in each summary. Exact custom-field filtering requires
both `--custom-field` and `--custom-field-value`, with the value encoded as a JSON scalar
(for example `'"pro"'`, `42`, `true`, or `null`). `--search`, `--status`, `--after`, and `--before`
combine with that filter. `get` returns the contact's identities, profile, custom fields, and metadata.
If a list page fails, machine-readable stderr includes `details.cursor`. Retry with that
`--cursor` and the same filters to resume after the contacts already printed; a null cursor means
the first page failed, so retry without `--cursor`.

## Automation contract

Use `--dry-run` on supported mutations to validate input and preview the intended request. `email
send --dry-run` does not use credentials or call the API. Other previews may read state when needed
to show the resulting change. Destructive operations prompt in a TTY; automation must use `--yes`,
or it fails without changing state. `--no-input` prevents prompts and browser launches.

```sh
# Review a request without authentication or an API call.
samva email send --to ada@example.com --subject "Hello" --text "Hi!" --dry-run --json

# Traverse every page as one JSON record per line.
samva messages list --all --jsonl

# Suppress successful human output.
samva --quiet profile use acme
```

`--json` writes one bounded, versioned result envelope to stdout:
`{schemaVersion:1,type:"result",command,data}`. For resource lists, `--jsonl` writes one flat,
independently parseable outer result envelope per resource. Errors use the corresponding
`{schemaVersion:1,type:"error",command,reason,message,status?,details?,next?}` envelope on stderr and exit
non-zero. API errors use their `_tag` as `reason`, their HTTP status as `status`, and their
public fields as `details`. Fix `details.fields` and follow `next` before retrying. API 401 and 403
exit with code `4`. Human mode prints the same message and a `Try:` line. `--json`, `--jsonl`, and `--quiet` are mutually exclusive; assignment forms such as
`--json=true` are usage errors. `--quiet` suppresses successful output only. In machine modes,
stdout contains only result data; warnings and errors go to stderr.

Lists are paginated by default. Use `--limit` for a bounded page and `--cursor` with the printed `nextCursor` for the next one. `--all` requires
`--jsonl`, so an automated traversal stays streamable rather than producing an unbounded JSON
document. `--all` changes traversal only: bounded and unbounded JSONL records have the same outer
envelope, with the resource itself in `data`. Empty lists emit no records.

Exit codes are stable for automation:

|  Code | Meaning                                                                  |
| ----: | ------------------------------------------------------------------------ |
|   `0` | Success                                                                  |
|   `1` | API, operational, or terminal delivery failure                           |
|   `2` | Command syntax, validation, configuration, or confirmation failure       |
|   `4` | Authentication or organization-context failure, incl. an expired session |
| `124` | Wait or credential timeout                                               |
| `130` | Interrupted with `SIGINT`                                                |
| `143` | Terminated with `SIGTERM`                                                |

When `--json` or `--jsonl` is set, failures are emitted as JSON diagnostics on stderr, while stdout
remains a clean data stream. Lifecycle timeout, terminal delivery failure, and a later observation
failure are the intentional exception: they first preserve the last authoritative Message in a
result envelope with `partial:true` on stdout.

`samva webhooks test` is another result-bearing failure: an endpoint timeout, transport failure, or
non-2xx response preserves the complete test result on stdout, emits a typed diagnostic on stderr,
and exits `1`. Unlike lifecycle polling, that result is complete and does not set `partial:true`.

## Help and command map

```sh
samva --help
samva help --json
samva email send --help
```

Released top-level commands are `login`, `logout`, `org`, `email`, `messages`, `campaigns`,
`contacts`, `scheduled-messages`, `templates`, `brands`, `webhooks`, `profile`, and `help`. Use `samva <command> --help`
for flags and runnable examples.

Test a configured webhook against its real endpoint with an optional JSON payload. `--data` accepts
inline JSON or `@file`; omit it for Samva's default test event. `--dry-run` validates and previews
the request without credentials, an API call, or an endpoint delivery.

```sh
samva webhooks test wep_abc123 --dry-run
samva webhooks test wep_abc123 --data '{"event":"webhook.test"}' --json
samva webhooks test wep_abc123 --data @payload.json --json
```

`samva email doctor` reports resolved profile, API URL, auth source, organization access, the send
review decision, sendable domain and verified sender counts, and domain-verification readback.
`readyToSend` is true when a production send would be admitted and at least one domain or sender can
carry it. It is read-only and does not inspect receiving configuration, check DNS itself, send an
email, or replay fixtures.
Each check is `passed`, `failed`, or
`unavailable`. A `failed` check carries the underlying error detail; `unavailable`, such as no
sending domain yet or a review in progress, is informational; a rejected review fails. The command always prints the full report, then
exits `1` if any check failed and `0` otherwise. The `--json` result's `data` adds an aggregate
`ok` boolean, and human output marks checks with `✓`, `!`, and `✗` respectively.

Use `samva email receiving status <domain-id>` to read a domain's receiving prerequisites in
order: sending verified, a destination, receiving enabled, and the inbound MX, which it looks up
live and names when mail is routed elsewhere.
`samva email receiving enable <domain-id> --domain <name> --catch-all [--endpoint <webhook-id>]`
routes every address on a verified domain. A catch-all needs a destination, either `--endpoint` or
an active forwarding rule that covers the domain; mail that matches neither is rejected. Pass
`--address` for exact recipients instead. The command acts by default; its `--dry-run` is offline
and does not require credentials or call the API.

A command that needs a subcommand, such as a bare `samva` or a group like `samva email`, prints its
help to stdout and exits `2`, so a script never mistakes a missing subcommand for success.

### Topics and subscription preferences

Create a topic with `samva topics create --name Newsletter --default opt_in`.
Use its id in `samva campaigns create --topic-id <id> ...`, or select it for a direct
email with `samva email send --topic-id <id> ...`.

`samva topics subscriptions check --email ada@example.com --channel email --json`
returns effective preferences, including topic defaults. Explicit status is written with
`samva topics subscriptions set <id> --email ada@example.com --channel email --status subscribed
--source import --json`. Both subscribed and unsubscribed are durable statuses.
For recipient-confirmed consent, use `samva subscriptions subscribe --topic-id <id>
--email ada@example.com --from news@example.com --json`; acceptance waits for recipient confirmation.

Topic mutations accept `--dry-run`. Removal uses `topics remove <id> --yes` outside a terminal.
`topics subscriptions list <id> --limit 20 --json` reads one page; `--all --jsonl` streams every page.
