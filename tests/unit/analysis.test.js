// Unit tests for the analysis engine (static/analysis.js).
//
//   node --test tests/unit/
//
// No dependencies and no browser: the engine is pure, so it can be required
// straight into Node. These cover the arithmetic and the decision tree at the
// level of single functions; the end-to-end behaviour of the app is covered
// separately by the Playwright suites.
//
// Where a case encodes a deliberate judgement rather than an obvious truth, the
// comment says which — those are the ones to revisit if the analysis changes.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../../static/analysis.js');

/** One table's result. Only the fields the engine reads. */
function result({ contract = '3NT', declarer = 'S', tricks = 9, score = 400,
                  ns = ['n1', 's1'], ew = ['e1', 'w1'] } = {}) {
  return {
    contract, declarer, tricks, score,
    matchpoints: null, percentage: null, imps: null,
    ns_pair: { number: 1, players: ns.map((name) => ({ name })) },
    ew_pair: { number: 2, players: ew.map((name) => ({ name })) },
    auction: null, play: null, handviewer_url: null,
  };
}

function game(boards) {
  return {
    schema_version: '1.1', source: 'test', fetched_at: '2026-08-11T00:00:00Z',
    tournaments: [{ name: 'T', events: [{ name: 'E', date: '2026-08-11', scoring: 'matchpoints',
      sessions: [{ session_number: 1, table_count: 3, boards }] }] }],
  };
}

function board(n, results, extra = {}) {
  return {
    number: n, section: null, dealer: 'N', vulnerability: 'None',
    deal: null, double_dummy: null, par: [], user_result_index: 0,
    results, ...extra,
  };
}

describe('identity', () => {
  test('normalizeName folds case and surrounding space', () => {
    assert.equal(A.normalizeName('  Kemistry '), 'kemistry');
    assert.equal(A.normalizeName('kemistry'), 'kemistry');
  });

  test('displayName leaves usernames alone but title-cases real names', () => {
    // A BBO username is an identifier, not a name — capitalising it invents a
    // capital that is not theirs. Every ACBL name contains a space.
    assert.equal(A.displayName('kemistry'), 'kemistry');
    assert.equal(A.displayName('aam135'), 'aam135');
    assert.equal(A.displayName('CAYE johnson'), 'Caye Johnson');
  });

  test('playerKey prefers the ACBL number over the name', () => {
    assert.equal(A.playerKey({ name: 'Anyone', acbl_id: 'K123' }), 'acbl:K123');
    assert.equal(A.playerKey({ name: ' Caye Johnson ' }), 'name:caye johnson');
    // The same human under two spellings is one key — the property tracking
    // depends on.
    assert.equal(A.playerKey({ name: 'Kemistry' }), A.playerKey({ name: 'kemistry' }));
  });
});

describe('matchpoints', () => {
  const rs = [
    result({ score: 400 }), result({ score: 200 }), result({ score: -50 }), result({ score: 400 }),
  ];

  test('beats scores twice as hard as it ties them', () => {
    // 400 beats 200 and -50 (2), ties the other 400 (0.5) → 2.5/3.
    assert.equal(A.calculateMatchpointPct(rs[0], rs, 'NS'), (2.5 / 3) * 100);
  });

  test('EW is the mirror of NS on the same row', () => {
    const ns = A.calculateMatchpointPct(rs[1], rs, 'NS');
    const ew = A.calculateMatchpointPct(rs[1], rs, 'EW');
    // Not exactly 100: the two halves are computed independently in floating
    // point, so they sum to 99.999999… on some boards. Harmless at display
    // precision, but it means the pair is not bit-for-bit complementary.
    assert.ok(Math.abs((ns + ew) - 100) < 1e-9, `${ns} + ${ew}`);
  });

  test('a lone table is average, not a top', () => {
    assert.equal(A.calculateMatchpointPct(rs[0], [rs[0]], 'NS'), 50);
  });

  test('a missing score counts as zero rather than throwing', () => {
    const blank = result({ score: null });
    assert.equal(typeof A.calculateMatchpointPct(blank, [blank, rs[0]], 'NS'), 'number');
  });
});

describe('field contract', () => {
  test('the most-played contract wins', () => {
    const rs = [result({ contract: '3NT' }), result({ contract: '3NT' }), result({ contract: '4S' })];
    assert.equal(A.fieldContract(rs), '3NT');
    assert.deepEqual([...A.fieldContractCounts(rs)], [['3NT', 2], ['4S', 1]]);
  });

  test('PASS is not a field contract', () => {
    const rs = [result({ contract: 'PASS' }), result({ contract: 'PASS' }), result({ contract: '4S' })];
    assert.equal(A.fieldContract(rs), '4S');
  });

  test('matching is on level and strain, ignoring doubles', () => {
    assert.equal(A.matchedFieldContract('4SX', '4S'), true);
    assert.equal(A.matchedFieldContract('5S', '4S'), false);
    assert.equal(A.sameStrainAsField('2S', '4S'), true);
    assert.equal(A.sameStrainAsField('4H', '4S'), false);
  });
});

describe('declarer vs field', () => {
  test('compares only against the same strain', () => {
    const rs = [
      result({ contract: '3NT', tricks: 10 }),
      result({ contract: '3NT', tricks: 8 }),
      result({ contract: '4S', tricks: 12 }),   // must not drag the NT average
    ];
    const avg = A.fieldTrickAverages(rs);
    assert.equal(avg.get('NT').avg, 9);
    assert.equal(A.declarerVsField(rs[0], avg), 1);
  });

  test('one table in a strain has no field to compare against', () => {
    // Deliberate: a single data point is not an average, so this returns null
    // rather than 0 — the cause tree then declines to call it a play error.
    const rs = [result({ contract: '4S', tricks: 10 }), result({ contract: '3NT', tricks: 9 })];
    assert.equal(A.declarerVsField(rs[0], A.fieldTrickAverages(rs)), null);
  });

  test('a passed-out or trickless row is skipped, not counted as zero', () => {
    const rs = [result({ contract: '3NT', tricks: null }), result({ contract: '3NT', tricks: 9 })];
    assert.equal(A.fieldTrickAverages(rs).get('NT').count, 1);
  });
});

describe('bidding arithmetic', () => {
  test('rank orders strains within a level and levels above each other', () => {
    assert.ok(A.bidRank('1S') > A.bidRank('1H'));
    assert.ok(A.bidRank('1NT') > A.bidRank('1S'));
    assert.ok(A.bidRank('2C') > A.bidRank('1NT'));
  });

  test('isGameLevel knows the strain-dependent thresholds', () => {
    assert.equal(A.isGameLevel('3NT'), true);
    assert.equal(A.isGameLevel('4S'), true);
    assert.equal(A.isGameLevel('4H'), true);
    assert.equal(A.isGameLevel('4D'), false);   // minors need five
    assert.equal(A.isGameLevel('5C'), true);
    assert.equal(A.isGameLevel('2NT'), false);
  });

  test('rustRound rounds halves away from zero, as the Rust port did', () => {
    assert.equal(A.rustRound(0.5), 1);
    assert.equal(A.rustRound(-0.5), -1);
    assert.equal(A.rustRound(1.4), 1);
  });
});

describe('auction notes', () => {
  test('names only the misses that cost a bonus', () => {
    assert.equal(A.formatAuctionNote('2S', '4S'), 'underbid (4S)');
    assert.equal(A.formatAuctionNote('4S', '2S'), 'overbid (2S)');
    assert.equal(A.formatAuctionNote('6S', '4S'), 'overbid (4S)');
    // Below game on both sides is a partscore difference, not an error.
    assert.equal(A.formatAuctionNote('2S', '3S'), '');
    assert.equal(A.formatAuctionNote('4S', '4H'), 'S vs H');
    assert.equal(A.formatAuctionNote('', '4S'), 'missed 4S');
  });
});

describe('cause analysis', () => {
  const base = {
    role: 'Declarer', matchpointPct: 50, contract: '3NT', ddTricks: null, tricksMade: 9,
    contractIsPar: false, competitive: null, fieldIsCrossDirection: false,
    matchedFieldContract: true, sameStrainAsField: true, fieldContract: '3NT',
    declarerVsField: null, wentDown: false,
  };
  const cause = (over) => A.determineCauseAndNotes({ ...base, ...over });

  test('making par exactly is Good, whatever the score', () => {
    assert.deepEqual(cause({ contractIsPar: true, ddTricks: 9, tricksMade: 9, matchpointPct: 20 }),
      { cause: 'Good', notes: 'par (9)' });
  });

  test('beating double-dummy in the field contract is Lucky, not skill', () => {
    // Taking more than double-dummy allows means a defender erred.
    assert.deepEqual(cause({ ddTricks: 8, tricksMade: 9 }),
      { cause: 'Lucky', notes: 'defense slip (DD 8)' });
  });

  test('falling short of double-dummy is a play error', () => {
    assert.deepEqual(cause({ ddTricks: 10, tricksMade: 9 }),
      { cause: 'Play', notes: 'below DD (10)' });
  });

  test('fewer tricks than the field is a play error even on a good board', () => {
    const r = cause({ matchedFieldContract: false, declarerVsField: -1.4, matchpointPct: 80 });
    assert.equal(r.cause, 'Play');
    assert.match(r.notes, /1 trick fewer/);
  });

  test('extra tricks are Good when they scored and Play when they did not', () => {
    // Same trick count, different verdict by result: +1 that still scored badly
    // means the contract was the problem, so it stays flagged.
    assert.equal(cause({ declarerVsField: 1, matchedFieldContract: false, matchpointPct: 80 }).cause, 'Good');
    assert.equal(cause({ declarerVsField: 1, matchedFieldContract: false, matchpointPct: 20 }).cause, 'Play');
  });

  test('the field contract at the field trick count is Unlucky when it scores badly', () => {
    assert.deepEqual(cause({ declarerVsField: 0, matchpointPct: 30 }),
      { cause: 'Unlucky', notes: 'field avg' });
  });

  test('competing beyond the opponents is Lucky only when it worked', () => {
    const competitive = { playerStrain: 'S', oppStrain: 'H', oppMaxLevel: 4 };
    assert.equal(cause({ competitive, contract: '3S', matchpointPct: 80 }).cause, 'Lucky');
    assert.notEqual(cause({ competitive, contract: '3S', matchpointPct: 30 }).cause, 'Lucky');
  });

  test('a contested board reads as auction judgement, good or bad', () => {
    assert.equal(cause({ fieldIsCrossDirection: true, matchpointPct: 80 }).cause, 'Good');
    assert.equal(cause({ fieldIsCrossDirection: true, matchpointPct: 30 }).cause, 'Auction');
    assert.equal(cause({ fieldIsCrossDirection: true, matchpointPct: 50 }).cause, 'Auction');
  });

  test('going down in a contract double-dummy said was cold is Play, not Auction', () => {
    // Ordering matters here: the DD check runs before "competed too high", so a
    // makeable contract is blamed on the play rather than the bidding.
    const r = cause({ fieldIsCrossDirection: true, matchpointPct: 20, wentDown: true,
                      contract: '4S', ddTricks: 10 });
    assert.equal(r.cause, 'Play');
    assert.match(r.notes, /below DD/);
  });

  test('dummy is judged with declarer, but the note says whose play it was', () => {
    const r = A.determineCauseAndNotes({ ...base, role: 'Dummy', fieldIsCrossDirection: true,
      matchpointPct: 20, wentDown: true, contract: '4S', ddTricks: 10 });
    assert.equal(r.cause, 'Play');
    assert.match(r.notes, /pard below DD/);
  });

  test('the good/bad thresholds are 55 and 45, inclusive', () => {
    assert.equal(cause({ declarerVsField: 0, matchpointPct: 55 }).cause, 'Good');
    assert.equal(cause({ declarerVsField: 0, matchpointPct: 45 }).cause, 'Unlucky');
  });

  test('a board with nothing to say about it defaults to Good', () => {
    // Between the thresholds every branch declines to fire, and the tree ends
    // with an unconditional Good. So a flat 50% board where nothing went wrong
    // is reported as Good rather than as a neutral or absent verdict — a
    // judgement worth knowing when reading the cause counts.
    assert.deepEqual(cause({ declarerVsField: 0, matchpointPct: 50 }),
      { cause: 'Good', notes: '' });
  });
});

describe('whole-session analysis', () => {
  const g = game([
    board(1, [
      result({ contract: '3NT', tricks: 9, score: 400, ns: ['kemistry', 'pard'] }),
      result({ contract: '3NT', tricks: 8, score: -50 }),
      result({ contract: '4S', declarer: 'N', tricks: 10, score: 420 }),
    ]),
    board(2, [
      result({ contract: '4H', declarer: 'S', tricks: 10, score: 420, ns: ['kemistry', 'pard'] }),
      result({ contract: '4H', declarer: 'S', tricks: 9, score: -50 }),
      result({ contract: '3NT', tricks: 9, score: 400 }),
    ]),
  ]);

  test('derivePlayers lists everyone once, sorted', () => {
    const players = A.derivePlayers(g, 0);
    assert.ok(players.includes('kemistry'));
    assert.equal(new Set(players).size, players.length);
    assert.deepEqual(players, [...players].sort((a, b) => a.localeCompare(b)));
  });

  test('deriveBoards lists the board numbers', () => {
    assert.deepEqual(A.deriveBoards(g, 0), [1, 2]);
  });

  test('jsAnalyzePlayer reports every board the player sat for', () => {
    const out = A.jsAnalyzePlayer(g, 0, 'kemistry');
    assert.equal(out.boards_played, 2);
    assert.equal(out.board_results.length, 2);
    for (const r of out.board_results) {
      assert.ok(r.cause, 'every board gets a cause');
      assert.ok(r.matchpoint_pct >= 0 && r.matchpoint_pct <= 100);
    }
  });

  test('a player who did not play returns nothing', () => {
    assert.equal(A.jsAnalyzePlayer(g, 0, 'stranger'), null);
  });

  test('jsAnalyzeBoard ranks the tables by NS matchpoints', () => {
    const out = A.jsAnalyzeBoard(g, 0, 1);
    const pcts = out.results.map((r) => r.matchpoint_pct);
    assert.deepEqual(pcts, [...pcts].sort((a, b) => b - a));
  });

  test('analysis is a pure function of its input', () => {
    // The property the persistence design leans on: recomputing is free and
    // always agrees, so analysis is never stored or synced.
    const before = JSON.stringify(g);
    const a = A.jsAnalyzePlayer(g, 0, 'kemistry');
    const b = A.jsAnalyzePlayer(g, 0, 'kemistry');
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(g), before, 'input must not be mutated');
  });
});
