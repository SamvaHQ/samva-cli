import { Console, Effect, Predicate } from "effect";

import { objectRows, printFields, printJson, printJsonLine } from "../output";
import { Json, JsonLines, Quiet } from "../runtime";

const scalar = (value: unknown) =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

const row = (value: unknown) =>
  Predicate.isObject(value) && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([, entry]) => scalar(entry)))
    : { value };

export const renderHuman = (value: unknown, verdict?: string) =>
  Effect.gen(function* () {
    if (yield* Quiet) return;
    if (verdict !== undefined) {
      yield* Console.log(verdict);
      if (value === undefined || value === null) return;
    }
    const items = Array.isArray(value)
      ? value
      : Predicate.isObject(value) && Array.isArray(value.items)
        ? value.items
        : undefined;
    if (items !== undefined) {
      if (items.length === 0) return yield* Console.log("No results.");
      yield* Console.table(items.map(row));
      if (Predicate.isObject(value) && typeof value.nextCursor === "string") {
        yield* printFields([["Next cursor", value.nextCursor]]);
      }
      return;
    }
    if (Predicate.isObject(value)) return yield* printFields(objectRows(value));
    return yield* Console.log(value ?? "Done.");
  });

export const renderDerived = (value: unknown, verdict?: string) =>
  Effect.gen(function* () {
    if (yield* Quiet) return;
    if (yield* Json) return yield* printJson(value ?? null);
    if (yield* JsonLines) return yield* printJsonLine(value ?? null);
    return yield* renderHuman(value, verdict);
  });
