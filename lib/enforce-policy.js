'use strict';
/**
 * lib/enforce-policy.js — compiles lib/route-policy.js once at boot and
 * enforces it on every `/api` request.
 *
 * DEFAULT DENY. A request under `/api` that matches no policy entry is
 * answered 403 POLICY_MISSING. That is the whole point: a new endpoint is
 * closed until somebody writes it into the policy table, rather than open
 * until somebody remembers to close it.
 *
 * It also closes a live bug. Today an unmatched `/api` GET falls past every
 * mount, reaches the SPA catch-all at server.js:112, and returns index.html
 * with HTTP 200. A client fetching a mistyped or removed endpoint therefore
 * receives a page of HTML where it expected JSON, and reports success.
 *
 * MATCH ORDERING. `GET /api/voice/logs/:id` would happily match
 * `/api/voice/logs/seen`. Entries are sorted so that literal paths are tried
 * before parameterised ones, independent of the order they appear in the
 * policy file.
 *
 * path-to-regexp is used directly. It ships with express 5 (express ->
 * router -> path-to-regexp ^8) and resolves at the top of node_modules under
 * the committed package-lock. See the note in the deploy report about
 * promoting it to a direct dependency.
 */

const { match } = require('path-to-regexp');
const { ROUTE_POLICY, PASSWORD_CHANGE_EXEMPT, policyPermissionKeys } = require('./route-policy');

const API_PREFIX = '/api';

/** Number of `:param` segments in a path. Fewer params = more specific. */
function paramCount(path) {
  return path.split('/').filter(segment => segment.startsWith(':')).length;
}

/**
 * Longest literal prefix, measured in segments, before the first parameter.
 * `/api/voice/logs/seen` scores 4; `/api/voice/logs/:id` scores 3.
 */
function literalPrefixLength(path) {
  const segments = path.split('/').filter(Boolean);
  let count = 0;
  for (const segment of segments) {
    if (segment.startsWith(':')) break;
    count += 1;
  }
  return count;
}

function comparePolicySpecificity(a, b) {
  if (paramCount(a.path) !== paramCount(b.path)) return paramCount(a.path) - paramCount(b.path);
  if (literalPrefixLength(a.path) !== literalPrefixLength(b.path)) {
    return literalPrefixLength(b.path) - literalPrefixLength(a.path);
  }
  const aSegments = a.path.split('/').length;
  const bSegments = b.path.split('/').length;
  if (aSegments !== bSegments) return bSegments - aSegments;
  return b.path.length - a.path.length;
}

/**
 * Strip the query string and collapse repeated slashes. Enforcement reads
 * req.originalUrl so that it is independent of where the middleware is
 * mounted; a mount-relative req.path would silently lose the `/api` prefix.
 */
function normalisePath(rawUrl) {
  const withoutQuery = String(rawUrl || '').split('?')[0].split('#')[0];
  const collapsed = withoutQuery.replace(/\/{2,}/g, '/');
  if (collapsed.length > 1 && collapsed.endsWith('/')) return collapsed.slice(0, -1);
  return collapsed || '/';
}

function compilePolicy(entries = ROUTE_POLICY) {
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.method !== 'string') {
      throw new Error('[POLICY] Every policy entry needs a method and a path.');
    }
    if (!Object.prototype.hasOwnProperty.call(entry, 'permission')) {
      throw new Error(
        `[POLICY] ${entry.method} ${entry.path} has no \`permission\` key. ` +
        'Write `permission: null` if the endpoint is intentionally open to any authenticated actor.'
      );
    }
    if (!entry.path.startsWith(API_PREFIX)) {
      throw new Error(`[POLICY] ${entry.method} ${entry.path} must be an absolute /api path.`);
    }
    const signature = `${entry.method.toUpperCase()} ${entry.path}`;
    if (seen.has(signature)) throw new Error(`[POLICY] Duplicate policy entry for ${signature}.`);
    seen.add(signature);
  }

  const compiled = [...entries]
    .sort(comparePolicySpecificity)
    .map(entry => ({
      method: entry.method.toUpperCase(),
      path: entry.path,
      permission: entry.permission,
      audit: entry.audit === true,
      // Paths are matched against a lower-cased pathname (see enforcePolicy),
      // so an entry authored with a capital letter could never match. Fail at
      // boot rather than silently leaving that endpoint on POLICY_MISSING.
      matcher: (() => {
        // Only the LITERAL segments have to be lower-case. Parameter names
        // (`:entityType`) never take part in matching, so their casing is free.
        const literals = entry.path.split('/').filter(part => part && !part.startsWith(':'));
        const mixed = literals.find(part => part !== part.toLowerCase());
        if (mixed) {
          throw new Error(
            `[POLICY] Route path segment must be lower-case: "${mixed}" in ${entry.path}`
          );
        }
        // decode:false deliberately — see findIn. This matcher answers a
        // yes/no question and never reads the captured params, so decoding
        // buys nothing and can throw URIError on a malformed escape.
        return match(entry.path, { decode: false });
      })()
    }));

  const exempt = PASSWORD_CHANGE_EXEMPT.map(entry => ({
    method: entry.method.toUpperCase(),
    matcher: match(entry.path, { decode: false })
  }));

  return { compiled, exempt };
}

function findIn(compiled, method, pathname) {
  // A matcher must never throw. path-to-regexp decodes captured params, and
  // `decodeURIComponent` raises URIError on a malformed escape — so
  // `GET /api/conversations/%zz` turned into an HTTP 500 with a stack trace out
  // of the security middleware itself. Fail-closed, but a remotely-triggerable
  // 500 that also floods the very logs you watch for opt-out warnings. Matching
  // is a yes/no question here, so decoding is switched off above; this guard is
  // the belt to that pair of braces. An unmatchable path is simply no match,
  // which the caller turns into 403 POLICY_MISSING.
  // Express auto-routes HEAD to the GET handler, so HEAD must resolve to the
  // GET policy. Without this every HEAD on a valid endpoint answers 403
  // POLICY_MISSING — fail-closed, but surprising to the first health checker
  // or CDN that issues one.
  const raw = String(method || '').toUpperCase();
  const wanted = raw === 'HEAD' ? 'GET' : raw;
  for (const entry of compiled) {
    if (entry.method !== wanted) continue;
    try {
      if (entry.matcher(pathname)) return entry;
    } catch {
      // Malformed path. Not a match, and never a 500.
      return null;
    }
  }
  return null;
}

/**
 * Boot-time guard: every permission key named in the policy table must exist
 * in the sms_permissions catalogue. A typo like `analytics.raed` would
 * otherwise be a permission nobody holds — an endpoint silently bricked for
 * every role including Owner. Fail startup instead.
 *
 * @returns {Promise<{checked:number}>}
 * @throws if a key is missing or the catalogue cannot be read
 */
async function assertPolicyPermissionsExist({ client } = {}) {
  const supabase = client || require('../db').supabase;
  const wanted = policyPermissionKeys();

  const { data, error } = await supabase.from('sms_permissions').select('key');
  if (error) {
    throw new Error(
      `[POLICY] Could not read the sms_permissions catalogue (${error.message}). ` +
      'Apply scripts/rbac-migration.sql before deploying this build.'
    );
  }

  const known = new Set((data || []).map(row => row.key));
  const missing = wanted.filter(key => !known.has(key));
  if (missing.length > 0) {
    throw new Error(
      `[POLICY] Unknown permission key(s) referenced by lib/route-policy.js: ${missing.join(', ')}. ` +
      'Either the key is a typo or scripts/rbac-migration.sql has not been applied.'
    );
  }
  return { checked: wanted.length };
}

/**
 * @param {{entries?: Array}} [options]
 * @returns {import('express').RequestHandler}
 */
function createPolicyEnforcer({ entries } = {}) {
  const { compiled, exempt } = compilePolicy(entries || ROUTE_POLICY);

  return function enforcePolicy(req, res, next) {
    // Lower-cased, because Express route matching is case-insensitive by
    // default. `app.use('/api', ...)` therefore matches `GET /API/users`, but a
    // case-SENSITIVE prefix test here would not — and the original code called
    // next() when its own test failed, waving the request straight through to
    // the handler with no policy lookup and no permission check. Uppercasing
    // one letter defeated every boundary in this file. Verified before the fix:
    //   GET /api/users -> 403 FORBIDDEN
    //   GET /API/users -> 200 with the full team list
    const pathname = normalisePath(req.originalUrl || req.url).toLowerCase();

    // This middleware is mounted on '/api' only, so anything reaching it IS an
    // API request. If the prefix test somehow disagrees, that is a routing
    // assumption we no longer understand — deny rather than pass. A middleware
    // whose job is to say no must never have a branch that says yes by
    // accident.
    if (pathname !== API_PREFIX && !pathname.startsWith(`${API_PREFIX}/`)) {
      console.error(`[POLICY] Refusing an /api request whose path did not classify: ${req.method}`);
      return res.status(403).json({
        error: 'This endpoint has no authorisation policy and is therefore denied.',
        code: 'POLICY_MISSING'
      });
    }

    const entry = findIn(compiled, req.method, pathname);
    if (!entry) {
      // Deliberately does not echo the path back; a probe learns nothing it
      // did not already supply.
      return res.status(403).json({
        error: 'This endpoint has no authorisation policy and is therefore denied.',
        code: 'POLICY_MISSING'
      });
    }
    req.policy = { method: entry.method, path: entry.path, permission: entry.permission, audit: entry.audit };

    const actor = req.actor;
    if (!actor) {
      // resolveActor did not run, or ran and failed open. Never continue.
      return res.status(401).json({ error: 'Unauthorised', code: 'NO_ACTOR' });
    }

    if (actor.mustChangePassword) {
      const isExempt = exempt.some(e => e.method === req.method.toUpperCase() && e.matcher(pathname));
      if (!isExempt) {
        return res.status(403).json({
          error: 'Set a new password before continuing.',
          code: 'PASSWORD_CHANGE_REQUIRED'
        });
      }
    }

    if (entry.permission === null) return next();

    if (!actor.permissions || !actor.permissions.has(entry.permission)) {
      return res.status(403).json({
        error: 'Your role does not allow this action.',
        code: 'FORBIDDEN',
        permission: entry.permission
      });
    }

    return next();
  };
}

module.exports = {
  createPolicyEnforcer,
  compilePolicy,
  assertPolicyPermissionsExist,
  normalisePath,
  comparePolicySpecificity,
  /** Test/debug helper: resolve a method+path against the live policy table. */
  findPolicy(method, pathname, entries) {
    const { compiled } = compilePolicy(entries || ROUTE_POLICY);
    return findIn(compiled, method, normalisePath(pathname));
  }
};
