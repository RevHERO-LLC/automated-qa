// Case lines, case blocks and template signatures for registry fragments (qa-test-cases/fragments/zz-surfaces.md).
//
// A case line:  - **FE-SURF-0123** — [S045 /deals/[id]] <case text> _type: frontend_ [_actor: ADMIN / onBehalfOf: ADMIN_]
// A case BLOCK is that line plus any following lines indented with two spaces (sub-bullets). apply_fills.mjs uses the
// same definition, so a block read here is exactly what apply_fills replaces.
//
// The SIGNATURE of a scaffold line identifies which template question produced it, independent of the positional id
// and surface number: id and surface tag stripped, placeholders normalized to <P>, the fill-agent actor marker
// dropped, the _type marker kept (a type change means a different case). Two generations' cases with the same
// surface key and the same signature are the same question about the same surface.

export const ID_LINE = /^- \*\*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+[a-z]?)\*\* — /;
const PLACEHOLDER = /<[^<>\n]{1,240}>/g;

// Which placeholders make a case a FILL target: exactly the 2026-11-07 slicer's rule (make_slices.mjs PH). Template
// boilerplate such as "by-design: <reason>" (about 300 cases) was never sliced or filled, so it is not a fill target
// here either: carrying or residualizing it would change the established process, not reproduce it.
export const FILL_PLACEHOLDER = /<(the|UNKNOWN|a |an |N>|real|exact|value|field|filter|status|product|entity|role|seed|count)[^>]*>/i;
export const needsFill = (text) => FILL_PLACEHOLDER.test(String(text));

/**
 * Split the leading surface tag "[S### <path>]" off a case body. The path can contain brackets of its own
 * (Next.js dynamic segments such as "/(Auth)/invite/[id]"), so the closing bracket is found by depth.
 * An unbalanced tag is treated as no tag at all: the case then has no surface and fails safe to residual.
 */
export function splitTag(rest) {
  const m = /^\[(S\d+) /.exec(rest);
  if (!m) return { tag: null, after: rest };
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        const raw = rest.slice(0, i + 1);
        return { tag: { raw, sid: m[1], path: raw.slice(m[0].length, -1) }, after: rest.slice(i + 1).replace(/^\s+/, '') };
      }
    }
  }
  return { tag: null, after: rest };
}

export function parseCaseLine(line) {
  const m = ID_LINE.exec(line);
  if (!m) return null;
  const rest = line.slice(m[0].length);
  const { tag, after } = splitTag(rest);
  const type = (/_type:\s*([^_]+?)\s*_/.exec(after) || [])[1] || null;
  return { id: m[1], tag, body: after, type };
}

export function signatureOf(caseInfo) {
  let s = caseInfo.body.replace(/_actor:[^_]*_/g, '');
  s = s.replace(PLACEHOLDER, '<P>');
  return s.replace(/\s+/g, ' ').trim();
}

export function signature(line) {
  const c = parseCaseLine(line);
  return c ? signatureOf(c) : null;
}

/** Placeholder tokens left in a line (used to decide whether a line still needs filling). */
export function placeholders(text) {
  return [...String(text).matchAll(PLACEHOLDER)].map((m) => m[0]);
}

/**
 * Read every case block of a fragment.
 * @returns {Map<string, {id, tag, body, type, line, block: string[], index: number}>}
 */
export function readBlocks(text) {
  const lines = String(text).split(/\r?\n/);
  const blocks = new Map();
  for (let i = 0; i < lines.length; i++) {
    const c = parseCaseLine(lines[i]);
    if (!c) continue;
    const block = [lines[i]];
    let j = i + 1;
    while (j < lines.length && /^ {2}\S/.test(lines[j])) { block.push(lines[j]); j++; }
    if (blocks.has(c.id)) throw new Error(`duplicate case id ${c.id} in fragment`);
    blocks.set(c.id, { ...c, line: lines[i], block, index: i });
  }
  return blocks;
}

// The trailing markers of a case line: "_type: x_", optionally followed by "_actor: ..._".
export const MARKERS = /\s(_type: [^_]+_(?:\s+_actor: [^_]+_)?)\s*$/;

/**
 * Re-home a carried fill onto a new case: the new id and the new scaffold's surface tag, with the old fill's body
 * (everything after its own id and tag) unchanged, and the NEW scaffold's trailing markers when given (the plan:
 * keep the new scaffold's _type/_actor; the signature ignores _actor, so it is not implied by a match). Sub-bullet
 * lines of the old block travel with it.
 */
export function rehome(oldText, newId, newTagRaw, newMarkers = null) {
  const lines = String(oldText).split(/\r?\n/);
  const head = parseCaseLine(lines[0]);
  if (!head) throw new Error('carried text does not start with a case line');
  const body = newMarkers && MARKERS.test(head.body) ? head.body.replace(MARKERS, ` ${newMarkers}`) : head.body;
  const first = `- **${newId}** — ${newTagRaw ? newTagRaw + ' ' : ''}${body}`;
  return [first, ...lines.slice(1)].join('\n');
}
