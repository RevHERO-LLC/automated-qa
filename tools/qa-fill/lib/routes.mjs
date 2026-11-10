// Resolve Gin route registrations to their full paths, for ADDRESSING HINTS only (never written into case text).
//
// The extractor records a BFF route Gin-relative, qualified by its defining file ("routes:/:id"), so every
// registration of the same relative path across groups collapses into one surface (qa-surface-inventory.js:291-301).
// Agents then had to recover the full path from a stale hand-written table. This parser recovers it from the router
// source itself:
//   - `x := y.Group("/p", mw...)` gives x the prefix of y plus /p (per function scope);
//   - `*gin.Engine` parameters have the empty prefix;
//   - `*gin.RouterGroup` parameters get their prefixes from call sites: `setupX(v1Group.Group("/auth"), h)` or `setupX(g, h)`;
//   - `x.GET("/rel", h)` (GET/POST/PUT/PATCH/DELETE/OPTIONS/HEAD/Any) registers prefix(x) + /rel.
// Prefix sets propagate through call chains to a fixpoint. Anything unresolvable yields "?" in the path, and
// several candidates stay several candidates: a hint never pretends to be more certain than the source.

const VERBS = 'GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Any';

export function joinPath(prefix, rel) {
  const joined = `${prefix}/${rel}`.replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

function splitFunctions(text) {
  const lines = text.split(/\r?\n/);
  const funcs = [];
  let cur = { name: '<file>', params: '', body: [] };
  for (const line of lines) {
    const m = /^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(([^)]*)\)/.exec(line);
    if (m) {
      funcs.push(cur);
      cur = { name: m[1], params: m[2], body: [] };
      continue;
    }
    cur.body.push(line);
  }
  funcs.push(cur);
  return funcs.filter((f) => f.body.length);
}

function groupParams(params) {
  const out = { group: [], engine: [] };
  for (const m of params.matchAll(/(\w+)\s+\*gin\.(RouterGroup|Engine)/g)) {
    (m[2] === 'Engine' ? out.engine : out.group).push(m[1]);
  }
  return out;
}

/**
 * @param {string} text  Go source of a router file
 * @returns {{routes: {verb:string, rel:string, full:string[]}[]}}
 */
export function parseGinRoutes(text) {
  const funcs = splitFunctions(String(text));
  const byName = new Map(funcs.map((f) => [f.name, f]));
  // prefixes: function name -> Map(var -> Set(prefix))
  const scopes = new Map();
  const scope = (fn) => { if (!scopes.has(fn)) scopes.set(fn, new Map()); return scopes.get(fn); };
  const add = (fn, v, p) => {
    const s = scope(fn);
    if (!s.has(v)) s.set(v, new Set());
    const before = s.get(v).size;
    s.get(v).add(p);
    return s.get(v).size !== before;
  };
  for (const f of funcs) {
    const gp = groupParams(f.params);
    for (const e of gp.engine) add(f.name, e, '');
  }
  // Fixpoint over group assignments and call-site propagation.
  for (let pass = 0; pass < 50; pass++) {
    let changed = false;
    for (const f of funcs) {
      const s = scope(f.name);
      const body = f.body.join('\n');
      for (const m of body.matchAll(/(\w+)\s*:?=\s*(\w+)\.Group\(\s*"([^"]*)"/g)) {
        for (const p of s.get(m[2]) || []) if (add(f.name, m[1], joinPath(p, m[3]))) changed = true;
      }
      // Calls whose first argument is a group: fn(g, ...) or fn(g.Group("/p", ...), ...)
      for (const m of body.matchAll(/\b(\w+)\(\s*(\w+)(?:\.Group\(\s*"([^"]*)"[^)]*\))?\s*[,)]/g)) {
        const callee = byName.get(m[1]);
        if (!callee || callee === f) continue;
        const target = groupParams(callee.params).group[0];
        if (!target) continue;
        for (const p of s.get(m[2]) || []) {
          const pref = m[3] !== undefined ? joinPath(p, m[3]) : p;
          if (add(callee.name, target, pref)) changed = true;
        }
      }
    }
    if (!changed) break;
  }
  const routes = [];
  for (const f of funcs) {
    const s = scope(f.name);
    const body = f.body.join('\n');
    const re = new RegExp(`\\b(\\w+)\\.(${VERBS})\\(\\s*"([^"]*)"`, 'g');
    for (const m of body.matchAll(re)) {
      const prefs = s.get(m[1]);
      const full = prefs && prefs.size ? [...prefs].map((p) => joinPath(p, m[3])) : [joinPath('?', m[3])];
      routes.push({ verb: m[2].toUpperCase(), rel: m[3], full: [...new Set(full)].sort() });
    }
  }
  return { routes };
}

/**
 * Addressing hint for an extractor surface such as {path: "routes:/:id", verbs: ["GET","PUT"]}.
 * @returns {{resolved: string|null, candidates: string[]}}
 */
export function hintFor(surface, parsed) {
  const m = /^[^:/]+:(\/.*)$/.exec(surface.path || '');
  if (!m) return { resolved: null, candidates: [] };
  const rel = m[1];
  const verbs = new Set((surface.verbs || []).map((v) => v.toUpperCase()));
  const cands = new Set();
  for (const r of parsed.routes) {
    if (joinPath('', r.rel) !== joinPath('', rel)) continue;
    if (verbs.size && !verbs.has(r.verb) && r.verb !== 'ANY') continue;
    for (const f of r.full) cands.add(`${r.verb} ${f}`);
  }
  const candidates = [...cands].sort();
  return { resolved: candidates.length === 1 ? candidates[0] : null, candidates };
}
