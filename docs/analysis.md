# The analysis engine

What [`static/analysis.js`](../static/analysis.js) computes, and the judgements
baked into it. Written from the code, not from intent — where the code does
something arguable, this says so rather than smoothing it over.

Unit tests in [`tests/unit/analysis.test.js`](../tests/unit/analysis.test.js)
pin the behaviour described here:

```bash
node --test tests/unit/*.test.js      # no dependencies, no browser
```

## Shape

The engine is a **pure function of one normalized game document**. No DOM, no
storage, no network, no app state. Two consequences worth keeping:

- It is cheap. On a real 36-board club game (264 results, 40 players):
  `JSON.parse` 0.4 ms, `enrichNormalized` 0.7 ms, and **0.1 ms per player**.
- Because it is cheap and deterministic, **analysis is never stored**. Only the
  game document is persisted; verdicts are recomputed on demand. There is no
  analysis column in `club_games` and no cache to invalidate.

Entry points are `jsAnalyzePlayer(game, sessionIdx, name)` and
`jsAnalyzeBoard(game, sessionIdx, boardNumber)`. Everything else supports them.

The engine was ported function-for-function from a Rust crate that no longer
exists. That explains `rustRound` (round halves away from zero, matching
`f64::round`) and the `*Equivalent` helpers, which exist only to tolerate the old
server's non-deterministic tie-breaking. Nothing calls those in anger now.

## Step 1 — matchpoints

`calculateMatchpointPct(result, allResults, playerDir)`

For one result, count what fraction of the **other** results on that board it
beats. A win scores 1, a tie 0.5, expressed as a percentage. Direction flips the
sign of every comparison, so EW gets the mirror of NS.

- A board with one table returns **50**, not 100. One table is not a field.
- A missing score is treated as 0 rather than skipped.
- NS% + EW% sums to 100 only to within floating-point error — the halves are
  computed independently, so some boards give 99.999999…

This is ACBL-style matchpointing recomputed locally. It deliberately ignores any
`matchpoints` or `percentage` the source supplied, so every source is scored the
same way.

## Step 2 — the field

Everything below compares one table against the others on the same board. All of
it is meaningless when the capture holds only the user's table — see
[Limits](#what-the-engine-cannot-know).

**Field contract** — `fieldContractCounts` / `fieldContract`

The most-played canonical contract on the board, counted by full string
(level + strain + double). `PASS` is excluded. Ties are broken arbitrarily.

Two looser comparisons are used by the cause tree, both ignoring doubles:

| Helper | True when |
|---|---|
| `matchedFieldContract` | same level **and** strain as the field |
| `sameStrainAsField` | same strain, any level |

**Field trick average** — `fieldTrickAverages` / `declarerVsField`

Average tricks taken, **grouped by strain**, so a 4♠ result is never compared
against 3NT. `declarerVsField` returns this declarer's tricks minus that
average, or `null` when fewer than two tables played the strain. That null
matters: it is what stops a lone data point being reported as a play error.

**Who declares** — `declaringDirection` / `declaringFlags`

Which side normally declares this board, and whether this table's declarer sat
the other way (`fieldIsCrossDirection`) — the signal that the auction was
contested rather than routine.

**Competitive info** — `computeCompetitiveInfo`

When both sides have a primary strain, records each side's strain and the
highest level they reached, so the tree can ask "did the opponents let us play
here?"

`computeBoardContext` assembles all of the above into the record the cause tree
reads.

## Step 3 — the verdict

`determineCauseAndNotes(ctx)` — one of **Good, Lucky, Play, Defense, Auction,
Unlucky**, plus a short note.

Two thresholds govern everything, both inclusive:

```
matchpointPct >= 55   →  isGood
matchpointPct <= 45   →  isBad
```

Order of the tree, and it is load-bearing — earlier branches win:

1. **Par made exactly** → `Good`, note `par (n)`. Whatever the score.
2. **Opponents failed to compete** — we played our strain below what they had
   already bid, and it scored well → `Lucky`.
3. **Contested board** (`fieldIsCrossDirection`) → good result is `Good`
   ("competed successfully"), bad is `Auction` ("competed too high") — *except*
   that a contract double-dummy says was makeable is blamed on the play instead
   (`Play`, "below DD"). This ordering is deliberate: bidding a cold contract and
   going down is not a bidding error.
4. **Same strain as the field:**
   - in the field contract with DD known → more tricks than DD is `Lucky`
     ("defense slip"), fewer is `Play`, exactly DD is `Good` ("field par")
   - otherwise compare tricks to the field average: fewer → `Play`; more →
     `Good` if it scored, `Play` if it did not; equal → `Good`/`Unlucky` by
     result
5. **Different strain from the field** → an auction judgement, `Good` when it
   worked and `Auction` when it did not.
6. **Fallthrough** → `Good` if the score was good, `Unlucky` if bad, and
   **`Good`** otherwise.

That last default is worth knowing: **a flat board with nothing distinguishing
about it is reported as `Good`**, not as neutral or absent. Cause counts should
be read with that in mind — `Good` means "nothing went wrong" as often as it
means "well played".

`Defense` exists as a category and is produced for defenders by the same tree;
the declarer/dummy branches above never emit it.

### Auction notes

`formatAuctionNote(actual, field)` only names a difference that **cost a bonus**:

| Actual vs field | Note |
|---|---|
| different strain | `S vs H` |
| lower, and missed a game or slam | `underbid (4S)` |
| higher, and reached a game or slam the field did not | `overbid (2S)` |
| lower or higher within the same bonus band | *(nothing)* |
| no contract, field had one | `missed 4S` |

So a partscore difference is silent — 2♠ against a field 3♠ is not an error.

## What the engine cannot know

Every field comparison assumes the capture holds the whole field. The envelope
declares whether it does, in `coverage.results`:

- `all-tables` — matchpoints and field comparisons are meaningful
- `user-table` — they are **not**. A single-table capture has no field: every
  board is one result, matchpoints are 50, and `declarerVsField` is null. The
  ingest switchyard routes these to the solver instead for this reason.

Also absent by source: double-dummy is present for BBO captures (solved in the
browser) but not for ACBL adapters, so the DD branches simply do not fire there,
and boards fall through to the field-average comparisons.

`session.partial` and `session.warnings` flag incomplete captures. **The engine
ignores both** — it analyses whatever it is given. Surfacing them is the UI's
job, and today only the ingest page does it.

## Adding to it

- Keep it pure. That is what makes it testable and what lets analysis be
  recomputed rather than stored.
- Add the case to `tests/unit/analysis.test.js` first — the tree's branch order
  is easy to disturb, and several tests exist specifically to pin an ordering
  (the DD-before-"competed too high" case, for instance).
- Never compare player names with `===`. Use `normalizeName`. Display form has
  changed once already and broke tracking silently; see
  `playerKey` for the identity the history *should* be keyed on.
- The engine is loaded as a **classic script**, not a module, because
  `index.html` uses inline `onclick` handlers that need these functions global.
  The `module.exports` tail at the bottom is what lets Node require the same
  file; browsers never see it.
