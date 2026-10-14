# M0 spikes

Milestone M0 checks four of the architecture's assumptions about Discord on a real server, before any
application code depends on them ([architecture §13](../architecture/README.md#13-spikes-before-building-timeboxed),
issue #7).

| Spike | Question | Findings | Status |
| ----- | -------- | -------- | ------ |
| S1 | Which OAuth redirect URIs does Discord accept for a LAN install? | [s1-oauth-redirects.md](s1-oauth-redirects.md) | recorded 2026-10-14 (localhost, `<lan-ip>`, `<hostname>.local`; Tailscale and proxy not tested); amendment [ADR-0013](../architecture/adr/0013-https-origin-for-website-login.md), accepted (Caddy only) |
| S2 | How fast can a judge record a penalty on a phone, and with which form? | [s2-penalty-form.md](s2-penalty-form.md) | recorded 2026-10-14 (one iPhone, 5 runs per form); amendment [ADR-0014](../architecture/adr/0014-penalty-form-selects-in-modal.md), Proposed |
| S3 | Do Genie's open and locked overwrites behave as designed on a real guild? | [s3-permissions.md](s3-permissions.md), fixtures in [`test/fixtures/discord-permissions/`](../../test/fixtures/discord-permissions/) | recorded 2026-10-14 against the candidate profile ([ADR-0012](../architecture/adr/0012-genie-overwrite-without-manage-roles.md), Proposed); human cross-check done, all four cases agree |
| S4 | Can transcripts (threads included) be exported completely enough for the purge gate? | [s4-transcript-export.md](s4-transcript-export.md) | recorded 2026-10-14; expired-URL check not run (seed record lost; needs a re-seed) |

The harnesses live in [`spikes/`](../../spikes/), a self-contained pnpm package (Node ≥ 22, discord.js 14.27.0
pinned exactly). Only the findings and S3's fixtures are long-lived; `spikes/` stays for re-recording the
permission cases (ADR-0003).

## Setting up

1. **A throwaway guild** named `genie-spike-<anything>`. Every command refuses any other guild: it checks
   both the configured ID and that the name starts with `genie-spike`. The only humans in it are the
   owner and, for S3's cross-check, one alt account.
2. **Four applications** in the [developer portal](https://discord.com/developers/applications):
   `genie-spike-arranger`, `genie-spike-genie`, `genie-spike-probe-a` and `genie-spike-probe-b`. On each:
   - Public Bot off;
   - Server Members intent on;
   - Message Content intent on (S4 toggles it on `genie` only).
3. **Invite them:**
   - `arranger` with Administrator;
   - `genie` with exactly the candidate permissions: §4.1's nine plus Send Messages in Threads, Create
     Public Threads, Create Private Threads and Add Reactions (`pnpm spike s3 preflight` prints the
     invite URL). S3's first recording showed a non-admin bot can't write the original profile; see
     `s3-permissions.md`. If `genie` was invited with the older nine, re-authorize it through the printed
     URL, or set its role's permissions in Server Settings → Roles;
   - both probes with no permissions.

   Then drag the roles into this order: arranger > genie > the probes.
4. **Configure.** Copy `spikes/.env.example` to `spikes/.env` (git-ignored) and fill it in. Never paste
   these values in chat or an issue.
5. **Install and check:**

   ```sh
   cd spikes
   pnpm install
   pnpm test                      # unit tests, no Discord
   pnpm spike s3 preflight        # guard, identities, genie's role, role order
   ```

Everything a harness creates is named `spike-<runId>-…` and recorded in a ledger under `spikes/out/`
(git-ignored) before the next call. `pnpm spike cleanup --run <runId>` removes one run;
`--orphans` removes `spike-` resources no ledger knows (a crash between a create and its ledger write);
`--all` removes everything `spike-`. Nothing without the prefix is ever deleted.

## Running each spike

### S1: OAuth redirect URIs (≈ 0.5 day, owner)

For each setup in the table in `s1-oauth-redirects.md` that your network offers:

1. Add the redirect URI (`<base>/auth/discord`) to `genie-spike-genie` → OAuth2 → Redirects. If the portal
   refuses it: `pnpm spike s1 note --redirect <uri> --outcome portal_rejected`.
2. Start the server where that URI points, for example on the Unraid box or your laptop:

   ```sh
   pnpm spike s1 serve --redirect http://<lan-ip>:3001/auth/discord --host <lan-ip>
   ```

3. Open `<base>/` in a browser and log in. The result is appended to `spikes/out/s1-attempts.jsonl`.
   If Discord shows its own error page instead of calling back:
   `pnpm spike s1 note --redirect <uri> --outcome authorize_rejected --detail "<what it said>"`.
4. Repeat with `--insecure-cookie`. Over plain HTTP a `Secure` cookie should be dropped, which shows
   up as `state_cookie_missing`.

### S2: penalty form (≈ 0.5 day, a judge with a phone)

```sh
pnpm spike s2 bot --device <phone-model>     # e.g. iphone-13; restart with a new label per device
```

In the `#spike-…-s2` channel, tap **Start A**, run `/spike-penalty-a`, fill it in and submit. Then do
the same with **Start B** and `/spike-penalty-b`. Time is measured from the Start tap to the submit, using
Discord's own timestamps. Do at least 5 successful runs of each on a phone, then `Ctrl-C` (which removes
the commands) and `pnpm spike s2 summarize`. If Variant B's modal won't open on a client:
`pnpm spike s2 note --variant B --device <label> --outcome client_unsupported --note "<client>"`.

### S3: permissions (≈ 1 day)

```sh
pnpm spike s3 record             # two passes on fresh resources; writes the fixtures only if both agree
```

- Exit 0: `test/fixtures/discord-permissions/cases.v1.json` and its schema are written.
- Exit 4: a case was inconclusive or unstable; the IDs are printed and no fixture is written.
- Exit 5: the cases differ from the committed fixture. Re-run with `--accept-changes` only after
  checking why.
- Exit 7: `profile_unwritable`. A non-admin `genie` can't write the architecture's profile in the
  context production uses. That is a finding: it needs an architecture amendment and a spec revision
  before recording again.

Then the **human cross-check**. For each of `R1-nosend-open-outsider`, `R2-default-open-staffer`,
`R4-nosend-locked-staffer` and `R11-default-open-staffer-private-notadded`:

```sh
pnpm spike s3 stage --case <id> --subject-user <alt account's user ID>
```

As the alt account, try the printed actions in order. Record agreement or disagreement in
`s3-permissions.md`, then run the printed `pnpm spike cleanup --run <runId>`.

### S4: transcript export (≈ 0.5 day)

```sh
pnpm spike s4 seed                       # a busy day: 2,000 messages, 6 threads, attachments; kept
pnpm spike s4 measure                    # paging, thread listings (with/without Manage Threads), attachments
pnpm spike s4 measure --content-probe    # with Message Content ON for genie in the portal
#   … turn Message Content OFF for genie in the portal …
pnpm spike s4 measure --content-probe    # again, intent off
#   … turn it back ON …
pnpm spike s4 check-expired              # about a day later, after the recorded URL expiry
pnpm spike cleanup --run <seed runId>
```

## Recordings

| Spike | Date | discord.js | API | Run IDs |
| ----- | ---- | ---------- | --- | ------- |
| S1 | 2026-10-14 | n/a (Chrome 154) | v10 | `spikes/out/s1-attempts.jsonl`: 6 attempts + 1 diagnostic |
| S2 | 2026-10-14 | 14.27.0 | v10 | bot session `20261014080922-0dc5` (`iphone-17-pro-max`), `spikes/out/s2-runs.jsonl` |
| S3 | 2026-10-14 | 14.27.0 | v10 | `20261014075104-8020`, `20261014075549-c6a7` (original profile, stopped with exit 7: `20261014073111-0567`) |
| S4 | 2026-10-14 | 14.27.0 | v10 | seed `20261014073319-9a00` |

Committed findings use placeholders for network names (`<lan-ip>`, `<hostname>.local`,
`<machine>.<tailnet>.ts.net`, `<proxy-host>`); the real values stay in `spikes/out/`.
