# Code Collaborate

## Project overview

Code Collaborate is a collaborative Python and C code editor. It combines an Express backend, PostgreSQL, server-side session authentication, WebSocket rooms, Yjs synchronization, a Monaco Editor frontend, a BullMQ queue backed by Valkey, and a separate execution worker. Submitted code runs in Docker-isolated Python or C containers.

The main application is **not containerized**. Node, PostgreSQL, Valkey, Docker, and Nginx run on the host. Docker is used only by `server/executor.js` for submitted code.

Nginx serves the built frontend and proxies `/api/` and `/ws` to Express.

```text
Browser -> Nginx -> Express API / WebSocket
                     -> PostgreSQL
Express -> BullMQ / Valkey -> Worker -> Docker sandbox containers
```

## Requirements

This project uses ES modules (`"type": "module"`). On Arch Linux/Omarchy install Node.js/npm, PostgreSQL, Valkey, Docker, Nginx, and Git.

```bash
node --version
npm --version
psql --version
valkey-cli --version
docker --version
nginx -v
git --version
```

## First-time installation

```bash
cd ~/ccd_proj
npm install
```

### Start required host services

PostgreSQL must be running before creating the database or applying its schema. Enable the required host services now so they also start automatically after future reboots:

```bash
sudo systemctl enable --now postgresql valkey docker nginx
```

### Database

By default, the backend connects through the PostgreSQL Unix socket `/run/postgresql`, to database `ccd_proj`, as the operating-system user in `process.env.USER`. It can instead use `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD`; when connecting to a TLS database such as RDS, set `DB_SSL_CA_PATH` to a trusted CA file so certificate verification remains enabled. Keep passwords and CA files out of Git.

```bash
createdb ccd_proj
psql -d ccd_proj -f db/schema.sql
```

If `ccd_proj` already exists, do not recreate it. Inspect `db/schema.sql` first; it uses `CREATE TABLE IF NOT EXISTS` where applicable and additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements.

For an existing database deploying room-control permissions, apply the additive migration once before starting the updated API:

```bash
psql -v ON_ERROR_STOP=1 -d ccd_proj -f db/migrations/20261018_add_room_permissions.sql
```

### Environment

The backend requires `SESSION_SECRET`. Never overwrite an existing `.env` without reviewing it:

```bash
test -e .env && echo ".env already exists; inspect it instead of overwriting it."
```

For a new installation, generate a secret:

```bash
node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log('SESSION_SECRET=' + randomBytes(32).toString('hex'))"
```

Place the output in `.env` as one line. Keep it secret and uncommitted.

| Variable | Required | Current behavior |
| --- | --- | --- |
| `SESSION_SECRET` | Yes | Session-signing secret; server exits if absent. |
| `NODE_ENV` | No | `production` makes the session cookie secure. |
| `REDIS_HOST` | No | Defaults to `127.0.0.1`. |
| `REDIS_PORT` | No | Defaults to `6379`. |
| `USER` | Host-provided | Used as the local PostgreSQL role. |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | No | Override the local PostgreSQL defaults. |
| `DB_SSL_CA_PATH` | No | Trusted CA bundle for verified PostgreSQL TLS. |

`NODE_ENV=production` sets the session cookie's `Secure` attribute. A secure cookie requires HTTPS, so authentication can appear broken if the application is still opened at plain `http://localhost:8080`. Do not set `NODE_ENV=production` for the current local HTTP setup. For a real production deployment, configure HTTPS first and then use `NODE_ENV=production`.

## Room control permissions

Each room has one owner. The owner always has implicit control and remains the only account that can delete the room or grant/revoke permissions. A non-owner can receive one persistent `canControl` grant for that room, which permits locking, unlocking, and queuing execution of the server-side locked snapshot. It does not transfer ownership or permit managing other users' grants.

Grants are stored in `room_permissions` by room UUID and user UUID, survive reconnects/API restarts, and are deleted automatically if the room or user is deleted. A new grant requires the target account to be currently connected to that room; revocation works while the target is offline. The browser's participant count still counts WebSocket connections, while the visible participant list is deduplicated by user account.

Owner-only HTTP endpoints:

```text
GET /api/rooms/:roomId/permissions
PUT /api/rooms/:roomId/permissions/:userId   { "canControl": true|false }
```

The WebSocket `joined` message includes the current account's `canControl` capability. `presence` includes deduplicated participant records (`id`, `username`, `isOwner`, `canControl`), and `permission_changed` broadcasts `{ roomId, userId, canControl }` after a successful change. Clients must treat these as UI updates only; HTTP and WebSocket authorization is always rechecked on the server.

## Remote cursors and selections

Rooms also use the official Yjs awareness protocol for temporary remote cursors and text selections. Monaco renders a coloured caret, translucent selection, and username label for each other browser tab in the same room. The colour is deterministic per authenticated account, so a user has the same colour in multiple tabs; each tab still has its own cursor because it has its own Yjs awareness client ID. The local cursor is never rendered as a remote cursor.

Awareness is not persisted in PostgreSQL, added to `room_updates`, copied into `locked_code`, or sent to the execution queue. It remains available while the editor is locked because moving a cursor does not modify code or grant any room-control capability. Participant counts retain their existing meaning: they count WebSocket connections, while the participant drawer deduplicates accounts.

No database migration is required for this feature.

The custom authenticated WebSocket protocol adds these JSON messages after the normal `join`/`joined`/`yjs_sync` flow:

```text
Client -> server: awareness_register { clientId }
Server -> client: awareness_registered { clientId, identity, activeClientIds, update }
Client -> server: awareness_update { update }               # base64 awareness binary update
Server -> clients: awareness_update { update }               # base64 awareness binary update
Server -> client: awareness_rejected { reason, error }
```

The socket must already have joined a room. The server derives the target room from that socket, validates that every incoming frame has exactly one bounded awareness entry, and requires its client ID to match the ID registered by that socket. It replaces all client-supplied identity/colour fields with the authenticated account ID, username, and a server-chosen palette colour before relaying the update. A client-ID collision is rejected and the browser performs one clean room reopen to obtain a fresh Yjs document ID.

On a socket close, room switch, logout, or deletion, the server removes that socket's state and broadcasts the official awareness removal. Reconnecting re-registers the existing room document ID and republishes its state with an incremented awareness clock, so a disconnect tombstone cannot hide the restored cursor. If the API restarts, awareness is intentionally cleared; reconnecting browsers publish it again. The awareness protocol also renews idle state approximately every 15 seconds and removes unseen remote state after the standard Yjs awareness timeout.

### Frontend, Nginx, and execution images

```bash
npm run build:client
sudo mkdir -p /srv/http/ccd_proj
sudo cp -a client/dist/. /srv/http/ccd_proj/
sudo chown -R root:root /srv/http/ccd_proj
sudo find /srv/http/ccd_proj -type d -exec chmod 755 {} +
sudo find /srv/http/ccd_proj -type f -exec chmod 644 {} +
sudo nginx -t
sudo systemctl reload nginx
docker pull python:3.13-alpine
docker pull gcc:14
```

`nginx/ccd_proj.conf.example` is useful for proxy settings, but currently has `root /home/omarthik/ccd_proj/client/dist`. For the host deployment above, the installed Nginx configuration must use `root /srv/http/ccd_proj;`. Make and test that configuration change deliberately; this repository does not modify it automatically.

## Docker permission setup

The BullMQ worker calls the Docker CLI through `server/executor.js`, so the Linux user running the worker must access `/var/run/docker.sock`.

```bash
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

`sudo usermod -aG docker "$USER"` is normally a one-time operation. Group membership does not change existing terminals. Log out completely and log back in, or reboot; new terminals should then inherit the Docker group automatically. Verify afterward:

```bash
id -nG
docker run --rm hello-world
```

For a temporary solution in the current login session while waiting to log out or reboot:

```bash
newgrp docker
```

`newgrp docker` opens a new shell with the Docker group active. Start the worker inside that shell. It should not normally be required every day after new terminals inherit the group.

Do **not** use `chmod 666 /var/run/docker.sock`, run the whole backend with `sudo`, expose the Docker socket to user-code containers, or give submitted programs privileged Docker access.

Troubleshoot access with:

```bash
ls -l /var/run/docker.sock
id -nG
docker info
docker ps
```

An empty `docker ps` table is normal when no execution is running.

## Docker execution images

The executor currently uses these images:

```bash
docker pull python:3.13-alpine
docker pull gcc:14
docker image ls python:3.13-alpine
docker image ls gcc:14
```

Submitted code runs in short-lived containers; `--rm` removes a container after it exits whether the submitted program succeeds or fails. `server/executor.js` also attempts targeted `docker rm -f` cleanup in its `finally` block. `docker ps` shows currently running containers; `docker ps -a` includes stopped containers still present. To inspect execution containers by their name prefix:

```bash
docker ps --filter "name=ccd-execution-"
```

Current limits in `server/executor.js`: maximum 100 KiB source, intended 5-second execution timeout (exit code `124`), 10-second Docker CLI backup timeout, 1 MiB command output buffer, network disabled, memory and memory swap limited to 128 MiB, 0.5 CPU, 64 PIDs, read-only filesystem, 64 MiB writable `/tmp` tmpfs (`rw,exec,nosuid,nodev`), all capabilities dropped, `no-new-privileges`, UID/GID `65534:65534`, `HOME=/tmp`, and a read-only `/workspace` bind mount. Python uses `python -I -B /workspace/main.py`; C uses `gcc -std=c17 -Wall -Wextra` then runs the compiled program.

## Starting the project normally

After `systemctl enable` and a reboot, systemd should start PostgreSQL, Valkey, Docker, and Nginx automatically. Verify that first:

```bash
systemctl is-active postgresql valkey docker nginx
```

Normally, only the two Node processes below need to be started manually. If a required service is inactive, use these troubleshooting/fallback commands:

```bash
sudo systemctl start postgresql valkey docker nginx
```

Use two terminals.

### Terminal 1 — backend

```bash
cd ~/ccd_proj
node --env-file=.env server/index.js
```

On success it logs that the server is running at `http://localhost:3000`.

### Terminal 2 — execution worker

```bash
cd ~/ccd_proj
node --env-file=.env server/worker.js
```

On success it reports that the execution worker is waiting for jobs. If this is the current login session immediately after adding the Docker group, use the temporary `newgrp` workaround:

```bash
newgrp docker
cd ~/ccd_proj
node --env-file=.env server/worker.js
```

Open `http://localhost:8080`.

| Port/socket | Purpose | Normal access |
| --- | --- | --- |
| `8080` | Nginx frontend and proxy | Browser/local curl |
| `3000` | Express API and WebSocket | Normally reached through Nginx |
| `/run/postgresql` | PostgreSQL Unix socket | Used by this backend |
| `5432` | Conventional PostgreSQL TCP port | Not used by this backend configuration |
| `6379` | Valkey default | Queue clients/worker |

## Frontend development and deployment

The current frontend build command from `package.json` is:

```bash
npm run build:client
```

`client/src` is source and `client/dist` is generated output. Nginx does not see edits until they are rebuilt and copied again:

```bash
cd ~/ccd_proj
npm run build:client
sudo mkdir -p /srv/http/ccd_proj
sudo cp -a client/dist/. /srv/http/ccd_proj/
sudo chown -R root:root /srv/http/ccd_proj
sudo find /srv/http/ccd_proj -type d -exec chmod 755 {} +
sudo find /srv/http/ccd_proj -type f -exec chmod 644 {} +
sudo nginx -t
sudo systemctl reload nginx
```

For iterative local bundles use `npm run watch:client`; it rebuilds `client/dist` but does not deploy to `/srv/http/ccd_proj`.

## Service management commands

This guide uses the standard Arch service names `postgresql`, `valkey`, `docker`, and `nginx`. Confirm installed unit names before operating them:

```bash
systemctl list-unit-files | rg '^(postgresql|valkey|docker|nginx)\.service'
```

### PostgreSQL

```bash
systemctl status postgresql
sudo systemctl start postgresql
sudo systemctl stop postgresql
sudo systemctl restart postgresql
sudo systemctl enable postgresql
journalctl -u postgresql -n 50 --no-pager
```

### Valkey

```bash
systemctl status valkey
sudo systemctl start valkey
sudo systemctl stop valkey
sudo systemctl restart valkey
sudo systemctl enable valkey
journalctl -u valkey -n 50 --no-pager
valkey-cli ping
```

### Docker

```bash
systemctl status docker
sudo systemctl start docker
sudo systemctl stop docker
sudo systemctl restart docker
sudo systemctl enable docker
journalctl -u docker -n 50 --no-pager
docker info
docker ps
```

### Nginx

```bash
systemctl status nginx
sudo systemctl start nginx
sudo systemctl stop nginx
sudo systemctl restart nginx
sudo systemctl reload nginx
sudo systemctl enable nginx
sudo nginx -t
journalctl -u nginx -n 50 --no-pager
sudo tail -n 50 /var/log/nginx/error.log
```

## Stopping the application

`Ctrl+C` stops the backend or worker in its own terminal. Stopping the worker does not stop the backend, and stopping the backend does not stop PostgreSQL, Valkey, Docker, or Nginx. Docker execution containers normally remove themselves.

Inspect any leftovers:

```bash
docker ps -a --filter "name=ccd-execution-"
```

If one specific, verified container remains, stop and remove only that exact name:

```bash
docker stop ccd-execution-EXACT_NAME
docker rm ccd-execution-EXACT_NAME
```

Do not use broad container-removal commands for this task.

## Health checks

```bash
curl -i http://localhost:3000/api/health
curl -I http://localhost:8080
valkey-cli ping
psql -d ccd_proj -c "SELECT current_user, current_database();"
docker info
docker ps
```

For a local authenticated proxy check, use a disposable cookie jar and placeholders:

```bash
curl -i \
  -c /tmp/ccd-session.txt \
  -H "Content-Type: application/json" \
  -d '{"username":"YOUR_USERNAME","password":"YOUR_PASSWORD"}' \
  http://localhost:8080/api/auth/login

curl -b /tmp/ccd-session.txt \
  http://localhost:8080/api/auth/me
```

`/tmp/ccd-session.txt` is only for local testing; remove it when finished.

## Database commands

```bash
psql -d ccd_proj
psql -d ccd_proj -f db/schema.sql
```

Inspect `db/schema.sql` before rerunning it on an existing installation. Useful read-only commands inside `psql`:

```sql
\dt
\d users
\d rooms
\d room_updates
\d room_permissions
SELECT current_user, current_database();
```

No destructive database-reset commands are included here.

## Queue and worker behavior

Express queues owner- or control-permission-requested, locked-room executions in BullMQ. Valkey stores queue state; `server/worker.js` consumes the `code-execution` queue with concurrency 2; `server/executor.js` launches the Docker sandbox. The HTTP request returns after queueing, and execution progress/results reach room clients via WebSocket. The editor must be locked before execution, and the worker receives the server-side locked snapshot rather than browser-supplied code.

Restarting the worker does not delete PostgreSQL rooms or users. Queued jobs remain in Valkey for a restarted worker. An interrupted active job can be treated as stalled/failed by BullMQ; this application configures one attempt only. Completed jobs are retained for up to one hour (maximum 1,000); failed jobs for up to 24 hours (maximum 1,000).

## Common errors and fixes

### `EADDRINUSE` on port 3000

Another backend is running. Find it, then stop the correct process safely:

```bash
ss -ltnp | grep ':3000'
```

### Docker socket permission denied

Check group membership, log out/in or use `newgrp docker`, then start the worker in that corrected shell:

```bash
id -nG
ls -l /var/run/docker.sock
docker info
```

### Redis/Valkey `ECONNREFUSED`

```bash
sudo systemctl start valkey
valkey-cli ping
```

The project defaults to `127.0.0.1:6379` unless `REDIS_HOST` or `REDIS_PORT` are set.

### PostgreSQL connection failure

```bash
systemctl status postgresql
psql -d ccd_proj -c "SELECT current_user, current_database();"
ls -ld /run/postgresql
```

The Node process must use a local role with access to `ccd_proj`.

### Nginx `500 Permission denied`

Serve static files from `/srv/http/ccd_proj`, not a home directory Nginx cannot traverse. Check the configured root, permissions, and log:

```bash
sudo tail -n 50 /var/log/nginx/error.log
```

### Frontend changes do not appear

Rebuild, copy `client/dist`, test/reload Nginx, then hard-refresh:

```bash
npm run build:client
sudo cp -a client/dist/. /srv/http/ccd_proj/
sudo nginx -t
sudo systemctl reload nginx
```

### Login works through curl but not the browser

Check browser Console and Network tabs, verify the frontend was rebuilt/deployed, and confirm Nginx proxies `/api/` to Express. Use `http://localhost:8080` in the browser.

### Worker appears stuck

Check the worker terminal, Valkey, Docker permission/daemon status, and active containers:

```bash
valkey-cli ping
docker info
docker ps
```

Use `docker ps --filter "name=ccd-execution-"` to narrow the current view to execution containers.

### Execution timeout

The configured intended timeout is five seconds; the executor reports exit code `124` and `Execution timed out`.

### `docker ps` is empty

Expected when no code is running: completed execution containers use `--rm`.

## Normal daily workflow cheat sheet

1. Start or verify PostgreSQL, Valkey, Docker, and Nginx.
2. Start `node --env-file=.env server/index.js`.
3. Start `node --env-file=.env server/worker.js`.
4. Open `http://localhost:8080`.
5. After frontend changes, run `npm run build:client` and copy `client/dist` to `/srv/http/ccd_proj`.
6. Use `Ctrl+C` to stop the Node processes.
