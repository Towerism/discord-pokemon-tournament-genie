# ADR-0011: Share platform infrastructure through `@towerism/selfhost-kit`

- Status: Proposed (2026-10-13)
- Date: 2026-10-13

## Context

Genie's architecture, as first accepted, planned to copy attendance's infrastructure. Its ADR-0001, tech
stack and ADR-0009 said:

> Attendance's launcher, secret bootstrap, entrypoint, CI and release flow carry over almost as-is.
>
> Same pattern as attendance's token vault.
>
> Option 1, reusing attendance's pieces.

An adversarial review of Genie's architecture (Warning #5, recorded in
[selfhost-kit ADR-0001](https://github.com/Towerism/selfhost-kit/blob/main/docs/architecture/adr/0001-share-as-a-package.md)
and its architecture §1) found that copying would leave two versions of security-sensitive code: the
vault, the secret bootstrap and log redaction. A fix in one would never reach the other.

The owner accepted
[`@towerism/selfhost-kit`'s architecture](https://github.com/Towerism/selfhost-kit/blob/main/docs/architecture/README.md)
on 2026-10-13. It is one npm package with a framework-free core, thin `/nitro` adapters, `/testing`
contract suites, Docker assets and reusable workflows. Its ADR-0007 says Genie starts on it from the first
commit.

## Options considered

1. **Copy the pieces from attendance** (the original plan). Fastest to start, but leaves two versions of
   the security code.
2. **A template repository** that Genie starts from. Same drift once the copies exist.
3. **Import the shared kit.** One copy, fixed once, reaching both apps through Renovate.

The full comparison is in
[selfhost-kit ADR-0001](https://github.com/Towerism/selfhost-kit/blob/main/docs/architecture/adr/0001-share-as-a-package.md).

## Decision

Option 3.

**Genie takes from the kit** every piece in
[selfhost-kit ADR-0002](https://github.com/Towerism/selfhost-kit/blob/main/docs/architecture/adr/0002-scope.md)'s
"in the kit" rows:

- the AES-256-GCM vault and string helper (`createVault`, `stringVault`);
- the secret specs and their resolution, the runtime env and the launcher (`sessionPassword()`,
  `aes256Key`, `prepareRuntimeEnv`, `runLauncher`);
- the setup code (`generateSetupCode`, `setupCodeMatches`);
- the logger, redaction and request ids;
- the request-log plugin;
- the CSP and security-headers builder and plugin;
- the fixed-window limiter, client address, trusted proxies and `enforceRateLimit`;
- the JSON-only and body-size middleware, and the JSON error handler;
- the entrypoint, `litestream.yml` and the Litestream pin, copied with `selfhost-kit docker-assets`;
- the reusable image and release workflows (`app-image.yml`, `app-release.yml`) and the shareable
  release config.

**These stay in Genie:**

- the secret specs list and the AAD strings;
- the extra redaction keys;
- extra CSP sources and per-route policies (the transcript view's sandbox CSP);
- which routes are rate-limited, their limits and their tuning env names;
- exempt paths and the body size limit;
- when the setup code is printed and when it stops working (when the wizard finishes);
- the Dockerfile: its stages, paths, `HEALTHCHECK`, env defaults, `exports/` and port 3001;
- the `check` and `e2e` CI jobs, the smoke scripts and the image name;
- the Unraid template, checked by the kit's `checkUnraidTemplate`;
- `/healthz` and `/readyz`;
- the `jobs` module, written so it can move into the kit later (selfhost-kit ADR-0002);
- the DB, auth and all domain code.

**Pin.** Genie pins an **exact** 0.x version until the kit reaches 1.0. Renovate proposes every bump
(architecture §9).

**No copying.** If the kit lacks a piece Genie needs, Genie waits for it or contributes it to the kit.
It never copies a piece from attendance "for now".

## Consequences

- (+) One copy of the security-sensitive code. A kit fix reaches Genie as a Renovate PR.
- (+) Genie's own security configuration (secret specs, redaction extras, CSP sources, limits) is explicit
  in its `server/` wiring, and its contract tests run against it (architecture §11).
- (−) M1's skeleton depends on kit K1 and K2 publishing 0.x, and M1's image and release work on kit K3
  (architecture §14). The M0 spikes and the pure domain code go first if the kit is late.
- (−) A kit bug reaches both apps at once. Mitigated by the contract suites, Genie's full CI on every kit
  bump and the manual Unraid *Update* click (architecture §12).
- (−) A few small pieces (`/healthz`, the Dockerfile) are still written in each app. They are trivial or
  app-specific.
