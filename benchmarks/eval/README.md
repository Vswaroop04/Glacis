# Normalization Correctness Eval

Run: `npm run eval` · Last run: **2026-05-30**, `claude-haiku-4-5`

The model benchmark in [`../`](../README.md) answers "which model is fastest and cheapest." This answers the question that actually matters: **is the normalization correct?** Each fixture in [`fixtures/`](fixtures) is a raw vendor payload; the matching file in [`expected/`](expected) is the hand-written correct output. The runner sends each through the real model and scores the dimensions separately — because a system can classify perfectly and still get the amount or the timestamp wrong.

## Latest result

```
classification   100%  (8/8)
state            100%  (7/7)
entity           100%  (7/7)
mode              80%  (4/5)
timestamp        100%  (5/5)
amount           100%  (2/2)
currency         100%  (2/2)

overall          97.2% (35/36)
```

The dimensions are scored independently on purpose. Classification (is it a shipment / invoice / unclassified) is separate from state mapping (did "settled in full" become `PAID`), which is separate from entity extraction (did it pick the master BL over the house BL), which is separate from the field-level work (European `EUR 24.350,75` → `2435075` cents, `28/04/2026 09:42 WIB` → `2026-04-28T02:42:00Z`). A single accuracy number would hide which part is weak.

## The one miss is the interesting part

The only failure is `mode` on `dhl-out-for-delivery`. The fixture expects `ROAD`; the model returns `PARCEL`. That's not really a bug — a last-mile courier delivery with a parcel tracking number is genuinely ambiguous between road freight and parcel, and `PARCEL` is defensible. I left it failing rather than editing the fixture to match, because a clean 100% on eight hand-picked cases would be less honest than surfacing a real ambiguity. This is exactly what an eval is for: it tells you *where* the model and your intent disagree, so you can decide whether to fix the prompt, the label, or the schema.

## Why this matters

Normalization is probabilistic — the model can drift when the prompt changes, when the model version changes, or when a new vendor format shows up. Without an eval you find out in production. With one, `npm run eval` is a gate: in a real deployment this runs in CI against a growing golden set, and a prompt or model change that regresses any dimension fails the build before it ships.

## Adding a case

Drop a raw payload in `fixtures/<name>.json` and the expected normalized fields in `expected/<name>.json`. Only the fields you assert are scored, so a fixture can check just classification, or go all the way down to the cent.
