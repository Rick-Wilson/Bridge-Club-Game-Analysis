// Double-dummy tables, off the main thread.
//
// One `Analyzer` lives for the life of the worker. A 20-cell table is roughly
// 190-1200 ms on a fast laptop depending on how hard the deal is (flat notrump
// deals are the slow end), which is far too long to run inline — it would
// freeze the page on every board the user opens.
//
// Protocol: `{ id, dealstr }` in, `{ id, ddtricks }` or `{ id, error }` out.
//
// `ddtricks` is the 20-char string renderDDTable/parseDDTrick expect: seats
// N,S,E,W x strains NT,S,H,D,C, each trick count encoded as `0`-`9` then `a`-`d`
// for 10-13. `dd_table` hands back rows N,E,S,W x columns C,D,H,S,NT, so the
// transpose happens here rather than at the call site — one place to get wrong,
// and it is verified byte-for-byte against the solver service's output.

import init, { Analyzer } from './bridge_solver_wasm.js'

let ready = null
let analyzer = null

function ensureReady() {
  if (!ready) {
    ready = init().then(() => {
      analyzer = new Analyzer()
    })
  }
  return ready
}

const ROW = { N: 0, E: 1, S: 2, W: 3 }
const COL = { C: 0, D: 1, H: 2, S: 3, NT: 4 }
const SEATS = ['N', 'S', 'E', 'W']
const STRAINS = ['NT', 'S', 'H', 'D', 'C']

const encodeTrick = (t) => (t <= 9 ? String(t) : String.fromCharCode(97 + t - 10))

self.onmessage = async (e) => {
  const { id, dealstr } = e.data || {}
  try {
    await ensureReady()
    const { tricks } = JSON.parse(analyzer.dd_table(dealstr))
    let out = ''
    for (const seat of SEATS) {
      for (const strain of STRAINS) out += encodeTrick(tricks[ROW[seat]][COL[strain]])
    }
    self.postMessage({ id, ddtricks: out })
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) })
  }
}
