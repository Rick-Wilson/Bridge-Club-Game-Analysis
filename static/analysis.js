// ==================== Analysis engine ====================
//
// Everything that turns a normalized game document into numbers and verdicts:
// matchpoints, the field comparisons, board classification, and the cause
// decision tree. See docs/analysis.md for what it computes and why.
//
// Split out of index.html so it can be unit-tested without a browser. It stays
// a CLASSIC script, not a module, on purpose: index.html uses inline `onclick`
// handlers that need these as globals, and `type="module"` would both scope
// them away and defer execution. The tail exports the same functions to Node
// when `module` exists, which is how the unit tests reach them.
//
// Everything here is PURE — no DOM, no storage, no network, no app state. Keep
// it that way: it is what makes the analysis testable, and what let us decide
// to recompute analysis on demand rather than persist it.

// Bridge-domain string constants. Keep these as plain strings (matching the
// schema's wire shape) rather than wrapping them in objects — saves us a
// translation layer everywhere a Direction or Strain shows up in the JSON.
const DIRECTIONS = ['N', 'E', 'S', 'W'];
const STRAINS = ['C', 'D', 'H', 'S', 'NT'];
const SUITS = ['S', 'H', 'D', 'C']; // hand display order (high → low)

/** Normalize a player name for identity comparison. Mirrors the Rust
 *  identity::normalize_name — used as the dedup key in PlayerRegistry. */
function normalizeName(name) {
  return (name || '').trim().toLowerCase();
}

/** Identity key used to deduplicate players across the document. ACBL number
 *  trumps name when present (matches PlayerId::with_acbl_number). */
function playerKey(player) {
  if (player.acbl_id) return `acbl:${player.acbl_id}`;
  return `name:${normalizeName(player.name)}`;
}

/** Display name: lowercase, then capitalize the first letter of each
 *  whitespace-separated word. Mirrors PlayerId::display_name() — used so
 *  "LaFrancesca" round-trips to "Lafrancesca" the same way the server
 *  normalizes player identity.
 *
 *  A name with no whitespace is left exactly as it came. BBO players are
 *  usernames, not names — "aam135" and "filostine" are how those people are
 *  known, and title-casing them into "Aam135" and "Filostine" invents a
 *  capital that is not theirs and does not match BBO's own rendering. Every
 *  ACBL name has a space in it, so this only ever spares identifiers. */
function displayName(name) {
  const raw = (name || '').trim();
  if (!/\s/.test(raw)) return raw;
  return raw.toLowerCase().split(/\s+/).map(w =>
    w ? w[0].toUpperCase() + w.slice(1) : ''
  ).join(' ');
}

// ---- Matchpoint calculation ----
//
// Direct port of analysis::metrics::player::calculate_matchpoint_pct. For a
// given result on a board, count what fraction of the OTHER results on that
// same board it beats (1.0 each) or ties (0.5 each), times 100. Equivalent
// to ACBL-style matchpoint scoring. Player direction (NS or EW) flips the
// sign of the comparison so EW gets the opposite of NS's score.
function calculateMatchpointPct(result, allResults, playerDir /* 'NS' | 'EW' */) {
  if (allResults.length <= 1) return 50.0;
  const sign = playerDir === 'NS' ? 1 : -1;
  const playerScore = sign * (result.score ?? 0);
  let wins = 0, comparisons = 0;
  for (const other of allResults) {
    if (other === result) continue;
    const otherScore = sign * (other.score ?? 0);
    comparisons++;
    if (playerScore > otherScore) wins += 1;
    else if (playerScore === otherScore) wins += 0.5;
  }
  return comparisons > 0 ? (wins / comparisons) * 100.0 : 50.0;
}

/** Iterate every (board, result) pair in a session for convenient walking. */
function* iterSessionResults(session) {
  for (const board of session.boards) {
    for (const result of board.results) {
      yield { board, result };
    }
  }
}

/** Locate the session inside a NormalizedGame by flattened session_idx. */
function pickSession(game, sessionIdx) {
  let i = 0;
  for (const t of game.tournaments) {
    for (const e of t.events) {
      for (const s of e.sessions) {
        if (i === sessionIdx) return s;
        i++;
      }
    }
  }
  return null;
}

/** Distinct player names in a session, sorted. Used to populate the player
 *  grid; replaces the old server-side /api/players endpoint. */
function derivePlayers(game, sessionIdx) {
  const session = pickSession(game, sessionIdx);
  if (!session) return [];
  const seen = new Set();
  const names = [];
  for (const board of session.boards) {
    for (const result of board.results) {
      for (const pair of [result.ns_pair, result.ew_pair]) {
        for (const p of pair?.players ?? []) {
          const name = displayName(p.name);
          const key = playerKey(p);
          if (name && !seen.has(key)) { seen.add(key); names.push(name); }
        }
      }
    }
  }
  names.sort((a, b) => a.localeCompare(b));
  return names;
}

/** Distinct board numbers in a session, sorted. Replaces the old server-side
 *  /api/boards endpoint. */
function deriveBoards(game, sessionIdx) {
  const session = pickSession(game, sessionIdx);
  if (!session) return [];
  return session.boards
    .map(b => b.number)
    .filter((n, i, arr) => arr.indexOf(n) === i)
    .sort((a, b) => a - b);
}

/** Find the partnership direction this player sat in for this result.
 *  Returns 'NS', 'EW', or null if not in either pair. */
function playerDirectionInResult(result, playerName) {
  const norm = normalizeName(playerName);
  if (result.ns_pair?.players?.some(p => normalizeName(p.name) === norm)) return 'NS';
  if (result.ew_pair?.players?.some(p => normalizeName(p.name) === norm)) return 'EW';
  return null;
}

// ---- Contract / result helpers ----
//
// Schema's `contract` is the canonical string "{level}{strain}{double?}" —
// "3NT", "4SX", "6HXX", or "PASS"/null for passed-out / no-result rows.

/** Extract the strain ("C"/"D"/"H"/"S"/"NT") from a canonical contract.
 *  Returns null for PASS / null. Mirrors strain_key() in player.rs. */
function extractStrain(contract) {
  if (!contract || contract === 'PASS') return null;
  // contract[0] is level (1-7); contract[1] starts the strain.
  // 'N' implies "NT"; everything else is a single suit letter.
  return contract[1] === 'N' ? 'NT' : (contract[1] || null);
}

/** Tricks the declarer took on this result, or null if the row has no
 *  result (PASS, sit-out, etc.). Matches BoardResult::tricks_made(): the
 *  schema already carries absolute tricks, so this is just a passthrough
 *  with a contract-presence guard. */
function tricksMade(result) {
  if (result.contract == null || result.contract === 'PASS') return null;
  if (result.tricks == null) return null;
  return result.tricks;
}

// ---- Field-level board context ----
//
// Pre-compute per-board state needed to evaluate any one result on the same
// board. Mirrors the shape of analysis::metrics::player::BoardContext but
// only contains pieces that have been ported so far.

/** Build a `strain → { avg, count }` map of tricks taken across all results
 *  on a board, grouped by the contract's strain. Used as the denominator in
 *  declarer-vs-field comparisons. */
function fieldTrickAverages(allResults) {
  const grouped = new Map(); // strain -> array of tricks
  for (const r of allResults) {
    const strain = extractStrain(r.contract);
    const tricks = tricksMade(r);
    if (strain == null || tricks == null) continue;
    if (!grouped.has(strain)) grouped.set(strain, []);
    grouped.get(strain).push(tricks);
  }
  const out = new Map();
  for (const [strain, arr] of grouped) {
    const sum = arr.reduce((a, b) => a + b, 0);
    out.set(strain, { avg: sum / arr.length, count: arr.length });
  }
  return out;
}

/** Trick difference between this declarer's actual tricks and the strain's
 *  field average. Returns null when fewer than 2 tables played the strain
 *  (no meaningful average), matching the Rust check `if count > 1`. */
function declarerVsField(result, fieldAverages) {
  const strain = extractStrain(result.contract);
  const tricks = tricksMade(result);
  if (strain == null || tricks == null) return null;
  const stats = fieldAverages.get(strain);
  if (!stats || stats.count <= 1) return null;
  return tricks - stats.avg;
}

// ---- Field contract ----
//
// "Field contract" = the contract played by the most tables on a board,
// keyed by canonical full string (level + strain + double). Mirrors the
// `field_contract` block in compute_board_context: count occurrences,
// pick the max. Ties are broken arbitrarily (Rust's max_by_key on a
// HashMap iter is non-deterministic), so the parity check has to
// tolerate alternative choices that share the same count.

/** Tally counts of canonical contract strings for all results on a board. */
function fieldContractCounts(allResults) {
  const counts = new Map();
  for (const r of allResults) {
    if (!r.contract || r.contract === 'PASS') continue;
    counts.set(r.contract, (counts.get(r.contract) || 0) + 1);
  }
  return counts;
}

/** Return the canonical string of the most-common contract on the board, or
 *  null if there are no contracts. On ties, returns one of the tied entries. */
function fieldContract(allResults) {
  const counts = fieldContractCounts(allResults);
  if (counts.size === 0) return null;
  let best = null, bestCount = 0;
  for (const [contract, count] of counts) {
    if (count > bestCount) { best = contract; bestCount = count; }
  }
  return best;
}

/** True when the actual contract matches the field on level + strain
 *  (ignoring doubled status). Mirrors the matched_field check in
 *  analyze_direction(). Returns false when either side is null. */
function matchedFieldContract(actualContract, fieldContractStr) {
  if (!actualContract || actualContract === 'PASS' || !fieldContractStr) return false;
  const aLvl = actualContract[0], aStr = extractStrain(actualContract);
  const fLvl = fieldContractStr[0], fStr = extractStrain(fieldContractStr);
  return aLvl === fLvl && aStr === fStr;
}

/** True when the actual contract shares the field contract's strain
 *  (ignoring level + doubled). Same null-handling as matchedFieldContract. */
function sameStrainAsField(actualContract, fieldContractStr) {
  if (!actualContract || actualContract === 'PASS' || !fieldContractStr) return false;
  return extractStrain(actualContract) === extractStrain(fieldContractStr);
}

/** Comparison helper that treats any field contract sharing the max count
 *  as parity-equivalent. Server's HashMap iteration order is randomized,
 *  so on ties we'd get spurious mismatches without this. */
function fieldContractEquivalent(serverField, jsField, counts) {
  if (serverField === jsField) return true;
  if (!serverField || !jsField) return false;
  return counts.get(serverField) === counts.get(jsField);
}

// ---- Board-level structural context ----
//
// Mirrors the rest of compute_board_context: who declared (per-table and
// "typically"), competitive structure, board-type classification, and par
// matching. These are the inputs the cause-analysis decision tree reads.

/** "NS" or "EW" — which partnership this declarer was on. Mirrors
 *  BoardResult::declaring_direction(). */
function declaringDirection(result) {
  switch (result.declarer) {
    case 'N': case 'S': return 'NS';
    case 'E': case 'W': return 'EW';
    default: return null;
  }
}

/** Which side typically declares this board, the field-declaring direction,
 *  and the per-side typically-declares flags. Mirrors the block in
 *  compute_board_context that filters non-passout results and computes
 *  ns_typically_declares / ew_typically_declares. */
function declaringFlags(allResults) {
  const nonPassout = allResults.filter(r => r.contract && r.contract !== 'PASS');
  const total = nonPassout.length;
  const ns = nonPassout.filter(r => declaringDirection(r) === 'NS').length;
  const ew = total - ns;
  const nsTypically = total > 0 && ns * 2 > total;
  const ewTypically = total > 0 && ew * 2 > total;
  let fieldDir = null;
  if (nsTypically) fieldDir = 'NS';
  else if (ewTypically) fieldDir = 'EW';
  return { nsTypicallyDeclares: nsTypically, ewTypicallyDeclares: ewTypically,
           fieldDeclaringDirection: fieldDir };
}

/** Per-side competitive info: when both sides have a primary strain and the
 *  strains differ, the board is competitive. Mirrors compute_competitive_info.
 *  Returns null when one side lacks a primary strain (≥ 2 tables) or both
 *  primaries are the same strain. */
function computeCompetitiveInfo(allResults, playerDir /* 'NS' | 'EW' */) {
  const nsStrains = new Map(); // strain → { count, maxLevel }
  const ewStrains = new Map();
  for (const r of allResults) {
    if (!r.contract || r.contract === 'PASS') continue;
    const strain = extractStrain(r.contract);
    const level = parseInt(r.contract[0], 10);
    const dir = declaringDirection(r);
    const map = dir === 'NS' ? nsStrains : ewStrains;
    const cur = map.get(strain) || { count: 0, maxLevel: 0 };
    cur.count++;
    cur.maxLevel = Math.max(cur.maxLevel, level);
    map.set(strain, cur);
  }
  const primary = (m) => {
    let best = null, bestCount = 0;
    for (const [strain, { count, maxLevel }] of m) {
      if (count >= 2 && count > bestCount) { best = { strain, maxLevel }; bestCount = count; }
    }
    return best;
  };
  const nsP = primary(nsStrains);
  const ewP = primary(ewStrains);
  if (!nsP || !ewP || nsP.strain === ewP.strain) return null;
  if (playerDir === 'NS') {
    return { playerStrain: nsP.strain, playerMaxLevel: nsP.maxLevel,
             oppStrain: ewP.strain, oppMaxLevel: ewP.maxLevel };
  }
  return { playerStrain: ewP.strain, playerMaxLevel: ewP.maxLevel,
           oppStrain: nsP.strain, oppMaxLevel: nsP.maxLevel };
}

/** True if the contract is at game level or higher for its strain.
 *  Mirrors is_game_level: 5C, 5D, 4H, 4S, 3NT and above. */
function isGameLevel(contract) {
  if (!contract || contract === 'PASS') return false;
  const level = parseInt(contract[0], 10);
  const s = extractStrain(contract);
  if (s === 'C' || s === 'D') return level >= 5;
  if (s === 'H' || s === 'S') return level >= 4;
  if (s === 'NT') return level >= 3;
  return false;
}

/** Classify the board's primary structural feature. Mirrors classify_board:
 *  Competitive > Slam vs Game > Game vs Partscore > Strain Choice > Flat.
 *  Each level requires ≥ 2 tables on each side of a split. Returns the same
 *  display string as the Rust BoardType::Display impl. */
function classifyBoard(allResults, competitiveNs) {
  if (competitiveNs) {
    return `Competitive (${competitiveNs.playerStrain} vs ${competitiveNs.oppStrain})`;
  }
  // Per-strain (slam, game, partscore) tallies.
  const byStrain = new Map();
  for (const r of allResults) {
    if (!r.contract || r.contract === 'PASS') continue;
    const s = extractStrain(r.contract);
    const level = parseInt(r.contract[0], 10);
    const cur = byStrain.get(s) || { slam: 0, game: 0, ps: 0 };
    if (level >= 6) cur.slam++;
    else if (isGameLevel(r.contract)) cur.game++;
    else cur.ps++;
    byStrain.set(s, cur);
  }
  // 2. Slam vs Game
  let svgPick = null;
  for (const [strain, c] of byStrain) {
    if (c.slam >= 2 && (c.game + c.ps) >= 2) {
      if (!svgPick || c.slam > svgPick.slam) svgPick = { strain, slam: c.slam };
    }
  }
  if (svgPick) return `Slam vs Game (${svgPick.strain})`;
  // 3. Game vs Partscore
  let gvpPick = null;
  for (const [strain, c] of byStrain) {
    if (c.game >= 2 && c.ps >= 2) {
      if (!gvpPick || c.game > gvpPick.game) gvpPick = { strain, game: c.game };
    }
  }
  if (gvpPick) return `Game vs Partscore (${gvpPick.strain})`;
  // 4. Strain Choice (same-side, multiple strains each with ≥ 2 tables)
  for (const sideMap of [groupBySideStrain(allResults, 'NS'), groupBySideStrain(allResults, 'EW')]) {
    const qualifying = [...sideMap.entries()].filter(([_, c]) => c >= 2);
    if (qualifying.length >= 2) {
      qualifying.sort((a, b) => b[1] - a[1]);
      return `Strain choice (${qualifying[0][0]} vs ${qualifying[1][0]})`;
    }
  }
  return 'Flat';
}

/** Returns true when two board-type strings are equivalent under the
 *  same-kind classification, even if they made different tie-break choices.
 *  Rust's max_by_key on a HashMap is non-deterministic on ties, so the
 *  parity check has to tolerate a strain-pick disagreement when both are
 *  valid choices from a tied set.
 *
 *  Strain choice: ignore order — "(S vs H)" and "(H vs S)" are equivalent.
 *  Competitive: equivalent if either disagreeing strain tied for the
 *    primary on its side (≥ 2 occurrences and the max count there).
 *  Slam vs Game / Game vs Partscore: equivalent if both strains tied for
 *    the max in their category.
 */
function boardTypeEquivalent(serverBT, jsBT, allResults) {
  if (serverBT === jsBT) return true;
  if (!serverBT || !jsBT) return false;
  // Same kind (prefix before the parenthesized strain pair) is required.
  const kindOf = s => s.replace(/\s*\(.*\)$/, '').trim();
  if (kindOf(serverBT) !== kindOf(jsBT)) return false;
  const argsOf = s => {
    const m = s.match(/\(([^)]*)\)/);
    return m ? m[1].split(/\s+vs\s+/).map(x => x.trim()) : [];
  };
  const srvArgs = argsOf(serverBT);
  const jsArgs = argsOf(jsBT);
  if (kindOf(serverBT) === 'Strain choice') {
    if (srvArgs.length !== 2 || jsArgs.length !== 2) return false;
    // Same pair (any order): trivially equivalent.
    if (srvArgs[0] === jsArgs[0] && srvArgs[1] === jsArgs[1]) return true;
    if (srvArgs[0] === jsArgs[1] && srvArgs[1] === jsArgs[0]) return true;
    // Different pair members: equivalent if the position-0 counts and
    // position-1 counts both tie on some side. The Rust algorithm picks
    // the top-2 qualifying (count >= 2) strains via a stable sort over
    // HashMap iteration order, so any pick where positional counts match
    // server's pick is valid (e.g., S=5, H=3, NT=3 admits both
    // "(S vs H)" and "(S vs NT)").
    for (const side of ['NS', 'EW']) {
      const counts = groupBySideStrain(allResults, side);
      const get = s => counts.get(s) || 0;
      const all = [...srvArgs, ...jsArgs];
      if (!all.every(s => get(s) >= 2)) continue;
      if (get(srvArgs[0]) === get(jsArgs[0]) && get(srvArgs[1]) === get(jsArgs[1])) return true;
      if (get(srvArgs[0]) === get(jsArgs[1]) && get(srvArgs[1]) === get(jsArgs[0])) return true;
    }
    return false;
  }
  if (kindOf(serverBT) === 'Competitive') {
    // The classifier picks each side's primary strain via stable sort over
    // randomized HashMap iteration, so ties on EITHER side can produce a
    // valid-but-different choice. Equivalent if positional counts tie:
    // count(NS strain) on NS side matches between server's pick and JS's
    // pick, and count(EW strain) on EW side does the same.
    const sideCounts = (side) => {
      const m = new Map();
      for (const r of allResults) {
        if (!r.contract || r.contract === 'PASS') continue;
        if (declaringDirection(r) !== side) continue;
        const s = extractStrain(r.contract);
        m.set(s, (m.get(s) || 0) + 1);
      }
      return m;
    };
    const nsCounts = sideCounts('NS');
    const ewCounts = sideCounts('EW');
    const ns = (s) => nsCounts.get(s) || 0;
    const ew = (s) => ewCounts.get(s) || 0;
    // Both choices must be qualifying (count >= 2) on their respective sides.
    if (ns(srvArgs[0]) < 2 || ns(jsArgs[0]) < 2) return false;
    if (ew(srvArgs[1]) < 2 || ew(jsArgs[1]) < 2) return false;
    return ns(srvArgs[0]) === ns(jsArgs[0]) && ew(srvArgs[1]) === ew(jsArgs[1]);
  }
  if (kindOf(serverBT) === 'Slam vs Game' || kindOf(serverBT) === 'Game vs Partscore') {
    // Both single-strain classifications — counts must tie in the relevant
    // bucket for the disagreement to be a tie-break, not a real diff.
    const slot = kindOf(serverBT) === 'Slam vs Game' ? 'slam' : 'game';
    const tally = new Map();
    for (const r of allResults) {
      if (!r.contract || r.contract === 'PASS') continue;
      const s = extractStrain(r.contract);
      const lvl = parseInt(r.contract[0], 10);
      const cur = tally.get(s) || { slam: 0, game: 0, ps: 0 };
      if (lvl >= 6) cur.slam++;
      else if (isGameLevel(r.contract)) cur.game++;
      else cur.ps++;
      tally.set(s, cur);
    }
    const a = (tally.get(srvArgs[0]) || { [slot]: 0 })[slot];
    const b = (tally.get(jsArgs[0]) || { [slot]: 0 })[slot];
    return a === b;
  }
  return false;
}

/** Helper for classifyBoard: per-side strain count map. */
function groupBySideStrain(allResults, side) {
  const map = new Map();
  for (const r of allResults) {
    if (!r.contract || r.contract === 'PASS') continue;
    if (declaringDirection(r) !== side) continue;
    const s = extractStrain(r.contract);
    map.set(s, (map.get(s) || 0) + 1);
  }
  return map;
}

/** True when the actual contract is a par contract for the declaring side.
 *  Same side + same level + same strain (ignores doubled). Mirrors
 *  contract_matches_par(). With multiple par entries (ties), matching any
 *  one counts. */
function contractMatchesPar(actualContract, declarerIsNs, parArray) {
  if (!actualContract || actualContract === 'PASS') return false;
  const aLvl = actualContract[0];
  const aStrain = extractStrain(actualContract);
  for (const p of parArray) {
    const pIsNs = p.declarer === 'N' || p.declarer === 'S';
    if (pIsNs !== declarerIsNs) continue;
    const pLvl = p.contract[0];
    const pStrain = extractStrain(p.contract);
    if (aLvl === pLvl && aStrain === pStrain) return true;
  }
  return false;
}

/** Compute the full BoardContext-equivalent for a board. Inputs are the
 *  per-board result list (from session.boards[i].results) and the par array
 *  (board.par). Mirrors compute_board_context's output shape, JS-side. */
function computeBoardContext(allResults, parArray) {
  const counts = fieldContractCounts(allResults);
  const fc = fieldContract(allResults);
  const flags = declaringFlags(allResults);
  const competitiveNs = computeCompetitiveInfo(allResults, 'NS');
  const competitiveEw = computeCompetitiveInfo(allResults, 'EW');
  const boardType = classifyBoard(allResults, competitiveNs);
  const trickAvgs = fieldTrickAverages(allResults);
  return {
    fieldContract: fc,
    fieldContractCounts: counts,
    fieldTrickAverages: trickAvgs,
    boardType,
    competitiveNs,
    competitiveEw,
    nsTypicallyDeclares: flags.nsTypicallyDeclares,
    ewTypicallyDeclares: flags.ewTypicallyDeclares,
    fieldDeclaringDirection: flags.fieldDeclaringDirection,
    par: parArray || [],
  };
}

// ---- Cause analysis ----
//
// Direct port of analysis::metrics::player::determine_cause_and_notes —
// the 440-line decision tree that classifies each result as Good / Lucky /
// Play / Defense / Auction / Unlucky and produces the textual notes.
//
// CauseContext is a record collecting everything the tree reads:
//   role                            'Declarer' | 'Dummy' | 'Defender'
//   matchpointPct                   number 0..100
//   declarerVsField                 number | null (only when meaningful)
//   matchedFieldContract            bool
//   sameStrainAsField               bool
//   playerSideTypicallyDeclares     bool
//   fieldIsCrossDirection           bool
//   wentDown                        bool
//   ddTricks                        number 0..13 | null
//   tricksMade                      number 0..13 | null
//   boardType                       BoardType display string
//   competitive                     CompetitiveInfo | null (player's perspective)
//   contract                        canonical string | null | "PASS"
//   fieldContract                   canonical string | null
//   contractIsPar                   bool
//
// The tree returns { cause: string, notes: string }. Cause values mirror
// the Rust ResultCause enum's Display form ("Good", "Lucky", ...).

const SUIT_ORDER_RANK = { C: 0, D: 1, H: 2, S: 3, NT: 4 };

/** Bid rank: 1C < 1D < 1H < 1S < 1NT < 2C < ... < 7NT. Mirrors bid_rank_of. */
function bidRankOf(level, strain) { return (level - 1) * 5 + (SUIT_ORDER_RANK[strain] ?? 0); }
/** Bid rank of a canonical contract string. */
function bidRank(contract) {
  const lvl = parseInt(contract[0], 10);
  return bidRankOf(lvl, extractStrain(contract));
}
/** Smallest level (1-7) at which `strain` outbids `contract`. */
function minOutbidLevel(contract, strain) {
  const target = bidRank(contract);
  for (let level = 1; level <= 7; level++) {
    if (bidRankOf(level, strain) > target) return level;
  }
  return null;
}
function tricksWord(n) { return Math.abs(n) === 1 ? 'trick' : 'tricks'; }

/** Round half away from zero — matches Rust's f64::round semantics.
 *  JS's Math.round rounds half toward +Infinity, so Math.round(-0.5) === 0
 *  while (-0.5_f64).round() === -1. This wrapper aligns the two so trick
 *  diffs at .5 boundaries route into the same cause branch. */
function rustRound(x) {
  return Math.sign(x) * Math.round(Math.abs(x));
}
function levelOf(c) { return parseInt(c[0], 10); }

/** Look up double-dummy tricks for a (declarer, strain) on a board.
 *  Schema's double_dummy is {N|E|S|W: {C, D, H, S, NT}}. */
function ddTricksLookup(board, declarer, strain) {
  const dd = board.double_dummy;
  if (!dd) return null;
  const seat = dd[declarer];
  if (!seat) return null;
  // Schema uses "C", "D", "H", "S", "NT" as keys.
  return seat[strain] ?? null;
}

/** Equivalent of Rust's format_auction_note. */
function formatAuctionNote(actual, field) {
  if (!actual && !field) return '';
  if (actual && !field) return '';
  if (!actual && field) return `missed ${field}`;
  // Both present — actual is non-PASS canonical, field is non-null canonical.
  const aLvl = levelOf(actual), fLvl = levelOf(field);
  const aS = extractStrain(actual), fS = extractStrain(field);
  if (aS !== fS) return `${aS} vs ${fS}`;
  if (aLvl < fLvl) {
    const missedGame = isGameLevel(field) && !isGameLevel(actual);
    const missedSlam = fLvl >= 6 && aLvl < 6;
    return missedGame || missedSlam ? `underbid (${field})` : '';
  }
  if (aLvl > fLvl) {
    const extraGame = isGameLevel(actual) && !isGameLevel(field);
    const extraSlam = aLvl >= 6 && fLvl < 6;
    return extraGame || extraSlam ? `overbid (${field})` : '';
  }
  return '';
}

/** The full cause-analysis decision tree. Direct line-for-line port of
 *  determine_cause_and_notes — see analysis/src/metrics/player.rs. */
function determineCauseAndNotes(ctx) {
  const isGood = ctx.matchpointPct >= 55.0;
  const isBad = ctx.matchpointPct <= 45.0;

  if (ctx.role === 'Declarer') {
    if (ctx.contractIsPar && ctx.ddTricks != null && ctx.tricksMade != null && ctx.tricksMade === ctx.ddTricks) {
      return { cause: 'Good', notes: `par (${ctx.ddTricks})` };
    }
    if (ctx.competitive && ctx.contract && ctx.contract !== 'PASS') {
      const cStrain = extractStrain(ctx.contract);
      const cLvl = levelOf(ctx.contract);
      if (cStrain === ctx.competitive.playerStrain &&
          bidRankOf(ctx.competitive.oppMaxLevel, ctx.competitive.oppStrain) > bidRankOf(cLvl, cStrain) &&
          isGood) {
        return { cause: 'Lucky', notes: 'opps failed to compete' };
      }
    }
    if (ctx.fieldIsCrossDirection) {
      if (isGood) return { cause: 'Good', notes: 'competed successfully' };
      if (isBad) {
        if (ctx.contract && ctx.contract !== 'PASS' && ctx.ddTricks != null && ctx.wentDown) {
          const needed = levelOf(ctx.contract) + 6;
          if (ctx.ddTricks >= needed) return { cause: 'Play', notes: `below DD (${ctx.ddTricks})` };
        }
        return { cause: 'Auction', notes: 'competed too high' };
      }
      return { cause: 'Auction', notes: 'competed' };
    }
    const auctionNote = !ctx.matchedFieldContract ? formatAuctionNote(ctx.contract, ctx.fieldContract) : '';
    if (ctx.sameStrainAsField) {
      if (ctx.matchedFieldContract && ctx.ddTricks != null && ctx.tricksMade != null) {
        const ddDiff = ctx.tricksMade - ctx.ddTricks;
        if (ddDiff > 0) return { cause: 'Lucky', notes: `defense slip (DD ${ctx.ddTricks})` };
        if (ddDiff < 0) return { cause: 'Play', notes: `below DD (${ctx.ddTricks})` };
        return { cause: 'Good', notes: `field par (${ctx.ddTricks})` };
      }
      if (ctx.declarerVsField != null) {
        const td = rustRound(ctx.declarerVsField);
        if (td < 0) {
          const tn = `${-td} ${tricksWord(td)} fewer`;
          const note = auctionNote ? `${tn}, also ${auctionNote}` : tn;
          return { cause: 'Play', notes: note };
        }
        if (td > 0) {
          const tn = `+${td} ${tricksWord(td)}`;
          const note = auctionNote ? `${tn}, also ${auctionNote}` : tn;
          return { cause: isGood ? 'Good' : 'Play', notes: note };
        }
        if (ctx.matchedFieldContract) {
          if (isGood) return { cause: 'Good', notes: '' };
          if (isBad) return { cause: 'Unlucky', notes: 'field avg' };
        }
      }
      if (ctx.wentDown && ctx.contract && ctx.contract !== 'PASS' && ctx.fieldContract) {
        if (levelOf(ctx.contract) < levelOf(ctx.fieldContract)) {
          return { cause: 'Play', notes: 'went down' };
        }
      }
    } else {
      if (ctx.competitive && ctx.fieldContract && extractStrain(ctx.fieldContract) === ctx.competitive.oppStrain) {
        if (isGood) return { cause: 'Good', notes: 'competed successfully' };
        if (isBad) return { cause: 'Auction', notes: 'competed too high' };
        return { cause: 'Auction', notes: 'competed' };
      }
      if (auctionNote) {
        return { cause: isGood ? 'Good' : 'Auction', notes: auctionNote };
      }
    }
    if (!ctx.matchedFieldContract && auctionNote) {
      return { cause: isGood ? 'Good' : 'Auction', notes: auctionNote };
    }
  } else if (ctx.role === 'Dummy') {
    if (ctx.contractIsPar && ctx.ddTricks != null && ctx.tricksMade != null && ctx.tricksMade === ctx.ddTricks) {
      return { cause: 'Good', notes: `par (${ctx.ddTricks})` };
    }
    if (ctx.competitive && ctx.contract && ctx.contract !== 'PASS') {
      const cStrain = extractStrain(ctx.contract);
      const cLvl = levelOf(ctx.contract);
      if (cStrain === ctx.competitive.playerStrain &&
          bidRankOf(ctx.competitive.oppMaxLevel, ctx.competitive.oppStrain) > bidRankOf(cLvl, cStrain) &&
          isGood) {
        return { cause: 'Lucky', notes: 'opps failed to compete' };
      }
    }
    if (ctx.fieldIsCrossDirection) {
      if (isGood) return { cause: 'Good', notes: 'competed successfully' };
      if (isBad) {
        if (ctx.contract && ctx.contract !== 'PASS' && ctx.ddTricks != null && ctx.wentDown) {
          const needed = levelOf(ctx.contract) + 6;
          if (ctx.ddTricks >= needed) return { cause: 'Play', notes: `pard below DD (${ctx.ddTricks})` };
        }
        return { cause: 'Auction', notes: 'competed too high' };
      }
      return { cause: 'Auction', notes: 'competed' };
    }
    const auctionNote = !ctx.matchedFieldContract ? formatAuctionNote(ctx.contract, ctx.fieldContract) : '';
    if (ctx.sameStrainAsField) {
      if (ctx.matchedFieldContract && ctx.ddTricks != null && ctx.tricksMade != null) {
        const ddDiff = ctx.tricksMade - ctx.ddTricks;
        if (ddDiff > 0) return { cause: 'Lucky', notes: `defense slip (DD ${ctx.ddTricks})` };
        if (ddDiff < 0) return { cause: 'Play', notes: `pard below DD (${ctx.ddTricks})` };
        return { cause: 'Good', notes: `field par (${ctx.ddTricks})` };
      }
      if (ctx.declarerVsField != null) {
        const td = rustRound(ctx.declarerVsField);
        if (td < 0) {
          const tn = `pard ${td} ${tricksWord(td)}`;
          const note = auctionNote ? `${tn}, also ${auctionNote}` : tn;
          return { cause: 'Play', notes: note };
        }
        if (td > 0) {
          const tn = `pard +${td} ${tricksWord(td)}`;
          const note = auctionNote ? `${tn}, also ${auctionNote}` : tn;
          return { cause: isGood ? 'Good' : 'Play', notes: note };
        }
      }
      if (ctx.wentDown && ctx.contract && ctx.contract !== 'PASS' && ctx.fieldContract) {
        if (levelOf(ctx.contract) < levelOf(ctx.fieldContract)) {
          return { cause: 'Play', notes: 'pard went down' };
        }
      }
    } else {
      if (ctx.competitive && ctx.fieldContract && extractStrain(ctx.fieldContract) === ctx.competitive.oppStrain) {
        if (isGood) return { cause: 'Good', notes: 'competed successfully' };
        if (isBad) return { cause: 'Auction', notes: 'competed too high' };
        return { cause: 'Auction', notes: 'competed' };
      }
      if (auctionNote) {
        return { cause: isGood ? 'Good' : 'Auction', notes: auctionNote };
      }
    }
    if (!ctx.matchedFieldContract && auctionNote) {
      return { cause: isGood ? 'Good' : 'Auction', notes: auctionNote };
    }
  } else if (ctx.role === 'Defender') {
    if (ctx.wentDown && ctx.matchpointPct < 45.0 && ctx.contract && ctx.contract !== 'PASS') {
      // Doubled char is the substring after level + strain
      const sLen = extractStrain(ctx.contract) === 'NT' ? 2 : 1;
      const doubledStr = ctx.contract.substring(1 + sLen);
      if (doubledStr === '') {
        return { cause: 'Auction', notes: "didn't double" };
      }
    }
    if (ctx.competitive && ctx.contract && ctx.contract !== 'PASS') {
      const cStrain = extractStrain(ctx.contract);
      const cLvl = levelOf(ctx.contract);
      if (cStrain === ctx.competitive.oppStrain &&
          bidRankOf(ctx.competitive.playerMaxLevel, ctx.competitive.playerStrain) > bidRankOf(cLvl, cStrain)) {
        const outbidLevel = minOutbidLevel(ctx.contract, ctx.competitive.playerStrain) ?? ctx.competitive.playerMaxLevel;
        const note = `failed to compete to ${outbidLevel}${ctx.competitive.playerStrain}`;
        if (isBad) return { cause: 'Auction', notes: note };
        if (isGood) {
          const oppsNote = ctx.wentDown ? 'opps bid too high' : 'opps stopped low';
          return { cause: 'Lucky', notes: oppsNote };
        }
      }
    }
    if (ctx.fieldIsCrossDirection) {
      if (isGood) return { cause: 'Lucky', notes: 'opps competed too high' };
      if (isBad) return { cause: 'Auction', notes: 'failed to compete' };
      return { cause: 'Lucky', notes: 'opps competed' };
    }
    if (ctx.sameStrainAsField) {
      if (ctx.matchedFieldContract && ctx.ddTricks != null && ctx.tricksMade != null) {
        const ddDiff = ctx.tricksMade - ctx.ddTricks;
        if (ddDiff > 0) return { cause: 'Defense', notes: `DD slip (gave ${ddDiff} extra)` };
        if (ddDiff < 0) return { cause: 'Lucky', notes: `held below DD (${ctx.ddTricks})` };
        return { cause: 'Good', notes: `field par (${ctx.ddTricks})` };
      }
      if (ctx.declarerVsField != null) {
        const td = rustRound(ctx.declarerVsField);
        if (td > 0) {
          const note = `gave ${td} ${tricksWord(td)}`;
          if (isBad) return { cause: 'Defense', notes: note };
        } else if (td < 0) {
          const note = `held to ${td}`;
          if (isGood) return { cause: 'Good', notes: note };
          return { cause: 'Defense', notes: note };
        }
      }
      if (!ctx.matchedFieldContract && ctx.contract && ctx.contract !== 'PASS' && ctx.fieldContract) {
        const aLvl = levelOf(ctx.contract), fLvl = levelOf(ctx.fieldContract);
        if (aLvl < fLvl) {
          const cross = (isGameLevel(ctx.fieldContract) && !isGameLevel(ctx.contract)) || (fLvl >= 6 && aLvl < 6);
          if (cross) {
            if (isGood) return { cause: 'Lucky', notes: 'opps underbid' };
            if (isBad) return { cause: 'Unlucky', notes: 'opps underbid' };
          }
        } else if (aLvl > fLvl) {
          const cross = (isGameLevel(ctx.contract) && !isGameLevel(ctx.fieldContract)) || (aLvl >= 6 && fLvl < 6);
          if (cross) {
            if (isGood) return { cause: 'Lucky', notes: 'opps overbid' };
            if (isBad) return { cause: 'Unlucky', notes: 'opps overbid' };
          }
        }
      }
    } else if (ctx.contract && ctx.contract !== 'PASS' && ctx.fieldContract) {
      if (ctx.playerSideTypicallyDeclares && bidRank(ctx.contract) < bidRank(ctx.fieldContract)) {
        const note = `failed to compete to ${ctx.fieldContract}`;
        if (isBad) return { cause: 'Auction', notes: note };
        if (isGood) return { cause: 'Good', notes: note };
      }
      if (!ctx.playerSideTypicallyDeclares) {
        if (isBad) return { cause: 'Unlucky', notes: 'opps superior contract' };
        if (isGood) return { cause: 'Lucky', notes: 'opps inferior contract' };
      }
    }
    if (isGood) return { cause: 'Lucky', notes: '' };
    if (isBad) return { cause: 'Unlucky', notes: '' };
  }

  // Default by matchpoint result.
  if (isGood) return { cause: 'Good', notes: '' };
  if (isBad) return { cause: 'Unlucky', notes: '' };
  return { cause: 'Good', notes: '' };
}

/** Build the CauseContext for a (board, result, role, direction) tuple,
 *  reusing the previously-ported helpers. `boardCtx` is the output of
 *  computeBoardContext. */
function buildCauseContext(board, result, role, direction, boardCtx) {
  const declarerIsNs = declaringDirection(result) === 'NS';
  const fieldIsCrossDirection = result.contract && result.contract !== 'PASS' &&
    boardCtx.fieldDeclaringDirection != null &&
    declaringDirection(result) !== boardCtx.fieldDeclaringDirection;
  const tricks = tricksMade(result);
  const wentDown = tricks != null && result.contract && result.contract !== 'PASS' &&
    tricks < levelOf(result.contract) + 6;
  const ddT = (result.contract && result.contract !== 'PASS')
    ? ddTricksLookup(board, result.declarer, extractStrain(result.contract))
    : null;
  const competitive = direction === 'NS' ? boardCtx.competitiveNs : boardCtx.competitiveEw;
  const playerSideTypicallyDeclares = direction === 'NS'
    ? boardCtx.nsTypicallyDeclares : boardCtx.ewTypicallyDeclares;
  const matched = matchedFieldContract(result.contract, boardCtx.fieldContract);
  const sameStrain = sameStrainAsField(result.contract, boardCtx.fieldContract);
  const playerSideIsDeclarer = declarerIsNs === (direction === 'NS');
  const contractIsPar = playerSideIsDeclarer && contractMatchesPar(result.contract, declarerIsNs, boardCtx.par);
  const dvf = declarerVsField(result, boardCtx.fieldTrickAverages);
  // matchpointPct is per-direction
  return {
    role,
    matchpointPct: 0, // filled in by caller (it varies by use site)
    declarerVsField: dvf,
    matchedFieldContract: matched,
    sameStrainAsField: sameStrain,
    playerSideTypicallyDeclares,
    fieldIsCrossDirection,
    wentDown,
    ddTricks: ddT,
    tricksMade: tricks,
    boardType: boardCtx.boardType,
    competitive,
    contract: result.contract,
    fieldContract: boardCtx.fieldContract,
    contractIsPar,
  };
}

// ---- Orchestration: analyze_player / analyze_board ----
//
// These produce response objects in the same shape the server used to
// return when there was a server-side analyzer (PlayerAnalysisResponse /
// BoardAnalysisResponse). The server endpoints are gone now; this is the
// only analyzer path.

/** Find which seat (N/E/S/W) a player sits at in this result, or null. */
function findPlayerSeat(result, normName) {
  // ns_pair.players[0] = N, [1] = S; ew_pair.players[0] = W, [1] = E
  // (see analysis/src/data/builder.rs for the convention).
  const nNS = result.ns_pair?.players ?? [];
  const nEW = result.ew_pair?.players ?? [];
  if (nNS[0] && normalizeName(nNS[0].name) === normName) return 'N';
  if (nNS[1] && normalizeName(nNS[1].name) === normName) return 'S';
  if (nEW[0] && normalizeName(nEW[0].name) === normName) return 'W';
  if (nEW[1] && normalizeName(nEW[1].name) === normName) return 'E';
  return null;
}

/** Partner's display name + seat letter from this result, given the player's seat. */
function partnerOf(result, seat) {
  switch (seat) {
    case 'N': return { name: result.ns_pair.players[1]?.name, seat: 'S' };
    case 'S': return { name: result.ns_pair.players[0]?.name, seat: 'N' };
    case 'W': return { name: result.ew_pair.players[1]?.name, seat: 'E' };
    case 'E': return { name: result.ew_pair.players[0]?.name, seat: 'W' };
    default: return { name: '', seat: null };
  }
}

/** Determine the player's role on this result given their seat.
 *  - Declarer: the player declared
 *  - Dummy:    the player's PARTNER declared
 *  - Defender: opponents declared (or PASS) */
function playerRole(result, seat) {
  if (!result.contract || result.contract === 'PASS') return 'Defender';
  const declarer = result.declarer;
  if (declarer === seat) return 'Declarer';
  const partner = { N: 'S', S: 'N', E: 'W', W: 'E' }[seat];
  if (declarer === partner) return 'Dummy';
  return 'Defender';
}

/** Convert a schema Hand to a PBN suit string ("AKQ.JT.987.5432").
 *  Schema uses "10" for ten; PBN uses "T". Empty suit becomes "".
 *  Order is S.H.D.C per PBN convention. */
function handToPBN(hand) {
  if (!hand) return '...';
  const conv = r => (r === '10' ? 'T' : r);
  const fmt = arr => (arr || []).map(conv).join('');
  return [fmt(hand.S), fmt(hand.H), fmt(hand.D), fmt(hand.C)].join('.');
}

/** Convert a schema Deal + dealer letter to the PBN deal string
 *  "<dealer>:<hand1> <hand2> <hand3> <hand4>", clockwise from dealer. */
function dealToPBN(deal, dealer) {
  if (!deal) return null;
  const clockwise = { N: ['N','E','S','W'], E: ['E','S','W','N'],
                       S: ['S','W','N','E'], W: ['W','N','E','S'] };
  const seq = clockwise[dealer] || clockwise.N;
  return `${dealer}:${seq.map(d => handToPBN(deal[d])).join(' ')}`;
}

/** Render the par contract + optimum score display strings from the
 *  schema's typed par[]. Mirrors render_par_display in types.rs.
 *  Note: schema's Par has no tricks field, so the trick suffix
 *  ("+2"/"=") is omitted. The Rust path derives it from score, but
 *  porting bridge scoring rules to JS isn't worth the test-phase cost. */
function renderParDisplayJS(par) {
  if (!par || par.length === 0) return { contract: null, score: null };
  const sideOf = d => (d === 'N' || d === 'S') ? 'NS' : 'EW';
  const contracts = par.map(p => `${sideOf(p.declarer)} ${p.contract}`).join('; ');
  const first = par[0];
  const score = first.score >= 0 ? `NS ${first.score}` : `EW ${-first.score}`;
  return { contract: contracts, score };
}

/** Build a BoardDealInfo-shape object from a schema board, matching what
 *  the server's analyze_board response produces. Returns null when the
 *  source had no deal data — the SPA's hand viewer hides itself in that
 *  case. */
function buildDealInfo(board) {
  if (!board.deal) return null;
  const { contract: parContract, score: optimumScore } =
    renderParDisplayJS(board.par || []);
  return {
    pbn: dealToPBN(board.deal, board.dealer),
    dealer: board.dealer,
    vulnerability: board.vulnerability,
    par_contract: parContract,
    optimum_score: optimumScore,
  };
}

/** Build a result string like "4SN+1" / "3NTE=" / "2HS-2" / "Pass".
 *  Mirrors build_result_string in player.rs. */
function buildResultString(result) {
  if (!result.contract || result.contract === 'PASS') return 'Pass';
  const declCh = result.declarer ?? 'N';
  const tricks = tricksMade(result);
  if (tricks == null) return `${result.contract}${declCh}`;
  const rel = tricks - (levelOf(result.contract) + 6);
  if (rel === 0) return `${result.contract}${declCh}=`;
  if (rel > 0) return `${result.contract}${declCh}+${rel}`;
  return `${result.contract}${declCh}${rel}`;
}

/** Build a PBN (Portable Bridge Notation) document for a session: one deal
 *  record per board (every board with a deal, regardless of who played it),
 *  annotated with the selected player's table — names, contract, declarer,
 *  result and score — only on the boards they actually played. Boards the
 *  player sat out are still emitted (deal only) so the board set is complete
 *  and board numbers stay correct. Returns { text, filename } or null when
 *  there's nothing to export. */
function buildPlayerPBN(game, sessionIdx, playerName) {
  const session = pickSession(game, sessionIdx);
  if (!session) return null;
  const norm = normalizeName(playerName);
  const meta = deriveEventMeta();
  const event = meta.event_name || 'Game';
  const pbnDate = (meta.event_date || '').replace(/-/g, '.'); // YYYY-MM-DD -> YYYY.MM.DD (PBN)
  // PBN [Vulnerable] uses None/NS/EW/All; schema uses None/NS/EW/Both.
  const vulMap = { None: 'None', NS: 'NS', EW: 'EW', Both: 'All', All: 'All' };

  const records = [];
  for (const board of session.boards) {
    if (!board.deal) continue; // can't write a deal record without the hands
    // The selected player's result at this board, if they played it.
    const result = board.results.find(r => findPlayerSeat(r, norm));

    const tags = [];
    const tag = (k, v) => tags.push(`[${k} "${(v ?? '').toString().replace(/"/g, "'")}"]`);
    tag('Event', event);
    tag('Site', '');
    tag('Date', pbnDate);
    tag('Board', board.number); // always the real board number, never a counter
    if (result) {
      // ns_pair.players[0]=N, [1]=S; ew_pair.players[0]=W, [1]=E.
      const nameAt = (pair, idx) => displayName(result[pair]?.players?.[idx]?.name || '');
      tag('West', nameAt('ew_pair', 0));
      tag('North', nameAt('ns_pair', 0));
      tag('East', nameAt('ew_pair', 1));
      tag('South', nameAt('ns_pair', 1));
    }
    tag('Dealer', board.dealer || 'N');
    tag('Vulnerable', vulMap[board.vulnerability] || 'None');
    tag('Deal', dealToPBN(board.deal, board.dealer || 'N'));
    tag('Scoring', 'MP');
    // Contract/declarer/result/score only for boards the player played.
    if (result) {
      if (!result.contract || result.contract === 'PASS') {
        tag('Declarer', '');
        tag('Contract', 'Pass');
        tag('Result', '');
      } else {
        const tricks = tricksMade(result);
        tag('Declarer', result.declarer || '');
        tag('Contract', result.contract); // already canonical "3NT" / "4SX" / "6HXX"
        tag('Result', tricks == null ? '' : tricks);
        const score = result.score ?? 0;
        tag('Score', score >= 0 ? `NS ${score}` : `EW ${-score}`);
      }
    }
    records.push(tags.join('\n'));
  }
  if (!records.length) return null;

  const text = '% PBN 2.1\n% Export "Club Game Analysis by Bridge Classroom"\n\n'
    + records.join('\n\n') + '\n';
  const safe = s => (s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  const filename = `${safe(event)}-${safe(playerName)}-${safe(meta.event_date) || 'game'}.pbn`;
  return { text, filename };
}

/** Run the JS analyzer on one player. Returns a PlayerAnalysisResponse-shape
 *  object, or null if the player has no rows in this session. */
function jsAnalyzePlayer(game, sessionIdx, playerName) {
  const session = pickSession(game, sessionIdx);
  if (!session) return null;
  const norm = normalizeName(playerName);
  // Walk every (board, result) and pick out rows where the player sat.
  const rows = [];
  let canonicalName = playerName;
  for (const board of session.boards) {
    for (const result of board.results) {
      const seat = findPlayerSeat(result, norm);
      if (seat) {
        rows.push({ board, result, seat });
        const players = (seat === 'N' || seat === 'S' ? result.ns_pair : result.ew_pair).players;
        const idx = (seat === 'N' || seat === 'W') ? 0 : 1;
        if (players[idx]?.name) canonicalName = displayName(players[idx].name);
      }
    }
  }
  if (rows.length === 0) return null;

  const partners = new Set();
  const seats = new Set();
  let totalMP = 0;
  let declCount = 0, declMP = 0;
  let dummyCount = 0, dummyMP = 0;
  let defCount = 0, defMP = 0;
  let dvfSum = 0, dvfCount = 0;
  let fieldMatchCount = 0;
  let strat = null;
  let mpAward = null;
  const board_results = [];

  for (const { board, result, seat } of rows) {
    const direction = (seat === 'N' || seat === 'S') ? 'NS' : 'EW';
    const pairRecord = direction === 'NS' ? result.ns_pair : result.ew_pair;
    if (strat == null && pairRecord?.strat != null) strat = pairRecord.strat;
    if (mpAward == null) {
      const playerIdx = (seat === 'N' || seat === 'W') ? 0 : 1;
      const awards = pairRecord?.players?.[playerIdx]?.masterpoints_earned;
      if (awards?.length) mpAward = summarizeMpAwards(awards);
    }
    const role = playerRole(result, seat);
    const ctx = computeBoardContext(board.results, board.par);
    const mp = calculateMatchpointPct(result, board.results, direction);
    const cc = buildCauseContext(board, result, role, direction, ctx);
    cc.matchpointPct = mp;
    const { cause, notes } = determineCauseAndNotes(cc);
    const partner = partnerOf(result, seat);

    seats.add(seat);
    if (partner.name) partners.add(displayName(partner.name));
    totalMP += mp;
    if (role === 'Declarer') { declCount++; declMP += mp;
      if (cc.declarerVsField != null) { dvfSum += cc.declarerVsField; dvfCount++; }
    } else if (role === 'Dummy') { dummyCount++; dummyMP += mp; }
    else { defCount++; defMP += mp; }
    if (cc.matchedFieldContract) fieldMatchCount++;

    const ns_score = result.score ?? 0;
    board_results.push({
      board_number: board.number,
      direction,
      seat,
      partner: displayName(partner.name || ''),
      contract: result.contract,
      result_str: buildResultString(result),
      ns_score,
      player_score: direction === 'NS' ? ns_score : -ns_score,
      matchpoint_pct: mp,
      role,
      // Server only sets declarer_vs_field on PlayerBoardResult when the
      // player actually declared; mirror that gate.
      declarer_vs_field: role === 'Declarer' ? cc.declarerVsField : null,
      field_contract: ctx.fieldContract,
      board_type: ctx.boardType,
      matched_field_contract: cc.matchedFieldContract,
      cause,
      notes,
      bbo_url: null, // LIN URL builder not yet ported.
    });
  }

  return {
    player_name: canonicalName,
    partners: [...partners].sort(),
    seats: [...seats].sort(),
    boards_played: rows.length,
    boards_declared: declCount,
    avg_matchpoint_pct: totalMP / rows.length,
    declaring_mp_pct: declCount > 0 ? declMP / declCount : null,
    dummy_mp_pct: dummyCount > 0 ? dummyMP / dummyCount : null,
    defending_mp_pct: defCount > 0 ? defMP / defCount : null,
    avg_declarer_vs_field: dvfCount > 0 ? dvfSum / dvfCount : null,
    field_contract_pct: (fieldMatchCount / rows.length) * 100,
    strat,
    mp_award: mpAward,
    board_results,
  };
}

/** Run the JS analyzer on one board. Returns a BoardAnalysisResponse-shape
 *  object, or null if the board doesn't exist in the session. */
function jsAnalyzeBoard(game, sessionIdx, boardNum) {
  const session = pickSession(game, sessionIdx);
  if (!session) return null;
  const board = session.boards.find(b => b.number === boardNum);
  if (!board) return null;
  const ctx = computeBoardContext(board.results, board.par);
  const results = board.results.map(r => {
    const isPass = !r.contract || r.contract === 'PASS';
    const declSide = isPass ? null : declaringDirection(r);
    const nsRole = isPass ? 'Defender' : (declSide === 'NS' ? 'Declarer' : 'Defender');
    const ewRole = isPass ? 'Defender' : (declSide === 'EW' ? 'Declarer' : 'Defender');
    const nsMP = calculateMatchpointPct(r, board.results, 'NS');
    const ewMP = calculateMatchpointPct(r, board.results, 'EW');

    const nsCC = buildCauseContext(board, r, nsRole, 'NS', ctx);
    nsCC.matchpointPct = nsMP;
    const ns = determineCauseAndNotes(nsCC);

    const ewCC = buildCauseContext(board, r, ewRole, 'EW', ctx);
    ewCC.matchpointPct = ewMP;
    const ew = determineCauseAndNotes(ewCC);

    const ns_p1 = displayName(r.ns_pair.players[0]?.name ?? '');
    const ns_p2 = displayName(r.ns_pair.players[1]?.name ?? '');
    const ew_p1 = displayName(r.ew_pair.players[0]?.name ?? '');
    const ew_p2 = displayName(r.ew_pair.players[1]?.name ?? '');
    const declarer_name = r.declarer === 'N' ? ns_p1 : r.declarer === 'S' ? ns_p2 :
                          r.declarer === 'W' ? ew_p1 : r.declarer === 'E' ? ew_p2 : '';

    const dvf = nsCC.declarerVsField; // same value from both perspectives
    return {
      ns_pair: `${ns_p1} - ${ns_p2}`,
      ew_pair: `${ew_p1} - ${ew_p2}`,
      ns_player1: ns_p1, ns_player2: ns_p2,
      ew_player1: ew_p1, ew_player2: ew_p2,
      contract: r.contract,
      declarer_direction: r.declarer ?? 'N',
      declarer_name,
      result_str: buildResultString(r),
      ns_score: r.score ?? 0,
      ns_analysis: {
        matchpoint_pct: nsMP, role: nsRole, declarer_vs_field: dvf,
        matched_field_contract: nsCC.matchedFieldContract, cause: ns.cause, notes: ns.notes,
      },
      ew_analysis: {
        matchpoint_pct: ewMP, role: ewRole, declarer_vs_field: dvf,
        matched_field_contract: ewCC.matchedFieldContract, cause: ew.cause, notes: ew.notes,
      },
      // The schema's per-row handviewer_url is populated by every adapter
      // (extension and the BWS+PBN adapter), so we just pass it through.
      bbo_url: r.handviewer_url ?? null,
    };
  });
  // Sort by NS matchpoint % desc — same as the server's analyze_board.
  results.sort((a, b) => b.ns_analysis.matchpoint_pct - a.ns_analysis.matchpoint_pct);
  // Server's BoardAnalysisResponse.bbo_url is the first row's URL as a
  // board-level default (used when no row has rendered yet).
  const boardBbo = results.find(r => r.bbo_url)?.bbo_url ?? null;
  return {
    board_number: board.number,
    field_contract: ctx.fieldContract,
    board_type: ctx.boardType,
    bbo_url: boardBbo,
    deal_info: buildDealInfo(board),
    results,
  };
}


/** Build a query-string suffix that always passes session, plus session_idx
 *  when more than one session is in the upload. */
function sessionParams() {
  let qs = `session=${sessionId}`;
  if (cachedSessions.length > 1) qs += `&session_idx=${currentSessionIdx}`;
  return qs;
}

/** Reset all in-flight session/upload state so a new upload starts clean.
 *  Without this, a stale `cachedSessions` from a prior multi-session upload
 *  would leak into the next upload's autoFillFromStorage refetch and produce
 *  out-of-range session_idx errors. */
function resetSessionState() {
  sessionId = null;
  cachedPlayers = [];
  cachedBoards = [];
  cachedSessions = [];
  currentSessionIdx = 0;
  currentBoard = null;
  currentPlayerName = null;
  currentPlayerData = null;
  causeFilter = null;
  cachedNormalized = null;
  try { sessionStorage.removeItem('bc-game'); } catch (e) {}
}

/** Fetch + JSON wrapper that throws the response body text (not a JSON
 *  parse error) when the request fails. Use anywhere a fetch result is
 *  unconditionally fed into .json(). */
async function getJSON(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ---- Node export ----
//
// Browsers never see this: `module` is undefined there, so the engine simply
// defines its globals as before. Under Node the same file is requireable, which
// is what tests/unit/analysis.test.js loads.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    // constants
    DIRECTIONS, STRAINS, SUITS, SUIT_ORDER_RANK,
    // identity
    normalizeName, playerKey, displayName,
    // matchpoints + field
    calculateMatchpointPct, iterSessionResults, pickSession, derivePlayers, deriveBoards,
    playerDirectionInResult, extractStrain, tricksMade,
    fieldTrickAverages, declarerVsField, fieldContractCounts, fieldContract,
    matchedFieldContract, sameStrainAsField, fieldContractEquivalent,
    declaringDirection, declaringFlags, computeCompetitiveInfo,
    isGameLevel, classifyBoard, boardTypeEquivalent, groupBySideStrain,
    contractMatchesPar, computeBoardContext,
    // cause analysis
    bidRankOf, bidRank, minOutbidLevel, tricksWord, rustRound, levelOf,
    ddTricksLookup, formatAuctionNote, determineCauseAndNotes, buildCauseContext,
    findPlayerSeat, partnerOf, playerRole,
    // shaping
    handToPBN, dealToPBN, renderParDisplayJS, buildDealInfo, buildResultString,
    buildPlayerPBN, jsAnalyzePlayer, jsAnalyzeBoard,
  };
}
