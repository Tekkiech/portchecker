# Port Checker

A small self-hosted dashboard for ZimaOS (or any Docker host) that shows:

- **Every port currently listening on the host** (TCP + UDP), not just ones
  Docker published.
- **Which container owns each port**, cross-referenced from the Docker API.
- **Host services** using a port outside of Docker (SSH, the ZimaOS UI
  itself, etc.), so you know why a port is unavailable even when no
  container claims it.
- A **quick check** ("is port 8080 free?") and a **free-port finder** for a
  range, so you stop hitting `port is already allocated` when installing a
  new container.

It runs entirely as a container itself and never writes to the host
filesystem — nothing to worry about with ZimaOS's read-only root. Docker's
own build cache and image storage live on ZimaOS's writable data volume
(wherever `dockerd` keeps `/var/lib/docker`), not on the read-only OS
partition, so `docker compose build` works normally over SSH even though the
rest of the OS is locked down.

## How it works

The container shares the host's **network namespace** (`network_mode:
host`) and **PID namespace** (`pid: host`), and gets a read-only mount of
`/var/run/docker.sock`. That lets it:

1. Run `ss -tlnp` / `ss -ulnp` to list every listening socket on the host,
   with the owning process name/PID (this also catches container ports —
   Docker's `docker-proxy` process shows up here for published ports).
2. Query the Docker API for each container's published port bindings and
   image name.
3. Merge the two: a listening port is labeled with the container that
   published it when there's a match, otherwise with the host process name.

No data is persisted; every request re-scans live state.

## Deploying on ZimaOS

1. Copy this folder to a writable location on the box, e.g. via SSH:
   ```bash
   scp -r portchecker/ zimaos-host:/DATA/AppData/portchecker
   ```
   `/DATA/AppData/<app-name>/` is ZimaOS's own convention for app configs
   (it's where the App Store puts things like `/DATA/AppData/plex/config`),
   so this stays consistent with how ZimaOS expects data to be laid out
   even though the app itself isn't installed through the App Store.

   Alternatively, if your ZimaOS App Store build supports "Install a
   Customized App" / compose-based custom installs, you can paste the
   contents of `docker-compose.yml` there instead of using SSH — just make
   sure `network_mode: host`, `pid: host`, and the `docker.sock` volume
   mount survive the import, since the GUI form doesn't always expose
   those fields.

2. On the ZimaOS host:
   ```bash
   cd /DATA/AppData/portchecker
   docker compose up -d --build
   ```

   If this fails with `mkdir /root/.docker: read-only file system`, the
   Docker CLI is trying to create its config/cache directory under `$HOME`
   (`/root` when you're root), which is also on the read-only partition.
   Point it at a writable directory instead:
   ```bash
   export DOCKER_CONFIG=/DATA/AppData/portchecker/.docker
   mkdir -p "$DOCKER_CONFIG"
   docker compose up -d --build
   ```

3. The dashboard is now on **port 8420** on the host itself (because of
   `network_mode: host`, the compose file doesn't need a `ports:` mapping —
   it's already bound directly to the host IP):
   ```
   http://<zimaos-ip>:8420
   ```

To change the port, set `PORT` in `docker-compose.yml`'s `environment:`
before starting it.

## Exposing it remotely (Cloudflare Tunnel, etc.)

Point your tunnel at `http://<zimaos-ip>:8420` (or `localhost:8420` if
`cloudflared` runs on the same host). Because this dashboard reveals your
running processes and containers, **set `AUTH_USERNAME`/`AUTH_PASSWORD` in
the compose file** before exposing it beyond your LAN — the app will then
require HTTP Basic Auth on every route. Combining that with a Cloudflare
Access policy on the tunnel hostname is recommended for defense in depth.

## Security notes

- `pid: host`, `network_mode: host`, and the Docker socket mount together
  give this container visibility into (and API control over) everything
  Docker manages on the host — comparable to root access. Only run it on
  hosts you trust, and don't expose it without authentication.
- The Docker socket is mounted `:ro`, which stops the mount itself from
  being modified, but a process that can reach the socket still gets full
  Docker API access (create/stop containers, mount host paths, etc.) — the
  `:ro` flag is not a security boundary by itself. This app only ever calls
  read-only Docker API methods, but keep that in mind if you extend it.

## Local development (without Docker)

```bash
pip install -r requirements.txt
python app.py
```

Without `network_mode: host` / `pid: host` / the Docker socket, you'll
still get the UI, but port and container data will be empty or limited to
what your local machine's Docker daemon and `ss` can see.

## API

- `GET /api/ports` — merged list of listening ports with owner info.
- `GET /api/containers` — all containers with published + internal ports.
- `GET /api/check/<port>?proto=tcp|udp` — is this port in use, and by what.
- `GET /api/free-ports?start=8000&end=9000&proto=tcp&limit=10` — next free
  ports in a range.
- `GET /api/health` — liveness check.
