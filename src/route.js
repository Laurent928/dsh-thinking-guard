/**
 * 回环路由的小工具。
 *
 * 滑条只允许本机读写：外部来源一律 403，body 有上限，避免被当成上传口。
 */

/** JSON 请求体上限。 */
export const MAX_BODY = 8192;

/**
 * 判断请求是否来自本机。
 * @param req - Node 请求对象。
 * @returns 是否回环来源。
 */
export function isLoopback(req) {
  const address = req?.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * 读 JSON 请求体。
 * @param req - Node 请求对象。
 * @returns 解析后的对象；超限或坏 JSON 返回空对象。
 */
export function readJson(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { req.destroy(); resolve({}); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/**
 * 回一个 JSON 响应。
 * @param res - Node 响应对象。
 * @param status - HTTP 状态码。
 * @param payload - 响应体。
 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}
