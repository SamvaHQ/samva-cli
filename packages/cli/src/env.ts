/**
 * The CLI's environment module — the single legitimate reader of `process.env`.
 *
 * Cloudflare Workers (apps/api, apps/web) get their env from bindings, so the
 * `node/no-process-env` lint rule steers them to typed env modules. A CLI runs
 * as a normal Node process, where `process.env` *is* the source of truth; this
 * file is the env module for it (the rule exempts env-module paths). Read env here and
 * nowhere else.
 */

const env = process.env;

/** An empty variable (a CI expansion of an unset secret) means unset. */
const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

/** API key for authenticated calls (`samva email send`, `samva org list`, …). */
export const SAMVA_API_KEY = nonEmpty(env["SAMVA_API_KEY"]);

/** API base URL override; falls back to config then the production default. */
export const SAMVA_API_URL = nonEmpty(env["SAMVA_API_URL"]);

/** Named execution profile override for humans, CI, and agents. */
export const SAMVA_PROFILE = nonEmpty(env["SAMVA_PROFILE"]);

/** OAuth organization override; rejected when SAMVA_API_KEY is in use. */
export const SAMVA_ORG = nonEmpty(env["SAMVA_ORG"]);

/** XDG config root; the CLI stores state under `$XDG_CONFIG_HOME/samva`. */
export const XDG_CONFIG_HOME = nonEmpty(env["XDG_CONFIG_HOME"]);

/** User home directory (used when `XDG_CONFIG_HOME` is unset). */
export const HOME = nonEmpty(env["HOME"]) ?? nonEmpty(env["USERPROFILE"]);
