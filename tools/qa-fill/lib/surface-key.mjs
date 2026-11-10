// Stable surface identity across inventory regenerations.
//
// Surface ids (S001...) and case ids (FE-SURF-001...) are POSITIONAL in qa-surface-inventory.js: every full
// regeneration renumbers them. What stays stable for an unchanged surface is its path, its verbs and its kinds.
// Measured on the 2026-11-07 inventory: 569 surfaces, 569 distinct keys. A key that is not unique within a
// generation is treated as ambiguous and never carried.

import { signatureOf } from './signature.mjs';

export function surfaceKey(s) {
  const verbs = [...(s.verbs || [])].sort().join('+');
  const kinds = [...(s.kinds || [])].sort().join('+');
  return `${s.path} | ${verbs} | ${kinds}`;
}

export function indexInventory(inventory) {
  const bySid = new Map();
  const byKey = new Map();
  const dupKeys = new Set();
  for (const s of inventory.surfaces || []) {
    const k = surfaceKey(s);
    bySid.set(s.id, k);
    if (byKey.has(k)) dupKeys.add(k);
    byKey.set(k, s);
  }
  return { bySid, byKey, dupKeys };
}

// The write-consistency cases the extractor emits once per declared entity. They carry no surface tag and ask the
// tester to enumerate EVERY path that writes the entity, so no set of cited files can vouch that nothing relevant
// changed: a new write path can appear anywhere. They are always residual.
export const PER_ENTITY = /Enumerate EVERY path that writes/;

export function isPerEntity(caseInfo) {
  return !caseInfo.tag && PER_ENTITY.test(caseInfo.body);
}

/**
 * The cross-generation key of a scaffold case, or a reason it has none.
 * @returns {{key: string|null, surfaceKey: string|null, reason: string|null}}
 */
export function caseKey(caseInfo, inventoryIndex) {
  if (!caseInfo.tag) {
    return { key: null, surfaceKey: null, reason: isPerEntity(caseInfo) ? 'per-entity' : 'untagged' };
  }
  const sk = inventoryIndex.bySid.get(caseInfo.tag.sid);
  if (!sk) return { key: null, surfaceKey: null, reason: 'surface-not-in-inventory' };
  if (inventoryIndex.dupKeys.has(sk)) return { key: null, surfaceKey: sk, reason: 'ambiguous-surface' };
  return { key: `${sk} || ${signatureOf(caseInfo)}`, surfaceKey: sk, reason: null };
}
