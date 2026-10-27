import PackageJson from "@samva/cli/package.json" with { type: "json" };

export const CLI_VERSION = PackageJson.version;
export const CLI_CLIENT_HEADERS = {
  "x-samva-client": `cli/${CLI_VERSION}`,
} as const;
