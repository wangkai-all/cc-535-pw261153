import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RollStore, BusinessError } from './lib/roll.mjs';
import { httpStatusFor } from './lib/errors.mjs';
import { parseTicket, parseTicketParams } from './lib/ticket.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 64 * 1024;

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

class HttpError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'BODY_TOO_LARGE', '请求体过大');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'INVALID_JSON', '请求体必须是 JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_JSON', '请求体必须是 JSON 对象');
  }
  return value;
}

function routeMatch(pathname, pattern) {
  const m = pattern.exec(pathname);
  if (!m) return null;
  try {
    return Object.fromEntries(
      Object.entries(m.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]),
    );
  } catch {
    throw new HttpError(400, 'INVALID_PATH', '路径参数编码不合法');
  }
}

/** 本地样例：缺页卷、卷尾丢失卷、完整卷。 */
export function seedSamples(store = new RollStore()) {
  const addPage = (rollNo, page, lines) =>
    store.importBatch(rollNo, lines.map((line) => ({ page, line })));

  if (!store.rolls.has('RM-2024-001')) {
    store.createRoll({
      rollNo: 'RM-2024-001',
      pageCount: 4,
      linesPerPage: 3,
      note: '先收到尾页，第 3 页缺失；第 1 页被复印两次',
    });
    addPage('RM-2024-001', 1, [1, 2, 3]);
    addPage('RM-2024-001', 2, [1, 2, 3]);
    addPage('RM-2024-001', 4, [1, 2]); // 尾页还缺第 3 行
    store.importTicket('RM-2024-001', { page: 1, line: 1 }); // 重复复印
  }
  if (!store.rolls.has('RM-2024-002')) {
    store.createRoll({
      rollNo: 'RM-2024-002',
      pageCount: 5,
      linesPerPage: 3,
      lastPageLost: true,
      note: '卷尾丢失，只能交已确认段',
    });
    addPage('RM-2024-002', 1, [1, 2, 3]);
    addPage('RM-2024-002', 2, [1, 2, 3]);
    addPage('RM-2024-002', 4, [1, 2, 3]);
  }
  if (!store.rolls.has('RM-2024-003')) {
    store.createRoll({ rollNo: 'RM-2024-003', pageCount: 2, linesPerPage: 3, note: '完整小卷，可直接整卷交付' });
    addPage('RM-2024-003', 1, [1, 2, 3]);
    addPage('RM-2024-003', 2, [1, 2, 3]);
  }
  return store;
}

/** @param {{store?: RollStore, seed?: boolean}} [opts] */
export function createApp(opts = {}) {
  const store = opts.store ?? new RollStore();
  if (opts.seed !== false) seedSamples(store);

  async function handleApi(req, res, pathname) {
    let m;

    if (req.method === 'GET' && pathname === '/api/health') {
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/rolls') {
      return json(res, 200, { rolls: [...store.rolls.keys()].map((rollNo) => store.view(rollNo)) });
    }

    if (req.method === 'POST' && pathname === '/api/rolls') {
      const body = await readJson(req);
      const roll = store.createRoll(body);
      return json(res, 201, { action: 'CREATE_ROLL', roll: store.view(roll.rollNo) });
    }

    if ((m = routeMatch(pathname, /^\/api\/rolls\/(?<rollNo>[^/]+)\/pages$/u)) && req.method === 'POST') {
      const body = await readJson(req);
      if (!Array.isArray(body.tickets)) {
        throw new HttpError(400, 'INVALID_TICKETS', 'tickets 必须是数组，元素形如 {page, line}');
      }
      const result = store.importBatch(m.rollNo, body.tickets);
      return json(res, 200, {
        action: 'IMPORT_PAGES',
        imported: result.imported,
        duplicates: result.duplicates,
        roll: store.view(m.rollNo),
      });
    }

    if (
      (m = routeMatch(
        pathname,
        /^\/api\/rolls\/(?<rollNo>[^/]+)\/pages\/(?<page>[^/]+)\/lines\/(?<line>[^/]+)$/u,
      ))
    ) {
      if (req.method !== 'PUT') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '请使用 PUT 导入单页');
      const params = parseTicketParams(m);
      const result = store.importTicket(params.rollNo, parseTicket(params));
      return json(res, 200, {
        action: 'IMPORT_PAGE',
        duplicate: result.duplicate,
        roll: store.view(params.rollNo),
      });
    }

    if ((m = routeMatch(pathname, /^\/api\/rolls\/(?<rollNo>[^/]+)\/deliveries$/u)) && req.method === 'POST') {
      const body = await readJson(req);
      const handoff = store.commitDelivery(m.rollNo, { mode: body.mode });
      return json(res, 200, { action: 'DELIVER', handoff, roll: store.view(m.rollNo) });
    }

    if ((m = routeMatch(pathname, /^\/api\/rolls\/(?<rollNo>[^/]+)\/handoff$/u)) && req.method === 'GET') {
      const view = store.view(m.rollNo);
      return json(res, 200, { action: 'VIEW_HANDOFF', handoff: view.handoff, roll: view });
    }

    if ((m = routeMatch(pathname, /^\/api\/rolls\/(?<rollNo>[^/]+)$/u))) {
      if (req.method === 'GET') {
        return json(res, 200, { action: 'VIEW_ROLL', roll: store.view(m.rollNo) });
      }
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        const roll = store.updateRoll(m.rollNo, body);
        return json(res, 200, { action: 'UPDATE_ROLL', roll: store.view(roll.rollNo) });
      }
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', '请使用 GET 或 PATCH');
    }

    throw new HttpError(404, 'NOT_FOUND', `没有这个接口：${req.method} ${pathname}`);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    try {
      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, pathname);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', '静态资源只支持 GET');
      }
      const entry = STATIC_FILES.get(pathname);
      if (!entry) throw new HttpError(404, 'NOT_FOUND', '页面不存在');
      const [file, type] = entry;
      const content = await readFile(path.join(PUBLIC_DIR, file));
      res.writeHead(200, {
        'content-type': type,
        'content-length': content.length,
        'cache-control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (error instanceof BusinessError) {
        json(res, httpStatusFor(error.code), {
          error: { code: error.code, message: error.message, details: error.details },
        });
        return;
      }
      if (error instanceof HttpError) {
        json(res, error.status, {
          error: { code: error.code, message: error.message, details: error.details },
        });
        return;
      }
      console.error('[server] unhandled', error);
      json(res, 500, { error: { code: 'INTERNAL', message: '服务器内部错误' } });
    }
  });

  server.store = store;
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const rawPort = process.env.PORT ?? '3000';
  const port = Number(rawPort);
  if (!/^\d+$/u.test(rawPort) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    console.error(`PORT 不是合法端口：${rawPort}`);
    process.exit(1);
  }
  const server = createApp();
  server.listen(port, '127.0.0.1', () => {
    const address = /** @type {import('node:net').AddressInfo} */ (server.address());
    console.log(`票卷交接站已启动：http://127.0.0.1:${address.port}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
