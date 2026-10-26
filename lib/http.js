// Shared plumbing for the api/ handlers. Uses only Node's own req/res, so the same handler
// runs on Vercel and under dev-server.js.

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function route(methods, fn) {
  return async (req, res) => {
    if (!methods.includes(req.method)) {
      return send(res, 405, { error: 'method_not_allowed', message: 'Method not allowed' });
    }
    try {
      send(res, 200, await fn(req, res));
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status >= 500) console.error(e.message);
        return send(res, e.status, { error: e.code, message: e.message });
      }
      console.error(e);
      send(res, 500, { error: 'server_error', message: 'Server error. Try again later.' });
    }
  };
}

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

export function queryParam(req, name) {
  return new URL(req.url, 'http://local').searchParams.get(name);
}

// A value from .env (locally) or the Vercel project settings (online).
export function env(name) {
  const value = process.env[name];
  if (!value) {
    throw new HttpError(500, 'missing_env', `The server is missing ${name}. Add it to .env (locally) or the Vercel settings (online).`);
  }
  return value;
}
