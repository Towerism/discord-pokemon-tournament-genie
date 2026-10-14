# S2: penalty form ergonomics

Which `/penalty` form should M4 build ([architecture §6.4](../architecture/README.md#64-record-a-penalty),
[ADR-0006](../architecture/adr/0006-structured-penalties.md))? The spike timed both candidates on a phone.

- **Recorded:** 2026-10-14, discord.js 14.27.0, API v10, guild `genie-spike-<name>` (throwaway).
- **Device:** `iphone-17-pro-max` (Discord iOS app), one judge (the owner).
- **Variant A** (§6.4 as designed), `/spike-penalty-a`: `round`, `category`, `severity` and `penalty` as
  command options, then a modal with the competitor's player ID and notes.
- **Variant B** (select-in-modal), `/spike-penalty-b`: `round` as the only option, then a modal with
  three string selects (category, severity, penalty) plus the player ID and notes, each in a `Label`.
- **Timing:** from the **Start** button tap to the modal submit, using Discord's snowflake timestamps
  (`durationMs`); `modalMs` is the part from the command to the submit.

## Results

`pnpm spike s2 summarize`:

| Variant | Device | Runs | Errors | Abandoned | Median | Max |
| ------- | ------ | ---- | ------ | --------- | ------ | --- |
| A | iphone-17-pro-max | 5 | 0 | 8 | 43.3 s | 54.9 s |
| B | iphone-17-pro-max | 5 | 0 | 4 | 35.8 s | 37.9 s |

Every successful run, in the order they were made (all A runs came before all B runs):

| Variant | Total | In the modal | Before the modal |
| ------- | ----- | ------------ | ---------------- |
| A | 27.6 s | 9.5 s | 18.1 s |
| A | 32.0 s | 13.1 s | 18.9 s |
| A | 54.9 s | 36.7 s | 18.1 s |
| A | 45.9 s | 22.7 s | 23.2 s |
| A | 43.3 s | 26.2 s | 17.1 s |
| B | 35.8 s | 23.7 s | 12.1 s |
| B | 30.6 s | 23.2 s | 7.4 s |
| B | 33.8 s | 24.3 s | 9.6 s |
| B | 37.9 s | 31.5 s | 6.4 s |
| B | 36.6 s | 31.1 s | 5.6 s |

- **Abandoned runs aren't failures of either form.** The owner tapped **Start** several times before
  running a command while learning the flow; each new Start replaces the open run, which FR-13 records as
  abandoned. One more A run was still open when the bot stopped. An earlier bot session, labelled with a
  generic device name, was stopped before any run and recorded nothing usable.
- **No errors:** no invalid player IDs, and no `client_unsupported`. Variant B's selects inside a modal
  opened and submitted normally in the iOS app.
- **Where the time goes.** A spends about 18 s choosing four command options with autocomplete before the
  modal opens. B gets to its modal in 6–12 s and spends that time on three selects instead, but the
  selects are quicker to work through than the option picker, and B's times are tighter (30.6–37.9 s
  against 27.6–54.9 s).

## Limitations

- **One device, one judge, five runs each.** Android, the desktop client and other judges were not
  tested. The spec's minimum (5 successful runs per variant on a phone) is met; more devices are not
  tested.
- **Order.** All A runs were made before all B runs, so B may benefit from practice. A's two fastest runs
  were its first two, though, so practice didn't obviously speed A up.

## Recommendation

**Build Variant B (select-in-modal) for `/penalty` in M4.** It was faster at the median (35.8 s against
43.3 s, about 17%) and much more consistent (worst run 37.9 s against 54.9 s), and it worked on iOS.

How it fits the 5-components-per-modal limit (architecture §12):

- B's modal uses **all five** components: category, severity and penalty selects, player ID, notes. No
  sixth field can be added to the modal later.
- Anything else stays a command option outside the modal: `round`, and the `event` option in a day-wide
  channel (§6.4). The bot builds the modal when the command runs, so the penalty select can still be
  limited to the penalties valid for the event's game and the day's season (no prize penalties outside
  TCG).
- A string select holds at most 25 options; the clipboard sheet's lists are well under that.

This contradicts §6.4, §12 and ADR-0006, which fix Variant A (options plus a 2-field modal). The
amendment is [ADR-0014](../architecture/adr/0014-penalty-form-selects-in-modal.md), accepted by the
owner on 2026-10-14: Variant B. Keeping A would have cost about 7.5 s per penalty at the median on this
evidence; nothing else in the architecture depends on the choice.
