import { extname } from "node:path";

import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Predicate from "effect/Predicate";
import * as Organizations from "samva/effect/organizations";

import { CliUsageError, SamvaCliError, toCliApiError } from "../errors";
import { getClientConfig, getClientProvider, requestAuthHeaders } from "../lib/client";
import { printResult } from "../lib/output";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** PUT the image bytes to the upload URL the API returned; the response names the hosted image. */
const uploadBytes = Effect.fn("OrgAvatar.uploadBytes")(function* (
  uploadUrl: string,
  bytes: Uint8Array,
  contentType: string,
) {
  const config = yield* getClientConfig;
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetch(uploadUrl, {
        method: "PUT",
        headers: { ...requestAuthHeaders(config), "Content-Type": contentType },
        body: bytes as BodyInit,
        // A followed redirect could carry the credential to another origin.
        redirect: "manual",
        signal,
      }),
    catch: (cause) => new SamvaCliError({ message: `Avatar upload failed: ${String(cause)}` }),
  });
  const body: unknown = yield* Effect.promise(() => response.json().catch(() => undefined));
  if (response.ok && Predicate.isObject(body) && typeof body.src === "string") return body.src;
  return yield* Predicate.isObject(body) && typeof body._tag === "string"
    ? toCliApiError("Avatar upload failed", body)
    : new SamvaCliError({ message: `Avatar upload failed: HTTP ${response.status}` });
});

const set = Command.make("set", {
  file: Argument.String("file").pipe(Argument.withDescription("PNG, JPEG, or WebP image")),
}).pipe(
  Command.withDescription(
    "Upload an image and make it the organization's avatar. Samva stores a square crop of its center.",
  ),
  Command.withExamples([
    { command: "samva org avatar set logo.png", description: "Set the organization avatar" },
  ]),
  Command.withHandler(({ file }) =>
    Effect.gen(function* () {
      const contentType = CONTENT_TYPES[extname(file).toLowerCase()];
      if (contentType === undefined) {
        return yield* new CliUsageError({
          code: "avatar_unsupported_type",
          message: `${file} is not a PNG, JPEG, or WebP image.`,
        });
      }
      const fs = yield* FileSystem.FileSystem;
      const bytes = yield* fs.readFile(file).pipe(
        Effect.mapError(
          () =>
            new CliUsageError({
              code: "avatar_unreadable",
              message: `Could not read ${file}.`,
            }),
        ),
      );
      const client = yield* getClientProvider;
      const target = yield* Organizations.createAvatarUpload().pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not start the avatar upload", error)),
      );
      if (!target.contentTypes.includes(contentType)) {
        return yield* new CliUsageError({
          code: "avatar_unsupported_type",
          message: `${file} is ${contentType}; the avatar accepts ${target.contentTypes.join(", ")}.`,
        });
      }
      if (bytes.byteLength > target.maxBytes) {
        return yield* new CliUsageError({
          code: "avatar_too_large",
          message: `${file} is ${bytes.byteLength} bytes; the avatar accepts at most ${target.maxBytes}.`,
        });
      }
      const src = yield* uploadBytes(target.uploadUrl, bytes, contentType);
      const organization = yield* Organizations.update({ avatarUrl: src }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not save the avatar", error)),
      );
      yield* printResult(
        { action: "org.avatar.set", slug: organization.slug, avatarUrl: organization.avatarUrl },
        `Avatar set for "${organization.slug}".`,
      );
    }),
  ),
);

const clear = Command.make("clear").pipe(
  Command.withDescription(
    "Remove the organization's avatar; the generated glyph shows in its place",
  ),
  Command.withExamples([
    { command: "samva org avatar clear", description: "Remove the organization avatar" },
  ]),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const organization = yield* Organizations.update({ avatarUrl: null }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not remove the avatar", error)),
      );
      yield* printResult(
        { action: "org.avatar.clear", slug: organization.slug, avatarUrl: null },
        `Avatar removed for "${organization.slug}".`,
      );
    }),
  ),
);

export const orgAvatarCommand = Command.make("avatar").pipe(
  Command.withDescription("Set or remove the organization's avatar"),
  Command.withSubcommands([set, clear]),
);
