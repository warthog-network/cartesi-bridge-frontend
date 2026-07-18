import { isFakeMineAllowed, isLoopbackNode } from './nodeAccess.js';

export const isFakeMineNodePath = (nodePath) =>
  /^debug\/fakemine(?:\/|$)/i.test(String(nodePath || '').replace(/^\//, ''));

/** Block loopback targets — the server proxy would hit its own machine, not the user's. */
export const rejectLocalNodeInProxy = (nodeBase) => {
  if (!isLoopbackNode(nodeBase)) return null;

  return {
    status: 400,
    body: JSON.stringify({
      code: 1,
      error:
        'Loopback nodes (localhost / 127.0.0.1) cannot be reached through the server proxy. '
        + 'Use http://127.0.0.1:PORT when running the wallet locally, or use the node\'s public HTTP/HTTPS URL.',
    }),
  };
};

export const rejectFakeMineIfRemote = (nodePath, nodeBase) => {
  if (!isFakeMineNodePath(nodePath)) return null;
  if (isFakeMineAllowed(nodeBase)) return null;

  return {
    status: 403,
    body: JSON.stringify({
      code: 1,
      error: 'Fake mining is disabled for remote nodes. Use a local node (localhost) for dev mining.',
    }),
  };
};