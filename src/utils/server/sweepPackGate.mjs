/**
 * Whether a rotate sweep may open.
 *
 * Both incoming seats need a sealed next-pack held by `t` (at least 2)
 * seat-eligible signers who are not the dealers. Pieces held by the dealers,
 * the VPS, a denylisted id, or a wrong-network tab do not count: those peers
 * cannot claim the seat the pack is for. Fewer than 2 eligible signers is a
 * wait, not a failed rotation — the live Q has not been announced or swept.
 */
export const SWEEP_PACK_T = 2;

export function sweepPackDecision({ nextPacks, eligibleIds, asset = 'pool' } = {}) {
  const eligible = [];
  const seen = new Set();
  for (const id of eligibleIds || []) {
    const s = String(id || '');
    if (!s || seen.has(s)) continue;
    seen.add(s);
    eligible.push(s);
  }
  const missing = [];
  const seats = {};
  for (const role of ['1', '2']) {
    const p = nextPacks?.[role] || null;
    const t = Math.max(SWEEP_PACK_T, Number(p?.t) || SWEEP_PACK_T);
    const holders = new Set((p?.holders || []).map(String));
    const covered = eligible.filter((id) => holders.has(id));
    const ok = !!(p && p.next === true && covered.length >= t);
    seats[role] = {
      ok,
      covered: covered.length,
      t,
      sealed: !!(p && p.next === true),
    };
    if (!ok) missing.push(role);
  }
  if (!missing.length) {
    return { ok: true, missing, eligible: eligible.length, seats, reason: null };
  }
  const noun = asset === 'eth' ? 'e' : 'd';
  const tail = 'deposits and withdrawals stay on the live Q';
  const reason =
    eligible.length < SWEEP_PACK_T
      ? `sweep wait: next packs need ${SWEEP_PACK_T} seat-eligible signers besides the dealers, have ${eligible.length} — ${tail}`
      : `sweep wait: next packs not sealed for ${noun}${missing.join('+' + noun)} (${eligible.length} eligible) — ${tail}`;
  return { ok: false, missing, eligible: eligible.length, seats, reason };
}
