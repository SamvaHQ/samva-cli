import AuthoringPackage from "@samva/markup/package.json" with { type: "json" };

/** `0.17` for `0.17.3`: while the authoring packages are 0.x, a minor can change what the CLI calls. */
export const minorOf = (version: string): string => version.split(".").slice(0, 2).join(".");

/** The authoring release line this CLI drives; a project's installed toolchain must be on it. */
export const AUTHORING_MINOR = minorOf(AuthoringPackage.version);
