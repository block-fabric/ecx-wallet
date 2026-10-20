// Tiny static server for the web-page runs (serves out/<browser>/) + result sink for Firefox backgrounds.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { RESULT_PORT } from "./assemble-const.mjs";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };

export function startServer(root, onResult) {
  const srv = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "POST" && req.url === "/result") {
      let body = "";
      for await (const c of req) body += c;
      res.end("ok");
      onResult?.(JSON.parse(body));
      return;
    }
    try {
      const path = new URL("." + decodeURIComponent(new URL(req.url, "http://x").pathname), root);
      const data = await readFile(path);
      res.setHeader("Content-Type", TYPES[extname(path.pathname)] ?? "application/octet-stream");
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  return new Promise((ok) => srv.listen(RESULT_PORT, "127.0.0.1", () => ok(srv)));
}
