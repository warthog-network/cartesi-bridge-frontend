import { createWarthogApi } from './warthogClient.js';
import { buildFailoverCandidates, resolveSavedNodeUrl } from './presetNodes.js';

/**
 * Lightweight health probe — node must return a successful chain head.
 * @returns {{ ok: true, api: unknown } | { ok: false, error: string }}
 */
export async function probeNode(nodeUrl) {
  const node = resolveSavedNodeUrl(nodeUrl);
  try {
    const api = await createWarthogApi(node);
    const head = await api.getChainHead();
    if (!head.success) {
      return { ok: false, error: head.error || 'Chain head failed' };
    }
    if (head.data == null) {
      return { ok: false, error: 'Empty chain head response' };
    }
    return { ok: true, api, node, head: head.data };
  } catch (err) {
    return { ok: false, error: err?.message || 'Node unreachable' };
  }
}

/**
 * Try the preferred node first; on dead/bad responses walk the failover list
 * until one answers successfully.
 *
 * @param {string} preferred
 * @param {{ candidates?: string[] }} [options]
 * @returns {Promise<{
 *   node: string,
 *   api: unknown,
 *   head: unknown,
 *   switched: boolean,
 *   fromNode: string | null,
 *   attempts: Array<{ node: string, error?: string }>,
 * }>}
 */
export async function resolveLiveNode(preferred, options = {}) {
  const preferredNorm = resolveSavedNodeUrl(preferred);
  const candidates = options.candidates || buildFailoverCandidates(preferredNorm);
  const attempts = [];

  for (const candidate of candidates) {
    const result = await probeNode(candidate);
    if (result.ok) {
      const switched = candidate !== preferredNorm;
      return {
        node: candidate,
        api: result.api,
        head: result.head,
        switched,
        fromNode: switched ? preferredNorm : null,
        attempts,
      };
    }
    attempts.push({ node: candidate, error: result.error });
  }

  const detail = attempts
    .map((a) => `${a.node}: ${a.error || 'failed'}`)
    .join('; ');
  throw new Error(
    attempts.length
      ? `No reachable node. Tried ${attempts.length}: ${detail}`
      : 'No node candidates to try',
  );
}

/** Persist a failover choice so the next visit starts on a live node. */
export function persistSelectedNode(nodeUrl) {
  const normalized = resolveSavedNodeUrl(nodeUrl);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('selectedNode', normalized);
    }
  } catch {
    // ignore storage errors
  }
  return normalized;
}
