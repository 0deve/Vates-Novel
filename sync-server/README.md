# Sync server

Tiny self-hosted server that stores each device's reading-progress document
as a JSON file. All merging happens in the app; the server is a dumb,
token-protected blob store (see `server.js`, ~100 lines, zero dependencies).

## Deploy (Docker Compose behind a reverse proxy)

No image build: the compose file runs stock `node:22-alpine` with
`server.js` bind-mounted, so it also drops cleanly into stack managers
like Dockge or Portainer (create a stack, paste `compose.yaml`, put
`server.js` + `package.json` next to it).

1. Copy this directory to the server (into your stacks directory if you
   use a stack manager). All mounts in `compose.yaml` are relative to it.

2. Create `.env` next to `compose.yaml` with a long random token, and
   create `data/` yourself — if docker creates it, it's owned by root and
   the server (running as the unprivileged `node` user) can't write to it:

   ```sh
   echo "SYNC_TOKEN=$(openssl rand -base64 32 | tr -d '/+=')" > .env
   chmod 600 .env
   mkdir -p data
   ```

3. `docker compose up -d` (or hit deploy in your stack manager)

4. Route a hostname to it, whichever way you already expose services:

   - Cloudflare Tunnel: in Zero Trust, add a public hostname
     `sync.example.com` -> service `http://novel-sync:8377` on your
     existing tunnel (cloudflared must be on the same docker network).
     The DNS record is created automatically.
   - Reverse proxy (NPM, Caddy, nginx): add a host that proxies to
     `novel-sync:8377` on the shared docker network, HTTPS terminated at
     the proxy. Plain nginx equivalent:

     ```nginx
     server {
         listen 443 ssl;
         server_name sync.example.com;
         # ssl_certificate ... (same setup as the other sites)
         location / {
             proxy_pass http://novel-sync:8377;
         }
     }
     ```

5. In the app, Settings -> Sync: enter `https://sync.example.com` and the
   token from `.env`, enable sync on every device.

`GET /health` needs no auth — point Uptime Kuma or similar at it.

## Notes

- The container runs as the `node` user (uid 1000). If `data/` on the host
  is owned by root or another uid you'll see EACCES in the logs — fix with
  `sudo chown -R 1000:1000 data`.
- Data is one small JSON file per device in `data/`; deleting a file just
  makes that device re-upload on its next sync.
- Novels and positions sync automatically: a novel added on one device is
  re-fetched from its source and added on the others at their next sync.
  Chapter downloads stay per-device. The one exception is novels imported
  from local epub/txt files — their content exists only on the importing
  device, so move those once via Settings -> Library Backup.
