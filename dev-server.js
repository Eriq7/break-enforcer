// Local stand-in for the Vercel deployment: one origin serving
//   /        the landing page (landing/)
//   /app/    the app (app/)
//   /api/x   the handler in api/x.js
// Run with `npm run dev`. Reads secrets from .env, which is never committed.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4300;
const HOST = '127.0.0.1';
const MAX_BODY = 8 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${HOST}`);
  try {
    if (pathname.startsWith('/api/')) return await runApi(pathname.slice(5), req, res);
    if (pathname === '/app') return redirect(res, '/app/');
    if (pathname.startsWith('/app/')) return await serveFile(res, 'app', pathname.slice(5));
    return await serveFile(res, 'landing', pathname.slice(1));
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.end('dev server error');
  }
});

async function runApi(name, req, res) {
  if (!/^[a-z-]+$/.test(name)) return notFound(res);
  let mod;
  try {
    mod = await import(pathToFileURL(path.join(root, 'api', `${name}.js`)).href);
  } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND') return notFound(res);
    throw e;
  }
  req.body = await readJson(req);
  if (req.body === undefined) {
    res.statusCode = 413;
    return res.end('body too large');
  }
  await mod.default(req, res);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(undefined);
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

async function serveFile(res, dir, rel) {
  const base = path.join(root, dir);
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base + path.sep) && file !== base) return notFound(res);
  const target = rel === '' || rel.endsWith('/') ? path.join(file, 'index.html') : file;
  let body;
  try {
    body = await readFile(target);
  } catch {
    return notFound(res);
  }
  res.setHeader('content-type', TYPES[path.extname(target)] || 'application/octet-stream');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function redirect(res, to) {
  res.statusCode = 302;
  res.setHeader('location', to);
  res.end();
}

function notFound(res) {
  res.statusCode = 404;
  res.end('not found');
}

server.listen(PORT, HOST, () => {
  const missing = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'OPENAI_API_KEY'].filter((k) => !process.env[k]);
  console.log(`Break Enforcer dev server: http://${HOST}:${PORT}/app/`);
  if (missing.length) console.log(`  Still empty in .env: ${missing.join(', ')}`);
  if (process.env.TEST_RELAX_SECONDS || process.env.TEST_BUFFER_SECONDS) {
    console.log(`  Test durations: relax ${process.env.TEST_RELAX_SECONDS || 'default'} s, buffer ${process.env.TEST_BUFFER_SECONDS || 'default'} s`);
  }
});
