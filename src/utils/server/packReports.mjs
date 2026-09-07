/**
 * What each seat holder last said about packing its share for orbit recovery.
 *
 * packSeat() in the browser used to return null for every reason it declined
 * — too few sealable targets, no key for a target, nothing to pack — so a seat
 * could sit unrecoverable for a whole rotation with the coordinator reporting
 * "no pack" and nobody knowing why. Holders now post pool3p_pack_report /
 * eth3p_pack_report; the latest per pool/role/signer is kept in RAM, journaled
 * on change, and surfaced next to the pack state in status.
 */
const KEEP_MS = 15 * 60 * 1000;
const LOG_MS = 60 * 1000;
const reports = new Map(); // `${pool}:${role}:${signerId}` -> record
const logged = new Map(); // `${pool}:${role}:${signerId}:${packed}:${reason}` -> at

function prune(now) {
  for (const [k, r] of reports) if (now - r.at > KEEP_MS) reports.delete(k);
  for (const [k, at] of logged) if (now - at > LOG_MS * 10) logged.delete(k);
}

export function notePackReport(pool, { signerId, role, packed, reason, targets, need, live, client } = {}) {
  const sid = String(signerId || '').trim();
  const r = Number(role);
  if (sid.length < 16) throw new Error('signerId required');
  if (r !== 1 && r !== 2) throw new Error('role must be 1 or 2');
  const now = Date.now();
  prune(now);
  const rec = {
    at: now,
    signerId: sid,
    role: r,
    packed: !!packed,
    reason: packed ? null : String(reason || 'declined (no reason given)').slice(0, 200),
    targets: (Array.isArray(targets) ? targets : []).map(String).slice(0, 8),
    need: need == null ? null : Number(need),
    live: live == null ? null : Number(live),
    client: client ? String(client).slice(0, 24) : null,
  };
  reports.set(`${pool}:${r}:${sid}`, rec);
  const lk = `${pool}:${r}:${sid}:${rec.packed}:${rec.reason}`;
  if (now - (logged.get(lk) || 0) >= LOG_MS) {
    logged.set(lk, now);
    const seat = pool === 'eth' ? `e${r}` : `d${r}`;
    if (rec.packed) {
      console.warn(`[${pool}3p] pack ok seat=${seat} signer=${sid.slice(0, 20)} -> ${rec.targets.map((t) => t.slice(0, 13)).join(',')}`);
    } else {
      console.warn(`[${pool}3p] pack declined seat=${seat} signer=${sid.slice(0, 20)} (${rec.client || '?'}): ${rec.reason}`);
    }
  }
  return { ok: true, noted: true, role: r, packed: rec.packed };
}

/** Latest report for a seat — from `signerId` if given, else the newest for the role. */
export function latestPackReport(pool, role, signerId = null) {
  prune(Date.now());
  const r = Number(role);
  if (signerId) return reports.get(`${pool}:${r}:${signerId}`) || null;
  let best = null;
  for (const rec of reports.values()) {
    if (rec.role !== r) continue;
    if (!best || rec.at > best.at) best = rec;
  }
  return best;
}
