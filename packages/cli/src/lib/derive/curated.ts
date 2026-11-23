import { Context, Effect, Predicate, References } from "effect";
import * as Command from "effect/cli/Command";
import type * as HttpClient from "effect/http/HttpClient";
import type * as Client from "samva/effect/client";

import type { ExecutionContext } from "../../config/store";
import { CliUsageError, SamvaCliError, toCliApiError } from "../../errors";
import { getClientProvider, getClientProviderForContext } from "../client";
import { confirmDestructive } from "../confirm";
import { printJson, printJsonDocument, printJsonLine } from "../output";
import { isJsonLinesRequested, isJsonRequested, outputModeFromArgv } from "../runtime";
import type { DerivedRequest } from "./client";
import { renderDerived, renderHuman } from "./render";

/** Distinguish registered operation commands from command-local workflows. */
export const OperationCommand = Context.Reference<boolean>("@samva/cli/OperationCommand", {
  defaultValue: () => false,
});

/** Preserve a released grammar while sharing the contract transport and object renderer. */
export const withContractRead = <Input extends { readonly json: boolean }>(
  operationId: `${string}.${string}`,
  failureMessage: string,
  request: (input: Input) => DerivedRequest,
) => {
  const separator = operationId.indexOf(".");
  const group = operationId.slice(0, separator);
  const endpoint = operationId.slice(separator + 1);
  const withHandler = Command.withHandler(
    Effect.fnUntraced(function* (input: Input) {
      const { derivedClient } = yield* Effect.promise(() => import("./client"));
      const call = yield* derivedClient({ operationId, group, endpoint }, failureMessage);
      const result = yield* call(request(input));
      return yield* input.json ? printJson(result) : renderDerived(result);
    }),
  );
  return <Name extends string, ContextInput, E, R>(
    command: Command.Command<Name, Input, ContextInput, E, R>,
  ) => command.pipe(withHandler, Command.annotate(OperationCommand, true));
};

type Config = Command.Command.Config;
type InputOf<Flags extends Config> = Command.Command.Config.Infer<Flags>;
type PageItem<A> = A extends { readonly items: ReadonlyArray<infer Item> } ? Item : never;

interface Override<
  Input,
  Request,
  Result,
  CallError,
  MapError,
  PrepareError,
  PrepareServices,
  OutputError,
  OutputServices,
  PreviewError,
  PreviewServices,
> {
  readonly mapInput?: (input: Input) => Request;
  readonly prepare?: (input: Input) => Effect.Effect<Request, PrepareError, PrepareServices>;
  readonly failure?:
    | string
    | ((error: CallError, request: NoInfer<Request>, input: Input) => MapError);
  readonly render?: (
    result: NoInfer<Result>,
    input: Input,
    request: NoInfer<Request>,
  ) => Effect.Effect<void, OutputError, OutputServices>;
  readonly mapOutput?: (
    result: NoInfer<Result>,
    input: Input,
    request: NoInfer<Request>,
  ) => unknown;
  readonly document?: true;
  readonly preview?: {
    readonly data: (request: NoInfer<Request>, input: Input) => unknown;
    readonly render?: (
      request: NoInfer<Request>,
      input: Input,
    ) => Effect.Effect<void, PreviewError, PreviewServices>;
  };
  readonly confirmation?: (
    request: NoInfer<Request>,
    input: Input,
  ) => {
    readonly message: string;
    readonly nonInteractiveMessage: string;
  };
  readonly paginate?: {
    readonly withCursor: (
      request: NoInfer<Request>,
      cursor: string | undefined,
    ) => NoInfer<Request>;
    readonly start: (request: NoInfer<Request>) => string | undefined;
    readonly mapItem?: (item: PageItem<NoInfer<Result>>) => unknown;
    readonly stopOnEmpty?: true;
  };
}

/** Bind a command-local HTTP adapter to the execution services once. */
export const connectOperation = <Request, Result, E, R>(
  call: (request: Request) => Effect.Effect<Result, E, R>,
) =>
  Effect.map(
    Effect.context<R>(),
    (context) => (request: Request) => Effect.provide(call(request), context),
  );

type Transport<Input, Request, Result, CallError> =
  | {
      readonly context?: (request: Request, input: Input) => ExecutionContext;
      readonly call: (
        request: Request,
        input: Input,
      ) => Effect.Effect<Result, CallError, Client.Service>;
      readonly connect?: never;
    }
  | {
      readonly connect: Effect.Effect<
        (request: Request) => Effect.Effect<Result, CallError>,
        Effect.Error<typeof getClientProvider> | SamvaCliError,
        Effect.Services<typeof getClientProvider> | HttpClient.HttpClient
      >;
      readonly call?: never;
      readonly context?: never;
    };

/** Specialize a contract call with the released grammar and its deliberate presentation choices. */
export const deriveOverride = <
  const Name extends string,
  const Flags extends Config,
  Request = InputOf<Flags>,
  Result = unknown,
  CallError = unknown,
  MapError = never,
  PrepareError = never,
  PrepareServices = never,
  OutputError = never,
  OutputServices = never,
  PreviewError = never,
  PreviewServices = never,
>(
  name: Name,
  flags: Flags,
  override: Override<
    InputOf<Flags>,
    Request,
    Result,
    CallError,
    MapError,
    PrepareError,
    PrepareServices,
    OutputError,
    OutputServices,
    PreviewError,
    PreviewServices
  > &
    Transport<InputOf<Flags>, Request, Result, CallError>,
) =>
  Command.make(name, flags).pipe(
    Command.annotate(OperationCommand, true),
    Command.withHandler(
      Effect.fnUntraced(function* (input) {
        const jsonl = isJsonLinesRequested();
        const json =
          Predicate.isObject(input) && typeof input.json === "boolean"
            ? input.json
            : isJsonRequested() || jsonl;
        const options = input as {
          readonly dryRun?: boolean;
          readonly yes?: boolean;
          readonly all?: boolean;
        };
        const pagination = override.paginate;
        if (pagination && options.all && !jsonl) {
          return yield* new CliUsageError({
            code: "all_requires_jsonl",
            message: "--all is an unbounded traversal and requires --jsonl.",
          });
        }

        const request =
          override.prepare !== undefined
            ? yield* override.prepare(input)
            : override.mapInput === undefined
              ? (input as Request)
              : override.mapInput(input);
        if (override.preview && options.dryRun) {
          if (override.document)
            return yield* printJsonDocument(override.preview.data(request, input));
          if (json) return yield* printJson(override.preview.data(request, input));
          return yield* (
            override.preview.render?.(request, input) ??
            renderHuman(override.preview.data(request, input))
          );
        }
        if (override.confirmation) {
          yield* confirmDestructive({
            yes: options.yes ?? false,
            json: json || outputModeFromArgv(process.argv.slice(2)) === "quiet",
            ...override.confirmation(request, input),
          });
        }

        const call = yield* override.connect !== undefined
          ? override.connect
          : Effect.map(
              override.context === undefined
                ? getClientProvider
                : getClientProviderForContext(override.context(request, input)),
              (client) => (page: Request) => client.provide(override.call(page, input)),
            );
        let cursor = pagination?.start(request);
        const seenCursors = new Set<string>();
        for (;;) {
          const pageRequest =
            pagination === undefined ? request : pagination.withCursor(request, cursor);
          const result = yield* call(pageRequest).pipe(
            (effect) =>
              json ? Effect.provideService(effect, References.MinimumLogLevel, "None") : effect,
            Effect.mapError((error) =>
              override.failure === undefined
                ? error
                : typeof override.failure === "string"
                  ? toCliApiError(override.failure, error)
                  : override.failure(error, pageRequest, input),
            ),
          );
          const output = () =>
            override.mapOutput === undefined
              ? result
              : override.mapOutput(result, input, pageRequest);
          if (pagination && jsonl) {
            if (!Predicate.isObject(result) || !Array.isArray(result.items)) {
              return yield* new SamvaCliError({
                message: "The API returned an invalid cursor page.",
              });
            }
            for (const item of result.items)
              yield* printJsonLine(
                pagination.mapItem === undefined ? item : pagination.mapItem(item),
              );
            if (pagination.stopOnEmpty && result.items.length === 0) return;
          } else if (override.document) {
            return yield* printJsonDocument(output());
          } else if (json) {
            return yield* printJson(output());
          } else {
            return yield* override.render?.(result, input, pageRequest) ?? renderHuman(output());
          }
          if (!options.all || !Predicate.isObject(result) || typeof result.nextCursor !== "string")
            return;
          if (seenCursors.has(result.nextCursor))
            return yield* new SamvaCliError({
              message: "The API repeated a pagination cursor; traversal stopped.",
            });
          seenCursors.add(result.nextCursor);
          cursor = result.nextCursor;
        }
      }),
    ),
  );
