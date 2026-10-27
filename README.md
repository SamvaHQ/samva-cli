# Samva CLI

The source of `samva`, the command-line interface for the Samva email API, as published to npm:

| Package                                                                            | Directory                   | What it is                                                         |
| ---------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------ |
| [`@samva/cli`](https://www.npmjs.com/package/@samva/cli)                           | `packages/cli`              | The CLI, and the selector that runs the matching native executable |
| [`@samva/cli-darwin-arm64`](https://www.npmjs.com/package/@samva/cli-darwin-arm64) | `packages/cli-darwin-arm64` | Native executable for macOS on Apple silicon                       |
| [`@samva/cli-darwin-x64`](https://www.npmjs.com/package/@samva/cli-darwin-x64)     | `packages/cli-darwin-x64`   | Native executable for macOS on Intel                               |
| [`@samva/cli-linux-arm64`](https://www.npmjs.com/package/@samva/cli-linux-arm64)   | `packages/cli-linux-arm64`  | Native executable for Linux on arm64                               |
| [`@samva/cli-linux-x64`](https://www.npmjs.com/package/@samva/cli-linux-x64)       | `packages/cli-linux-x64`    | Native executable for Linux on x64                                 |

## Install

```sh
npm install -g @samva/cli
samva --help
```

Each release also attaches a native executable for every platform above, as
`samva-v<version>-<platform>.tar.gz`, with a `SHA256SUMS` file. To install one without npm:

```sh
version=v0.26.0    # a release tag
platform=linux-x64 # darwin-arm64, darwin-x64, linux-arm64, or linux-x64
curl -fsSLO "https://github.com/SamvaHQ/samva-cli/releases/download/$version/samva-$version-$platform.tar.gz"
curl -fsSLO "https://github.com/SamvaHQ/samva-cli/releases/download/$version/SHA256SUMS"
sha256sum --check --ignore-missing SHA256SUMS
tar -xzf "samva-$version-$platform.tar.gz"
install -m 0755 samva /usr/local/bin/samva
```

On macOS, use `shasum -a 256 --check --ignore-missing SHA256SUMS`. A browser download is
quarantined by macOS; `xattr -d com.apple.quarantine samva` clears it.

[The CLI guide](https://samva.dev/docs/developers/cli) covers authentication and every command.

## This repository

This repository is a read-only mirror. Samva's release process writes it after every release,
copying each package's source exactly as it is built and published, and tags every CLI version as
`v<version>`. It does not accept pull requests, and the CLI does not build here: it imports Samva's
internal `@samva/core` and `@samva/contracts` modules and builds inside Samva's own repository. The
executables and the npm package bundle that code.

Report a bug or request a change as an issue in this repository. See [SECURITY.md](./SECURITY.md)
for vulnerabilities.

## License

MIT
