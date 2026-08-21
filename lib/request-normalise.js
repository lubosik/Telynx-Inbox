'use strict';
/**
 * lib/request-normalise.js — two small middlewares that run before routing.
 *
 * They live here rather than inline in server.js so they can be tested. That is
 * not incidental: the RBAC bypass this release fixed hid precisely because no
 * test ever mounted the real middleware stack, so the interaction between
 * Express's mount matching and our own path handling was invisible to the suite.
 */

/**
 * Collapse repeated slashes in the PATH ONLY.
 *
 * `app.use('/api', ...)` does not match `//api/conversations`, so neither the
 * authorisation gate nor the real handler runs and the request falls through to
 * the SPA catch-all — returning index.html with HTTP 200 to a client that asked
 * for JSON, and reporting success.
 *
 * The query string is deliberately excluded. Collapsing the whole URL would
 * rewrite `?next=https://example.com` into `?next=https:/example.com`.
 */
function collapseDuplicateSlashes(req, _res, next) {
  const split = req.url.indexOf('?');
  const pathname = split === -1 ? req.url : req.url.slice(0, split);
  if (pathname.includes('//')) {
    const query = split === -1 ? '' : req.url.slice(split);
    req.url = pathname.replace(/\/{2,}/g, '/') + query;
  }
  next();
}

/**
 * Anything addressed to the API answers as the API, whatever its casing.
 *
 * With `case sensitive routing` on, `/API/users` matches no mount, falls to the
 * SPA catch-all, and returns a web page with HTTP 200. Closing that in the
 * policy enforcer and leaving it open here would be half a fix. 404 is the
 * honest answer: there is no resource under that name.
 *
 * `/apixyz` is NOT an API path and must keep reaching the SPA — hence the
 * `(/|$)` boundary rather than a bare prefix test.
 */
function rejectMiscasedApiPaths(req, res, next) {
  const looksLikeApi = /^\/api(\/|$)/i.test(req.path);
  const isApi = /^\/api(\/|$)/.test(req.path);
  if (looksLikeApi && !isApi) {
    return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  }
  next();
}

module.exports = { collapseDuplicateSlashes, rejectMiscasedApiPaths };
