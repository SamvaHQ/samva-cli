import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";

describe("README acquisition links", () => {
  it("tags every Samva page link with its publication source", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const links = [...readme.matchAll(/\]\((https:\/\/samva\.dev[^)]*)\)/g)];
    expect(links.length).toBeGreaterThan(0);
    for (const [, href] of links) {
      const url = new URL(href!);
      expect(url.searchParams.get("utm_source")).toBe("readme");
      expect(url.searchParams.get("utm_medium")).toBe("cli");
      expect(url.hash).not.toContain("utm_");
    }
  });
});
