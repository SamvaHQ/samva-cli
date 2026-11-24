import { operationHints, type PublicOperation } from "@samva/contracts/surface/operations";
import { Effect, FileSystem, Option, Schema, SchemaAST } from "effect";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { identity } from "effect/Function";

import { CliUsageError } from "../../errors";
import { yesFlag } from "../confirm";
import { readStdinUtf8 } from "../stdin";
import { derivedClient, type DerivedRequest } from "./client";
import { deriveOverride } from "./curated";
import { argumentOf, fieldsOf, flagOf, kebab } from "./flags";
import { renderHuman } from "./render";

const invalidInput = (message: string) =>
  new CliUsageError({ code: "invalid_operation_input", message });

const readData = Effect.fn("CliDerived.readData")(function* (source: string) {
  const text =
    source === "-"
      ? yield* readStdinUtf8.pipe(Effect.mapError((error) => invalidInput(error.message)))
      : source.startsWith("@")
        ? yield* (yield* FileSystem.FileSystem)
            .readFileString(source.slice(1))
            .pipe(Effect.mapError(() => invalidInput(`Could not read ${source.slice(1)}.`)))
        : source;
  return yield* Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: () => invalidInput("--data must contain valid JSON."),
  });
});

const toggle = (name: string, description: string) =>
  Flag.Boolean(name).pipe(Flag.withDescription(description), Flag.withDefault(false));

const supplied = (record: Readonly<Record<string, Option.Option<unknown>>>) =>
  Object.fromEntries(
    Object.entries(record).flatMap(([field, value]) =>
      Option.isSome(value) ? [[field, value.value]] : [],
    ),
  );

const parsePayload = (
  codec: Schema.Top,
  source: string | undefined,
  flags: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    if (source === undefined) return flags;
    if (Object.keys(flags).length > 0) {
      return yield* invalidInput("Pass either --data or individual payload flags.");
    }
    return yield* readData(source).pipe(Effect.flatMap(decode(codec.ast)));
  });

// Public HTTP request codecs have no application service dependencies.
const codecFor = (ast: SchemaAST.AST) => Schema.make<Schema.Codec<unknown>>(ast);
const strict = { onExcessProperty: "error" } as const;
const decode = (ast: SchemaAST.AST) => (value: unknown) =>
  Schema.decodeUnknownEffect(
    codecFor(ast),
    strict,
  )(value).pipe(Effect.mapError((error) => invalidInput(error.message)));
const validate = (codec: Schema.Top, value: unknown) =>
  Schema.encodeUnknownEffect(
    codecFor(codec.ast),
    strict,
  )(value).pipe(Effect.mapError((error) => invalidInput(error.message)));

const shapeFields = (schema: Schema.Top | undefined) => {
  const list = schema === undefined ? [] : [...fieldsOf(schema.ast)];
  return Object.fromEntries(
    list.flatMap(([field, types]) => {
      const candidate = flagOf(field, types);
      return candidate === undefined ? [] : [[field, candidate.flag]];
    }),
  );
};

export const deriveCommand = (operation: PublicOperation, name = kebab(operation.endpoint)) => {
  const { readOnly, destructive } = operationHints(operation);
  const codecs = operation.payload.get("application/json")?.schemas;
  const payloadCodec =
    codecs === undefined ? undefined : codecs.length === 1 ? codecs[0] : Schema.Union(codecs);
  const pathFields = operation.params === undefined ? undefined : fieldsOf(operation.params.ast);
  const params = Object.fromEntries(
    Array.from(operation.path.matchAll(/:[A-Za-z0-9_]+/g), ([segment]) => {
      const field = segment.slice(1);
      return [field, argumentOf(field, pathFields?.get(field) ?? [])];
    }),
  );
  // Opaque cursors and dates have a scalar wire spelling but a richer decoded type.
  const queryFields = shapeFields(operation.query);
  const wireQuery = new Map<string, SchemaAST.AST>();
  const queryAst = operation.query?.ast;
  if (queryAst !== undefined && SchemaAST.isObjects(queryAst)) {
    for (const { name: field, type } of queryAst.propertySignatures) {
      if (typeof field !== "string" || (field !== "cursor" && field in queryFields)) continue;
      if (!SchemaAST.isString(SchemaAST.toEncoded(type))) continue;
      queryFields[field] = Flag.String(kebab(field)).pipe(
        Flag.withDescription(SchemaAST.resolveDescription(type) ?? `Filter by ${kebab(field)}`),
        Flag.optional,
      );
      wireQuery.set(field, type);
    }
  }
  const flags = {
    params,
    query: queryFields,
    headers: operation.idempotent ? shapeFields(operation.headers) : {},
    payload: shapeFields(payloadCodec),
    ...(payloadCodec === undefined
      ? {}
      : {
          data: Flag.String("data").pipe(
            Flag.withMetavar("json|@file|-"),
            Flag.withDescription(
              "Supply the complete payload inline, from @file, or from stdin (-).",
            ),
            Flag.optional,
          ),
        }),
    ...(operation.paginated ? { all: toggle("all", "Follow every page of results") } : {}),
    ...(destructive ? { yes: yesFlag() } : {}),
    ...(readOnly
      ? {}
      : { dryRun: toggle("dry-run", "Validate and preview the request without sending it") }),
  };

  interface Request extends DerivedRequest {
    readonly continuation?: string | undefined;
  }
  const connect = derivedClient(operation).pipe(
    Effect.map((call) => ({ continuation, ...request }: Request) => {
      if (continuation === undefined) return call(request);
      const cursorCodec = wireQuery.get("cursor");
      return (
        cursorCodec === undefined ? Effect.succeed(continuation) : decode(cursorCodec)(continuation)
      ).pipe(Effect.flatMap((cursor) => call({ ...request, query: { ...request.query, cursor } })));
    }),
  );
  type CallError = Effect.Error<ReturnType<Effect.Success<typeof connect>>>;
  type HumanRenderServices = Effect.Services<ReturnType<typeof renderHuman>>;
  return deriveOverride<
    string,
    typeof flags,
    Request,
    unknown,
    CallError,
    CallError,
    CliUsageError,
    FileSystem.FileSystem,
    never,
    HumanRenderServices,
    never,
    HumanRenderServices
  >(name, flags, {
    prepare: (input): Effect.Effect<Request, CliUsageError, FileSystem.FileSystem> =>
      Effect.gen(function* () {
        const query = supplied(input.query);
        for (const [field, ast] of wireQuery) {
          if (Object.hasOwn(query, field)) query[field] = yield* decode(ast)(query[field]);
        }
        const headers = supplied(input.headers);
        const payload =
          payloadCodec === undefined
            ? undefined
            : yield* parsePayload(
                payloadCodec,
                input.data === undefined ? undefined : Option.getOrUndefined(input.data),
                supplied(input.payload),
              );
        if (operation.params !== undefined) yield* validate(operation.params, input.params);
        if (operation.query !== undefined) yield* validate(operation.query, query);
        if (payloadCodec !== undefined) yield* validate(payloadCodec, payload);
        if (operation.headers !== undefined) yield* validate(operation.headers, headers);

        const request: Request = {
          ...(operation.params === undefined ? {} : { params: input.params }),
          ...(operation.query === undefined ? {} : { query }),
          ...(payloadCodec === undefined ? {} : { payload }),
          ...(operation.headers === undefined ? {} : { headers }),
        };
        return request;
      }),
    connect,
    mapOutput: (result) => result ?? null,
    render: (result) =>
      renderHuman(result, readOnly ? undefined : `Completed ${operation.operationId}.`),
    preview: {
      data: (request) => ({
        dryRun: true,
        method: operation.method,
        path: operation.path,
        ...request,
      }),
      render: () => renderHuman(undefined, `Dry run: ${operation.method} ${operation.path}`),
    },
    ...(destructive
      ? {
          confirmation: () => ({
            message: `Confirm ${operation.operationId}?`,
            nonInteractiveMessage:
              "Pass --yes to confirm, or use --dry-run to preview the request.",
          }),
        }
      : {}),
    ...(operation.paginated
      ? {
          paginate: {
            start: () => undefined,
            withCursor: (request, continuation) => ({ ...request, continuation }),
          },
        }
      : {}),
  }).pipe(
    Command.withDescription(operation.description ?? operation.summary ?? ""),
    // A parent's subcommand list shows the one-line summary; the full description stays on the
    // command's own help.
    operation.summary === undefined ? identity : Command.withShortDescription(operation.summary),
  );
};
