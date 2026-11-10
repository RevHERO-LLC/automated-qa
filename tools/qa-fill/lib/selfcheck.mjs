// Interface self-check (gap audit P3). The carry-forward depends on the shared extractor's CLI, its inventory shape and
// the fragment line format -- tooling another session may change. If any expected piece is missing the tool must
// refuse LOUDLY and send everything to residual, never mis-key silently.

import fs from 'node:fs';
import { parseCaseLine } from './signature.mjs';

const REQUIRED_EXTRACTOR_MARKERS = ["'--contract'", "'--inventory'", "'--fragment'", "'--touched'", 'touchedResolution', 'surfaceIds'];

export function checkExtractorSource(extractorPath) {
  const problems = [];
  let src = '';
  try { src = fs.readFileSync(extractorPath, 'utf8'); } catch (e) { return { ok: false, problems: [`extractor not readable: ${extractorPath} (${e.message})`] }; }
  for (const m of REQUIRED_EXTRACTOR_MARKERS) if (!src.includes(m)) problems.push(`extractor no longer contains ${m}`);
  return { ok: problems.length === 0, problems };
}

export function checkInventory(inv) {
  const problems = [];
  if (!inv || !Array.isArray(inv.surfaces) || inv.surfaces.length === 0) return { ok: false, problems: ['inventory has no surfaces[]'] };
  const ids = new Set();
  inv.surfaces.forEach((s, i) => {
    if (!/^S\d+$/.test(String(s.id))) problems.push(`surface ${i} has no S### id`);
    if (typeof s.path !== 'string') problems.push(`surface ${s.id} has no path`);
    // Contract egress surfaces (kindSource "contract") legitimately carry no verbs.
    if (s.verbs !== undefined && !Array.isArray(s.verbs)) problems.push(`surface ${s.id} has a non-array verbs`);
    if (!Array.isArray(s.kinds)) problems.push(`surface ${s.id} has no kinds[]`);
    if (!Array.isArray(s.sources)) problems.push(`surface ${s.id} has no sources[]`);
    if (ids.has(s.id)) problems.push(`duplicate surface id ${s.id}`);
    ids.add(s.id);
  });
  return { ok: problems.length === 0, problems: problems.slice(0, 20) };
}

export function checkFragment(text, prefix = 'FE-SURF') {
  const problems = [];
  const ids = new Set();
  let cases = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith(`- **${prefix}-`)) continue;
    const c = parseCaseLine(line);
    if (!c) { problems.push(`unparseable case line: ${line.slice(0, 80)}`); continue; }
    cases++;
    if (ids.has(c.id)) problems.push(`duplicate case id ${c.id}`);
    ids.add(c.id);
    if (/^\[S\d+ /.test(c.body)) problems.push(`unbalanced surface tag on ${c.id}`);
    if (!c.type) problems.push(`no _type marker on ${c.id}`);
  }
  if (cases === 0) problems.push(`no ${prefix} case lines`);
  return { ok: problems.length === 0, problems: problems.slice(0, 20), cases };
}
