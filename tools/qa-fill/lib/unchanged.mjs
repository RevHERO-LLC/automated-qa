// The two-layer "nothing relevant changed" check (decided in the grill, 2026-11-10). A prior fill is carried onto a
// regenerated case only if BOTH hold:
//   Layer 1  its SURFACE is not in the extractor's touched set for the code diff since the fill. The extractor's own
//            scoped mode (qa-surface-inventory.js --touched) does this with route line ranges: a re-pointed route or an
//            edit inside a route's range marks that surface; a hunk outside every range of a declaring file marks every
//            route of that file; a component-only source marks file-level. Reused read-only, never modified.
//   Layer 2  every file the fill CITED is byte-identical between the prior snapshot and the current one.
// Both layers compare two snapshot FOLDERS (the archived prior generation vs the current export), so nothing depends
// on old git versions surviving in local clones.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { indexInventory } from './surface-key.mjs';

// Hash cache: ONE per carry-forward run, passed in by the caller, never module-level. A module-level cache outlives
// the run that filled it, so a second run in the same process (a test, a wrapper, a re-run after an edit) would
// compare against hashes taken before the files changed and carry fills whose cited code did change: the unsafe
// direction. Found by the 2026-11-10 acceptance run's synthetic edits (158 of 161 targeted carries leaked).
export function fileHash(p, cache = null) {
  if (cache && cache.has(p)) return cache.get(p);
  let h = null;
  try { h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { h = null; }
  if (cache) cache.set(p, h);
  return h;
}

/**
 * Layer 2. @returns {{unchanged: boolean, changed: string[], missing: string[]}}
 * `lineLevel` (router relaxation, option C): for a file listed there, a fill whose cited OLD line ranges no diff hunk
 * overlaps counts as unchanged although the file differs. Missing or out-of-range line numbers stay whole-file.
 */
export function citedFilesUnchanged(files, oldRoot, newRoot, cache = null, lineLevel = null) {
  const changed = [];
  const missing = [];
  for (const f of files) {
    const rel = `${f.repo}/${f.path}`;
    const a = fileHash(path.join(oldRoot, f.repo, f.path), cache);
    const b = fileHash(path.join(newRoot, f.repo, f.path), cache);
    if (a === null) missing.push(`${rel} (absent from the prior snapshot)`);
    else if (b === null) changed.push(`${rel} (deleted)`);
    else if (a !== b && !(lineLevel && lineLevel[rel] && citedLinesUntouched(f.lines, lineLevel[rel]))) changed.push(rel);
  }
  return { unchanged: changed.length === 0 && missing.length === 0 && files.length > 0, changed, missing };
}

// ---------------------------------------------------------------------------------------------------------------
// Router relaxation (option C, Zach 2026-11-10). The extractor marks EVERY route of a declaring file touched when a
// hunk falls outside every route range, and RevHero's BFF router (2,258 lines, 567 registrations) is edited outside
// registrations most weeks (client wiring, comments): 3 days of drift touched all 367 BFF surfaces and carried 20%.
// For a router file, a hunk is dropped from the layer-1 diff only when EVERY changed line is a comment, or a complete
// single-line statement that contains nothing route-shaping. Anything that could add, remove, re-point, re-guard or
// conditionally register a route stays in the diff and gets the extractor's own conservative handling. Accepted risk
// (named in the decision): a pure wiring change, e.g. a client's base URL, that alters a handler's downstream
// behavior is not seen by layer 1.
//
// Security guard (the condition Zach approved: "still re-asks everything if anyone changes the security or permission
// setup in that file"). A line is also kept when it names inbound-security machinery (auth, tokens, revocation, rate
// limits, guards, sessions, roles ...), or when it assigns or reconfigures an object that the router's middleware is
// built from (traced backwards from every middleware/Use statement) or that a route statement references directly.
// So `campaignClient.SetInternalSecret(...)` is kept (the ownership guard is built on campaignClient), while
// `cloudDocumentsClient.SetInternalSecret(...)` (feeds only the upload handler) is the accepted wiring change.
export const ROUTE_SHAPING = [
  /\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any|Handle|HandleFunc|Match|Static|StaticFS|StaticFile|NoRoute|NoMethod)\s*\(/, // registrations
  /\bGroup\s*\(/, // route groups
  /\.Use\s*\(/, // middleware attachment
  /middleware/i, // middleware construction, setters and references
  /Routes?\s*\(/, // setupXRoutes(...) mounts and definitions
  /\b(setup|setDefault)\w*\s*\(/i, // the router's other mount helpers (setupSwagger ...)
  /^\s*func\b|\bfunc\s*\(/, // function signatures and literals
  /\b(if|else|for|range|switch|case|default|select|return|goto|defer|go|break|continue|fallthrough|panic)\b/, // control flow
  /\bgin\./, // engine-level calls and types (gin.New, gin.SetMode, gin.H ...)
  /\b(router|engine)\b/i, // the engine variable itself
];
const MIDDLEWARE = [/middleware/i, /\.Use\s*\(/];
// Word prefixes of inbound security. Deliberately NOT "secret"/"internal"/"webhook": outbound client credentials are
// wiring (see above), and an inbound secret check lives in middleware, which the middleware trace already covers.
const SECURITY_WORDS = ['auth', 'oauth', 'jwt', 'token', 'revoc', 'revok', 'limit', 'throttl', 'perm', 'rbac', 'acl',
  'polic', 'guard', 'owner', 'seat', 'member', 'admin', 'csrf', 'xsrf', 'cors', 'origin', 'session', 'cookie', 'login',
  'logout', 'signin', 'signup', 'password', 'passwd', 'otp', 'mfa', 'totp', 'captcha', 'apikey', 'hmac', 'signature',
  'verif', 'tenant', 'scope', 'credential', 'access', 'allow', 'deny', 'block', 'ban', 'impersonat', 'actas', 'role',
  'partner', 'consent', 'kill', 'suspend', 'trust', 'secur', 'sanitiz', 'crypt'];
const DIRECTIVE = /^\s*\/\/\s*(go:|\+build|nolint|lint:)/;
const CONT_END = /(\(|\[|\{|,|\.|\+|-|\*|\/|%|&|\||\^|<|>|=|!|:)\s*$/;
const HEADER = /^\s*(\}\s*)?(func|if|else|for|switch|select|case|default)\b|^\s*(go|defer)\s+func\b|^\s*\{\s*$/;
const IMPORT_SPEC = /^\s*([A-Za-z_][A-Za-z0-9_]*\s+)?"[^"]*"\s*$/;
const NOT_ROOTS = new Set(['err', '_', 'nil', 'true', 'false', 'var', 'const', 'type']);

/** Words of a code line, camelCase/snake_case split and lowercased (strings included, comments not). */
const words = (code) => (code.match(/[A-Za-z][A-Za-z0-9]*/g) || []).flatMap((id) => [id.toLowerCase(),
  ...id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(' ')]);
export const hasSecurityWord = (code) => words(code).some((w) => SECURITY_WORDS.some((p) => w.startsWith(p)));
const idents = (bare) => new Set((bare.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []).filter((x) => !NOT_ROOTS.has(x)));
const bracketDelta = (bare) => {
  let p = 0; let c = 0;
  for (const ch of bare) {
    if (ch === '(' || ch === '[') p += 1; else if (ch === ')' || ch === ']') p -= 1;
    else if (ch === '{') c += 1; else if (ch === '}') c -= 1;
  }
  return { p, c };
};

/**
 * Go-aware lexing of a WHOLE file version (block comments and raw strings span lines): per line, its code with
 * comments removed (strings kept), the same with string contents blanked (for bracket counting), and string state.
 */
export function lexGo(lines) {
  const out = [];
  let inBlock = false;
  let inRaw = false;
  for (const line of lines) {
    const startsInRaw = inRaw;
    let code = ''; let bare = ''; let inStr = null;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]; const nx = line[i + 1];
      if (inBlock) { if (ch === '*' && nx === '/') { inBlock = false; i += 1; code += ' '; bare += ' '; } continue; }
      if (inRaw) { code += ch; if (ch === '`') { inRaw = false; bare += ch; } else bare += ' '; continue; }
      if (inStr) {
        code += ch;
        if (ch === '\\' && i + 1 < line.length) { code += nx; bare += '  '; i += 1; continue; }
        if (ch === inStr) { inStr = null; bare += ch; } else bare += ' ';
        continue;
      }
      if (ch === '/' && nx === '/') break;
      if (ch === '/' && nx === '*') { inBlock = true; i += 1; code += ' '; bare += ' '; continue; }
      if (ch === '`') inRaw = true; else if (ch === '"' || ch === "'") inStr = ch;
      code += ch; bare += ch;
    }
    out.push({ code: code.trimEnd(), bare: bare.trimEnd(), startsInRaw, endsInRaw: inRaw, unterminated: inStr !== null });
  }
  return out;
}

/** Statements of a lexed Go file: {start, end, bare, header, importDecl}. A block header ends at its `{`. */
function splitStatements(lex) {
  const stmts = [];
  let cur = null; let p = 0; let c = 0;
  for (let i = 0; i < lex.length; i += 1) {
    const L = lex[i];
    if (!cur && !L.code.trim() && !L.startsInRaw) continue; // comment or blank between statements
    if (!cur) {
      cur = { start: i, end: i, bare: '', header: HEADER.test(L.code), importDecl: /^\s*import\b/.test(L.code) };
      p = 0; c = 0;
    }
    cur.end = i;
    cur.bare += ` ${L.bare}`;
    const d = bracketDelta(L.bare);
    p += d.p; c += d.c;
    const opensBlock = cur.header && /\{\s*$/.test(L.bare) && p <= 0;
    const ends = p <= 0 && c <= 0 && !CONT_END.test(L.bare) && !L.endsInRaw;
    if (opensBlock || ends) { stmts.push(cur); cur = null; }
  }
  if (cur) stmts.push(cur);
  return stmts;
}

/** Identifiers inside the argument lists of calls whose callee mentions middleware, and of `.Use(...)` calls. */
export function middlewareArgIdents(bare) {
  const out = new Set();
  const call = /([A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*\(/g;
  for (let m = call.exec(bare); m; m = call.exec(bare)) {
    const callee = m[1];
    if (!/middleware/i.test(callee) && !/(^|\.)\s*Use$/.test(callee)) continue;
    let depth = 0;
    let j = m.index + m[0].length - 1;
    const from = j + 1;
    for (; j < bare.length; j += 1) {
      if (bare[j] === '(' || bare[j] === '[' || bare[j] === '{') depth += 1;
      else if (bare[j] === ')' || bare[j] === ']' || bare[j] === '}') { depth -= 1; if (depth === 0) break; }
    }
    for (const id of idents(bare.slice(from, j))) out.add(id);
  }
  return out;
}

/** Root identifiers a statement assigns or reconfigures: LHS names, or the receiver of an expression statement. */
export function statementRoots(bare) {
  const s = bare.trim().replace(/^(var|const)\s+/, '');
  const asg = /^(.*?[^=!<>:])(:=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<=|>>=|=)(?!=)/.exec(s);
  const lhs = asg ? asg[1] : s;
  const parts = asg ? lhs.split(',') : [lhs];
  const roots = parts.map((x) => (/[A-Za-z_][A-Za-z0-9_]*/.exec(x.replace(/^[\s*&(]+/, '')) || [])[0]).filter(Boolean);
  return roots.filter((r) => !NOT_ROOTS.has(r));
}

/** Per-file-version analysis behind lineIsInert: lexing, statements, route/middleware spans, and the guard sets. */
export function analyzeRouterSource(lines) {
  const lex = lexGo(lines);
  const stmts = splitStatements(lex);
  const lineStmt = new Int32Array(lines.length).fill(-1);
  stmts.forEach((st, k) => { for (let i = st.start; i <= st.end; i += 1) lineStmt[i] = k; });
  // Lines inside a conditional or loop block (at any depth). A diff that moves a line across a block boundary shows
  // up as a removed and an added copy that each look harmless alone, so nothing inside such a block is inert.
  const inControl = new Uint8Array(lines.length);
  const stack = [];
  for (const st of stmts) {
    if (/^\s*\}/.test(st.bare)) stack.pop();
    if (stack.includes('control')) for (let i = st.start; i <= st.end; i += 1) inControl[i] = 1;
    if (st.header && /\{\s*$/.test(st.bare)) {
      stack.push(/^\s*\{\s*$/.test(st.bare) || /^\s*func\b|^\s*(go|defer)\s+func\b/.test(st.bare) ? 'plain' : 'control');
    }
  }
  const isSeed = (st) => !st.header && !st.importDecl && ROUTE_SHAPING.slice(0, 6).concat(ROUTE_SHAPING.slice(8)).some((re) => re.test(st.bare));
  const inSeed = new Uint8Array(lines.length);
  const sRoute = new Set();
  const sSec = new Set();
  for (const st of stmts) {
    if (isSeed(st)) {
      for (let i = st.start; i <= st.end; i += 1) inSeed[i] = 1;
      for (const id of idents(st.bare)) sRoute.add(id);
    }
    // Seed with what middleware is BUILT FROM: the arguments of middleware calls and of .Use(...). Not the whole
    // statement: a registration that attaches middleware inline also names its handler, which is not security setup.
    if (!st.header && !st.importDecl && MIDDLEWARE.some((re) => re.test(st.bare))) for (const id of middlewareArgIdents(st.bare)) sSec.add(id);
  }
  // Backwards to a fixpoint: whatever a security-fed object is assigned from or reconfigured with is security-fed.
  for (let grew = true; grew;) {
    grew = false;
    for (const st of stmts) {
      if (st.header || st.importDecl) continue;
      if (!statementRoots(st.bare).some((r) => sSec.has(r))) continue;
      for (const id of idents(st.bare)) if (!sSec.has(id)) { sSec.add(id); grew = true; }
    }
  }
  return { lex, stmts, lineStmt, inSeed, inControl, sRoute, sSec };
}

/** Is one changed line (1-based `n` in `lines`, the file version it belongs to; `A` = analyzeRouterSource(lines)) inert? */
export function lineIsInert(n, lines, A) {
  const i = n - 1;
  const L = A.lex[i];
  if (!L || DIRECTIVE.test(lines[i] || '') || L.startsInRaw) return false;
  if (!L.code.trim()) return true; // comment or blank
  const st = A.stmts[A.lineStmt[i]];
  if (!st) return false;
  if (st.importDecl) return st.start !== i && IMPORT_SPEC.test(L.code) && !/^\s*[_.]\s/.test(L.code); // named import spec
  if (A.inSeed[i] || A.inControl[i] || st.header || st.start !== i || st.end !== i) return false; // route statement, conditional, or multi-line
  const d = bracketDelta(L.bare);
  if (d.p !== 0 || d.c !== 0 || L.unterminated || L.endsInRaw) return false; // a lone brace moves block structure
  if (ROUTE_SHAPING.some((re) => re.test(L.code)) || hasSecurityWord(L.code)) return false;
  return !statementRoots(L.bare).some((r) => A.sRoute.has(r) || A.sSec.has(r));
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Split a unified diff (as snapshotDiff emits it) into sections; drop inert hunks of the router files.
 * @returns {{diffText: string, info: Object<string, {hunks:number, dropped:number, kept:number, ranges:number[][], oldLineCount:number}>}}
 */
export function relaxRouterDiff(diffText, routerRels, oldRoot, newRoot) {
  const info = {};
  if (!routerRels || !routerRels.length) return { diffText, info };
  const routers = new Set(routerRels);
  const lines = diffText.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^diff --git a\/(\S+) b\//.exec(lines[i]);
    if (!m || !routers.has(m[1])) { out.push(lines[i]); i += 1; continue; }
    const rel = m[1];
    const header = [lines[i]];
    i += 1;
    while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git ')) { header.push(lines[i]); i += 1; }
    const read = (root) => { const p = path.join(root, rel); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/\r/g, '').split('\n') : null; };
    const oldLines = read(oldRoot);
    const newLines = read(newRoot);
    const hunks = [];
    while (i < lines.length && lines[i].startsWith('@@')) {
      const h = { head: lines[i], body: [] };
      i += 1;
      while (i < lines.length && /^[-+\\]/.test(lines[i]) && !lines[i].startsWith('diff --git ')) { h.body.push(lines[i]); i += 1; }
      hunks.push(h);
    }
    // Sanity: every hunk parses and its -/+ lines are exactly the files' lines at those positions. Anything else
    // (an unreadable side, CRLF or encoding drift, a header we misread) keeps every hunk and disables line-level carry.
    let reliable = !!(oldLines && newLines);
    const pos = [];
    for (const h of hunks) {
      const hm = HUNK.exec(h.head);
      if (!hm) { reliable = false; pos.push(null); continue; }
      const p = { oldStart: Number(hm[1]), oldCount: hm[2] === undefined ? 1 : Number(hm[2]), newStart: Number(hm[3]), newCount: hm[4] === undefined ? 1 : Number(hm[4]) };
      const minus = h.body.filter((l) => l.startsWith('-')).map((l) => l.slice(1));
      const plus = h.body.filter((l) => l.startsWith('+')).map((l) => l.slice(1));
      if (minus.length !== p.oldCount || plus.length !== p.newCount) reliable = false;
      else if (reliable && (minus.some((l, k) => oldLines[p.oldStart - 1 + k] !== l) || plus.some((l, k) => newLines[p.newStart - 1 + k] !== l))) reliable = false;
      pos.push(p);
    }
    const keep = [];
    const dropped = [];
    if (!reliable) keep.push(...hunks);
    else {
      const A = analyzeRouterSource(oldLines);
      const B = analyzeRouterSource(newLines);
      hunks.forEach((h, k) => {
        const p = pos[k];
        let inert = true;
        for (let j = 0; j < p.oldCount && inert; j += 1) inert = lineIsInert(p.oldStart + j, oldLines, A);
        for (let j = 0; j < p.newCount && inert; j += 1) inert = lineIsInert(p.newStart + j, newLines, B);
        (inert ? dropped : keep).push(h);
      });
    }
    info[rel] = {
      reliable,
      hunks: hunks.length,
      dropped: dropped.length,
      kept: keep.length,
      droppedHunks: dropped.map((h) => h.head),
      keptHunks: keep.map((h) => `${h.head} ${(h.body.find((l) => /^[-+]\s*\S/.test(l)) || '').trim().slice(0, 100)}`),
      pos: reliable ? pos : [],
      oldLineCount: oldLines ? oldLines.length : 0,
      oldLines: reliable ? oldLines : null,
      newLines: reliable ? newLines : null,
    };
    if (keep.length || !hunks.length) {
      out.push(...header);
      for (const h of keep) out.push(h.head, ...h.body);
    }
  }
  return { diffText: out.join('\n'), info };
}

/** "858" / "858-870" / "46-60,75-131" (en dash accepted) -> [[a, b], ...]; null when anything does not parse. */
export function parseLineSpec(spec) {
  const parts = String(spec || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out = [];
  for (const p of parts) {
    const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(p);
    if (!m) return null;
    const a = Number(m[1]); const b = Number(m[2] || m[1]);
    if (a < 1 || b < a) return null;
    out.push([a, b]);
  }
  return out;
}

// Old-side span of a hunk. A pure insertion (-s,0) sits between old lines s and s+1, so it overlaps [a, b] iff a <= s < b.
const overlaps = (p, a, b) => (p.oldCount === 0 ? a <= p.oldStart && p.oldStart < b : p.oldStart <= b && p.oldStart + p.oldCount - 1 >= a);
const endPos = (p) => (p.oldCount === 0 ? p.oldStart : p.oldStart + p.oldCount - 1);

/**
 * Line-level layer 2 for a router citation (cited lines refer to the PRIOR snapshot). Unchanged iff the diff was read
 * reliably, every range parses and lies inside the old file, no hunk (dropped or kept) overlaps it, and the cited text
 * is byte-identical at its new position. Returns the remapped spec for the CURRENT file, so a carried citation stays
 * true for the next generation, or null (= changed).
 */
export function remapCitedLines(spec, routerInfo) {
  if (!routerInfo || !routerInfo.reliable) return null;
  const ranges = parseLineSpec(spec);
  if (!ranges) return null;
  const out = [];
  for (const [a, b] of ranges) {
    if (b > routerInfo.oldLineCount) return null;
    if (routerInfo.pos.some((p) => overlaps(p, a, b))) return null;
    const shift = routerInfo.pos.filter((p) => endPos(p) < a).reduce((s, p) => s + p.newCount - p.oldCount, 0);
    for (let n = a; n <= b; n += 1) if (routerInfo.oldLines[n - 1] !== routerInfo.newLines[n - 1 + shift]) return null;
    out.push(a === b ? `${a + shift}` : `${a + shift}-${b + shift}`);
  }
  return out.join(',');
}

export const citedLinesUntouched = (spec, routerInfo) => remapCitedLines(spec, routerInfo) !== null;

const toPosix = (p) => path.resolve(p).replace(/\\/g, '/');

function commonAncestor(a, b) {
  const pa = toPosix(a).split('/');
  const pb = toPosix(b).split('/');
  const out = [];
  for (let i = 0; i < Math.min(pa.length, pb.length) && pa[i].toLowerCase() === pb[i].toLowerCase(); i++) out.push(pa[i]);
  if (!out.length || (out.length === 1 && out[0] === '')) return out.length ? '/' : null;   // POSIX root, or different drives
  return out.join('/');
}

// A bare Windows drive ("C:") as a cwd means "the current directory on C:", not the drive root.
const asCwd = (dir) => (/^[A-Za-z]:$/.test(dir) ? `${dir}/` : dir);

function listFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r); else out.push(r);
    }
  };
  walk(root, '');
  return out;
}

/**
 * Unified diff (zero context) of every repo between two snapshot roots, with paths normalized to "<repo>/<path>":
 * the extractor's --touched boundary match keys on exactly that suffix of its source paths. A repo present on only
 * one side is emitted as flat paths (whole-file touched), the conservative reading.
 */
export function snapshotDiff(oldRoot, newRoot, repos) {
  const anc = commonAncestor(oldRoot, newRoot);
  if (!anc) throw new Error(`snapshots have no common ancestor directory: ${oldRoot} vs ${newRoot}`);
  const strip = (p) => toPosix(p).slice(anc === '/' ? 1 : anc.length + 1);
  const relA = strip(oldRoot);
  const relB = strip(newRoot);
  let out = '';
  for (const repo of repos) {
    const inA = fs.existsSync(path.join(oldRoot, repo));
    const inB = fs.existsSync(path.join(newRoot, repo));
    if (!inA && !inB) continue;
    if (!inA || !inB) {
      for (const f of listFiles(path.join(inB ? newRoot : oldRoot, repo))) out += `${repo}/${f}\n`;
      continue;
    }
    const a = `${relA}/${repo}`;
    const b = `${relB}/${repo}`;
    const r = spawnSync('git', ['diff', '--no-index', '--no-renames', '--no-color', '--no-ext-diff', '-U0', '--', a, b],
      { cwd: asCwd(anc), encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    if (r.error) throw r.error;
    if (r.status !== 0 && r.status !== 1) throw new Error(`git diff --no-index failed for ${repo}: ${r.stderr}`);
    const fixA = `a/${a}/`;
    const fixB = `b/${b}/`;
    const lines = r.stdout.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) {
      out += (/^(diff --git |--- |\+\+\+ |Binary files )/.test(line)
        ? line.split(fixA).join(`a/${repo}/`).split(fixB).join(`b/${repo}/`)
        : line) + '\n';
    }
  }
  return out;
}

/**
 * Layer 1. Run the extractor in its scoped mode against the CURRENT snapshot (via `contract`) with the old->new diff,
 * entirely into scratch outputs, and return the touched surfaces as cross-generation keys.
 * Fails SAFE: if the extractor did not resolve a touched set, or its inventory does not match the expected surface
 * count (an unparseable router exits 0 with an empty floor by design), every surface is treated as touched.
 * @returns {{all: boolean, keys: Set<string>, mode: string|null, reason: string|null}}
 */
export function touchedSurfaceKeys({ extractor, contract, diffText, scratchDir, expectedSurfaceCount = null, node = process.execPath }) {
  fs.mkdirSync(scratchDir, { recursive: true });
  const diffFile = path.join(scratchDir, 'touched.diff');
  const inv = path.join(scratchDir, 'touched-inventory.json');
  const frag = path.join(scratchDir, 'touched-fragment.md');
  fs.writeFileSync(diffFile, diffText);
  const r = spawnSync(node, [extractor, '--contract', contract, '--inventory', inv, '--fragment', frag, '--touched', diffFile],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const fail = (reason) => ({ all: true, keys: new Set(), mode: null, reason });
  if (r.error || r.status !== 0) return fail(`extractor exited ${r.status}: ${(r.stderr || '').slice(0, 300)}`);
  let j;
  try { j = JSON.parse(fs.readFileSync(inv, 'utf8')); } catch (e) { return fail(`no touched inventory: ${e.message}`); }
  if (!j.touchedResolution || !Array.isArray(j.touchedResolution.surfaceIds)) return fail('extractor did not resolve a touched set');
  if (!Array.isArray(j.surfaces) || j.surfaces.length === 0) return fail('touched-run inventory has no surfaces');
  if (expectedSurfaceCount !== null && j.surfaces.length !== expectedSurfaceCount) {
    return fail(`touched-run inventory has ${j.surfaces.length} surfaces, expected ${expectedSurfaceCount}`);
  }
  const idx = indexInventory(j);
  const keys = new Set(j.touchedResolution.surfaceIds.map((id) => idx.bySid.get(id)).filter(Boolean));
  return { all: false, keys, mode: j.touchedResolution.mode || null, reason: null };
}
