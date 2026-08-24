# Assistant voice benchmark

Status: prepared, not yet exercised on a physical pilot device.

No voice-quality decision has been made. An enum value such as Premium is not
evidence that a voice sounds natural.

## Gate

The voice bake-off is complete only when:

1. a pilot iPhone has candidate Default, Enhanced and Premium English voices
   installed;
2. each candidate speaks all five product sentences below;
3. the same listener scores every candidate in the same room and audio route;
4. the chosen voice is acceptable for a commercial owner-facing assistant;
5. the result records device model, OS version, locale, voice identifier,
   quality, date and listener.

The Assistant must not capture or speak during a ringing, connecting or active
business call.

## Device preparation

On the pilot iPhone, open:

Settings > Accessibility > Spoken Content > Voices > English

Download the candidate Enhanced and Premium voices before testing. The app
cannot assume those assets exist or silently install a preferred named voice.

Keep the following constant:

- quiet room;
- device volume;
- speaker or connected audio route;
- speaking rate and pitch;
- sentence order;
- device orientation;
- listener distance.

## Test sentences

1. Three customers are due to reorder. Two campaign proposals are waiting for approval.
2. Nine customers match this audience, but I cannot fairly project incremental revenue yet.
3. Opening the recent segment and showing why each person is included.
4. Dominic referred a pricing conversation to you ten minutes ago.
5. I could not verify that figure from the available business data.

These sentences exercise numbers, refusals, navigation language, names and
natural pauses. They contain no customer identity and name no compound.

## Scorecard

Score each category from 1 to 5, where 5 is best.

| Candidate | Identifier | Quality | Naturalness | Clarity | Numbers | Pauses | Fatigue | Overall |
|---|---|---|---:|---:|---:|---:|---:|---:|
| Default | Not tested | Not tested |  |  |  |  |  |  |
| Enhanced | Not tested | Not tested |  |  |  |  |  |  |
| Premium | Not tested | Not tested |  |  |  |  |  |  |

## Measured environment

| Field | Result |
|---|---|
| Device | Not tested |
| OS | Not tested |
| Locale | Not tested |
| Audio route | Not tested |
| Listener | Not tested |
| Date | Not tested |

## Decision

Not tested. No voice is approved.

If Premium is acceptable, select it when installed and use an honest fallback
to the best installed Enhanced or Default voice. If it is not acceptable, stop
before integrating a third-party voice. Any third-party code, weights, voice
data and commercial licence must be reviewed first.
