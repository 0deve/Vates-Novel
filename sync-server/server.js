// Minimal self-hosted sync server for Vates Novel reading progress.
// Zero dependencies, plain Node.js. Each device PUTs its own progress
// document; clients GET all documents and merge on their side, so the
// server never needs to understand the payload.
//
//   GET  /health            liveness probe (no auth)
//   GET  /sync              -> { "devices": [ <doc>, ... ] }
//   PUT  /sync/<device-id>  store the request body as that device's doc
//
// Auth: "Authorization: Bearer $SYNC_TOKEN" on everything except /health.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const PORT = Number(process.env.PORT || 8377);
const DATA_DIR = process.env.DATA_DIR || "/data";
const TOKEN = process.env.SYNC_TOKEN;

if (!TOKEN || TOKEN.length < 16) {
  console.error("SYNC_TOKEN env var is missing or shorter than 16 characters");
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
try {
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
} catch {
  // Bind-mounted dirs created by docker are root-owned; we run as node (1000).
  console.error(
    `WARNING: ${DATA_DIR} is not writable by this user — uploads will fail ` +
      `with 500 until you run: sudo chown -R 1000:1000 <stack-dir>/data`,
  );
}

const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY = 2 * 1024 * 1024; // progress docs are a few KB; 2 MB is generous

const sha = (s) => crypto.createHash("sha256").update(s).digest();
const authorized = (req) => {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  return crypto.timingSafeEqual(sha(token), sha(TOKEN));
};

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const p = new URL(req.url, "http://localhost").pathname;

  if (req.method === "GET" && p === "/health") return json(res, 200, { ok: true });
  if (!authorized(req)) return json(res, 401, { error: "unauthorized" });

  if (req.method === "GET" && p === "/sync") {
    const devices = [];
    let files;
    try {
      files = fs.readdirSync(DATA_DIR);
    } catch (e) {
      console.error(`cannot read ${DATA_DIR}:`, e.message);
      return json(res, 500, { error: "data dir unreadable" });
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        devices.push(JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8")));
      } catch {
        // skip a corrupt/partial file rather than failing the whole pull
      }
    }
    return json(res, 200, { devices });
  }

  const put = req.method === "PUT" && p.match(/^\/sync\/([^/]+)$/);
  if (put) {
    const id = put[1];
    if (!DEVICE_ID.test(id)) return json(res, 400, { error: "bad device id" });

    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        json(res, 413, { error: "body too large" });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      const body = Buffer.concat(chunks).toString("utf8");
      try {
        JSON.parse(body);
      } catch {
        return json(res, 400, { error: "body is not valid JSON" });
      }
      const file = path.join(DATA_DIR, `${id}.json`);
      const tmp = `${file}.tmp`;
      try {
        // Cap distinct devices so a leaked token can't fill the disk with
        // invented ids. Overwrites of known devices always go through.
        if (!fs.existsSync(file)) {
          const count = fs
            .readdirSync(DATA_DIR)
            .filter((f) => f.endsWith(".json")).length;
          if (count >= 25) return json(res, 400, { error: "too many devices" });
        }
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, file); // atomic: a pull never sees a half-written doc
      } catch (e) {
        // Most likely a root-owned bind mount; answer instead of crashing.
        console.error(`write failed for ${file}:`, e.message);
        return json(res, 500, { error: "write failed (data dir permissions?)" });
      }
      return json(res, 200, { ok: true });
    });
    return;
  }

  return json(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`novel-sync listening on :${PORT}, data in ${DATA_DIR}`);
});
