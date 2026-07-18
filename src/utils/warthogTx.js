/** Serialize a warthog-js transaction for the node API (bigints → numbers). */
export function serializeTransaction(tx) {
  const serialized = { ...tx };
  for (const key of Object.keys(serialized)) {
    if (typeof serialized[key] === 'bigint') {
      serialized[key] = Number(serialized[key]);
    }
  }

  return serialized;
}