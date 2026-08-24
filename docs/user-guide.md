# Reading your game

Club Game Analysis takes a session you have already played and goes through it
board by board, asking one question about each: **why did this score what it
did?**

A bad score is not the same as a mistake. You can bid and play a hand perfectly
and still get 20% because the field did something odd, and you can get 80% off a
misdefence by the opponents. Sorting those apart is the whole point — the score
tells you *what* happened, this tells you *why*.

## The board table

Each row is one board you played.

| Column | What it means |
|---|---|
| **Board** | Board number |
| **Dir** | Which way you sat |
| **Contract** | What was played at your table, and by whom |
| **Score** | Your side's score |
| **MP%** | What percentage of the field you beat on this board |
| **Field** | The contract most tables played. `=` means you were in it too |
| **Cause** | The verdict — see below |
| **Notes** | The short reason behind the verdict |

**MP%** is recalculated from scratch rather than taken from the club's
scoresheet, so it means the same thing whatever the source. 50% is exactly
average; it means you scored the same as a typical table.

## The six verdicts

**Good** — nothing went wrong. Either you did something better than the field,
or you were in the normal contract and took the normal tricks. Note that a
completely ordinary, average board also lands here: *good* means "no fault
found" as often as it means "well played".

**Lucky** — you scored well, but the reason was not something you did. The
opponents let you play a contract they could have competed against, or the
defence let a trick through that was not available on best play. Worth reading
because these scores will not repeat.

**Play** — you took fewer tricks than the rest of the field did in the same
strain, or fewer than the hand allowed on perfect play. This is the declarer
play column.

**Defense** — the same idea when you were defending: the contract made more
tricks than it should have.

**Auction** — the score traces back to the contract rather than the cards. You
missed a game the field bid, pushed to one they stayed out of, played the wrong
strain, or competed too high.

**Unlucky** — you were in the normal contract, took the normal tricks, and still
got a bad score. Nothing to fix. These are the boards worth *not* worrying
about.

## The notes column

Short and specific:

- **`par (9)`** — you took exactly the number of tricks the hand allows on
  perfect play by everybody.
- **`field par (9)`** — you were in the field's contract and took the same
  tricks it allows.
- **`2 tricks fewer`** — compared to the average at other tables in the same
  strain.
- **`below DD (10)`** — the hand was worth 10 tricks on perfect play; you took
  fewer.
- **`defense slip (DD 8)`** — you took more tricks than perfect defence allows.
- **`underbid (4S)`** / **`overbid (2S)`** — you stopped below, or pushed past,
  the contract the field chose. Only flagged when it cost a game or slam bonus;
  a partscore difference is not treated as an error.
- **`S vs H`** — you and the field picked different strains.
- **`competed too high`** / **`competed successfully`** — a contested auction
  that did, or did not, work out.

## Your history

Tracking a player keeps a running record across sessions. Each row is one event:
boards played, average MP%, an **Error%** (the share of boards attributed to
auction, play, or defence), and a count in each verdict column.

The chart plots error rate against matchpoint percentage over time. What to look
for is not a single session but the shape: whether the error mix is shifting,
and which column is the tall one.

The most useful reading is usually the **balance between columns**, not the
totals. A player with lots of Auction and few Play entries has a bidding problem
to work on, and vice versa — and that is a much more actionable finding than an
overall percentage.

## What this cannot tell you

Being clear about the limits, because they matter for how much weight to put on
a verdict:

- **It only compares you to the field that played.** The comparison is against
  the other tables in your own event. A weak field makes a good contract look
  ordinary, and a strong one makes an ordinary result look bad.
- **It does not read your auction.** With rare exceptions the app sees the final
  contract, not the bidding that reached it. "Auction" means the contract
  differed from the field's in a way that cost something — not that a specific
  bid was wrong.
- **It does not watch the play.** "Play" means the trick count came up short
  against the field or against perfect play. It cannot tell you *which* trick
  went astray.
- **Single-hand replays have no field at all.** If you send one hand from a hand
  viewer, there is nothing to compare it against, so it goes to the double-dummy
  solver instead of here.
- **Ties and near-misses are blunt.** The good/bad line sits at 55% and 45%.
  A board at 54% is not treated as a success even though it very nearly was.

When a verdict looks wrong to you, it usually is worth trusting your own
judgement over the label. The categories are a way of sorting 24 boards into
"look at these six" — they are not a ruling.
