import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

const report = {
  campaignId: "camp_1234567890abcdef",
  runId: "crun_1234567890abcdef",
  totalRecipients: 10,
  dispatchedCount: 8,
  failedCount: 1,
  skippedCount: 1,
  deliveredCount: 6,
  hardBounceCount: 1,
  softBounceCount: 1,
  complaintCount: 1,
  engagement: { measurement: "directional", uniqueOpens: 3, uniqueClicks: 2 },
  unsubscribesByTopic: [{ topicId: "unsub_1234567890abcdef", count: 1 }],
  replyCount: 2,
  skippedReasons: [{ reason: "unsubscribed", count: 1 }],
};

let configHome: string;
let apiUrl: string;
let paths: string[];
let closeApi: () => Promise<void>;

beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-cli-report-"));
  paths = [];
  const server = createServer((req, res) => {
    paths.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(report));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("API did not bind a port");
  apiUrl = `http://127.0.0.1:${address.port}`;
  closeApi = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

afterEach(async () => {
  await closeApi();
  await rm(configHome, { recursive: true, force: true });
});

const cli = (...args: string[]) =>
  runCli(["campaigns", "report", report.campaignId, report.runId, ...args], {
    configHome,
    env: { SAMVA_API_KEY: "samva_sk_test_report", SAMVA_API_URL: apiUrl },
  });

describe("campaign report CLI", () => {
  it("fetches one bounded report with the directional marker in JSON", async () => {
    const result = await cli("--json");
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      type: "result",
      command: "campaigns.report",
      data: report,
    });
    expect(paths).toEqual([`GET /v1/campaigns/${report.campaignId}/runs/${report.runId}/report`]);
  });

  it("labels human engagement counts directional and prints topic and skip breakdowns", async () => {
    const result = await cli();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Unique opens (directional)");
    expect(result.stdout).toContain("Unique clicks (directional)");
    expect(result.stdout).toContain("machine observations excluded");
    expect(result.stdout).toContain("unsub_1234567890abcdef");
    expect(result.stdout).toContain("Skipped · unsubscribed");
    expect(result.stdout).toContain("Hard bounces");
    expect(result.stdout).toContain("Replies");
  });
});
