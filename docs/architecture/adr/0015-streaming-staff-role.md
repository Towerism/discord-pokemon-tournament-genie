# ADR-0015: A Streaming event role that isn't a judge, and a streaming blueprint audience

- Status: Accepted (2026-10-15, owner decision on #31)
- Amends [ADR-0010](0010-one-audience-model.md) and architecture §5.2, §6.2 and §8
- Date: 2026-10-15

## Context

Some event staff run the stream: cameras, capture, overlays and the general stream setup. They aren't judges.
Genie's event roles are play-tools' five codes (`headjudge`, `judge`, `scorekeeper`, `administration`,
`translator`; attendance ADR-0007, spike S6). Genie treats every one but `headjudge` alike. A stream person put
on an event as `scorekeeper` could therefore:

- record penalties with `/penalty`;
- be named as a penalty's judge on the website;
- see the event's floor and penalties channels and `#day-staff`.

Penalties are about named, often minor, players. Privacy is the top quality attribute (§3).

The owner decided on 2026-10-15:

- streaming is per event, like the other roles;
- streaming staff aren't judges;
- they see neither the event's penalties channel nor its floor channel, nor the default day channel;
- a new `streaming` blueprint audience shows them a channel, and head judges and organizers see everything it
  shows;
- the default blueprint gets no stream channel.

## Options considered

1. **A Genie-only `streaming` event role and a `streaming` audience.** A Genie-only role departs from "the
   same role codes as play-tools".
2. **Reuse `administration` for stream staff** and narrow what it can do. That changes the meaning of a role
   attendance imports, so real administration staff would lose access.
3. **A day-level streaming flag on `day_staff`.** Rejected by the owner: streams are per event.

## Decision

Option 1.

- **The role.** `event_staff.role` gains `streaming`. Attendance never sends it: its wire type keeps the five
  codes, and a `streaming` from attendance is refused like any unknown role. Only an organizer sets it, by hand.
  A refresh treats it as any hand-set role: it is never proposed for removal, and a different upstream role
  shows as a by-hand `role_changed` that starts unchecked.
- **Per event, each event on its own.** A person has one role per event, and each event's channels follow that
  role. Someone who streams one event and judges another is a judge on the second and streaming staff on the
  first.
- **Streaming-only.** A day staffer whose every event role is `streaming` (with at least one) is
  *streaming-only*.
- **Audiences** (`shared/blueprints`, the one source for preview, provisioning and `canSee()`):

  | Scope | Audience | Members |
  | ----- | -------- | ------- |
  | day | `all_staff` | Day staff who aren't streaming-only, plus day head judges |
  | day | `streaming` | Day staff with a `streaming` role on any event, plus day head judges |
  | per event | `event_staff` | The event's staff whose role on it isn't `streaming` |
  | per event | `streaming` | The event's `streaming` staff, plus its head judges |

  `head_judges` is unchanged. Organizers see every channel through the organizer-role overwrite.
- **No penalties channel for streaming.** A blueprint channel whose purpose is `penalties` can't use the
  `streaming` audience (`audience_not_allowed`). So no penalties channel ever shows an event's streaming staff.
- **Not a judge.** `canSee`'s access plan gains `judgeOf`, the events where the staffer's role isn't
  `streaming`. Recording and listing penalties require it, so streaming staff:
  - can't run `/penalty` or `/penalties` for that event, and are told why;
  - aren't offered by the event autocomplete;
  - lose a card's 15-minute Edit window;
  - can't be named as the judge on the website (`422 judge_not_judging`).

  Penalties already recorded by someone who later switches to streaming stay as recorded.
- **The head-judge Discord role still wins.** A member with the mapped head-judge role who is on the day's staff
  is a day head judge (ADR-0004), whatever their event roles. The organizer grants that role as trust.

## Consequences

- (+) Stream staff can be planned without seeing penalties or being able to record them, and their channels are
  the organizer's choice per blueprint.
- (+) Discord and the website stay in step: the rule lives in `desiredChannels` and `accessPlan` (ADR-0010).
- (−) A Genie-only role breaks "the same role codes as play-tools/attendance". Attendance can't send it, and a
  refresh may propose turning it back into the upstream role (unchecked, by hand).
- (−) With the default blueprint, a streaming-only staffer sees no channel at all until the organizer adds a
  `streaming` channel. The preview shows each channel's audience, so the organizer can see this before opening
  the day.
