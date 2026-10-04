// The thin Node server: node:http in front of the framework-free service (src/desk.mjs). Each request becomes a
// standard Request, the service answers with a standard Response, the same objects a Cloudflare Worker gets.
import { createServer } from "node:http";

const MAX_BODY = 64 * 1024;

export function listen(handler, { port, host = "127.0.0.1", log = null }) {
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) { res.writeHead(413, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "the body is too large", code: "too_large" })); req.destroy(); return; }
        chunks.push(c);
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      const hasBody = !["GET", "HEAD", "OPTIONS"].includes(req.method) && chunks.length;
      const request = new Request(`http://${req.headers.host || `${host}:${port}`}${req.url}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
      const response = await handler(request);
      const body = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(body);
    } catch (e) {
      log?.error?.(`server: ${e?.message || e}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error", code: "internal" }));
    }
  });
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => resolve(server)); });
}
