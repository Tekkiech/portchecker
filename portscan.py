"""Collects host listening-port data (via `ss`) and Docker container port
bindings (via the Docker API), then merges the two into one picture of
what's using which port and why.
"""
import re
import subprocess

import docker
from docker.errors import DockerException

SS_USER_RE = re.compile(r'\("([^"]+)",pid=(\d+),fd=(\d+)\)')


def _run_ss(flag):
    """Run `ss -H -<flag>lnp` and return raw stdout lines, or [] on failure."""
    try:
        proc = subprocess.run(
            ["ss", "-H", f"-{flag}lnp"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        return proc.stdout.splitlines()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []


def _parse_ss_lines(lines, proto):
    entries = []
    for line in lines:
        parts = line.split()
        if len(parts) < 4:
            continue
        local_addr = parts[3]
        if ":" not in local_addr:
            continue
        addr, _, port = local_addr.rpartition(":")
        if not port.isdigit():
            continue
        procs = SS_USER_RE.findall(line)
        entries.append({
            "proto": proto,
            "port": int(port),
            "address": addr,
            "processes": [
                {"name": name, "pid": int(pid)} for name, pid, _fd in procs
            ],
        })
    return entries


def get_listening_ports():
    """Every TCP/UDP port the host kernel currently has bound, with the
    owning process name/pid when we have permission to see it."""
    tcp = _parse_ss_lines(_run_ss("t"), "tcp")
    udp = _parse_ss_lines(_run_ss("u"), "udp")

    merged = {}
    for entry in tcp + udp:
        key = (entry["proto"], entry["port"])
        if key not in merged:
            merged[key] = {
                "proto": entry["proto"],
                "port": entry["port"],
                "addresses": set(),
                "processes": {},
            }
        merged[key]["addresses"].add(entry["address"])
        for p in entry["processes"]:
            merged[key]["processes"][(p["name"], p["pid"])] = p

    out = []
    for (proto, port), data in merged.items():
        out.append({
            "proto": proto,
            "port": port,
            "addresses": sorted(data["addresses"]),
            "processes": list(data["processes"].values()),
        })
    return sorted(out, key=lambda e: (e["port"], e["proto"]))


def _docker_client():
    try:
        return docker.from_env()
    except DockerException:
        return None


def get_containers():
    """All containers (running or not) with whatever host ports they publish."""
    client = _docker_client()
    if client is None:
        return None, "Could not connect to the Docker socket (/var/run/docker.sock)."

    containers = []
    try:
        for c in client.containers.list(all=True):
            attrs = c.attrs
            image = attrs.get("Config", {}).get("Image", "")
            if c.image and c.image.tags:
                image = c.image.tags[0]
            raw_ports = attrs.get("NetworkSettings", {}).get("Ports") or {}
            published = []
            internal_only = []
            for key, bindings in raw_ports.items():
                container_port, _, proto = key.partition("/")
                if bindings:
                    for b in bindings:
                        published.append({
                            "container_port": int(container_port),
                            "proto": proto or "tcp",
                            "host_ip": b.get("HostIp") or "0.0.0.0",
                            "host_port": int(b["HostPort"]),
                        })
                else:
                    internal_only.append({
                        "container_port": int(container_port),
                        "proto": proto or "tcp",
                    })
            containers.append({
                "name": c.name,
                "id": c.short_id,
                "image": image,
                "status": attrs.get("State", {}).get("Status", "unknown"),
                "published_ports": sorted(published, key=lambda p: p["host_port"]),
                "internal_ports": sorted(internal_only, key=lambda p: p["container_port"]),
            })
    except DockerException as exc:
        return None, f"Error talking to Docker: {exc}"

    return sorted(containers, key=lambda c: c["name"]), None


def build_port_table():
    """Merge host listening ports with Docker's published-port map so every
    port is attributed to a container when possible, or a host process
    otherwise."""
    listening = get_listening_ports()
    containers, docker_error = get_containers()

    docker_map = {}
    if containers:
        for c in containers:
            if c["status"] != "running":
                continue
            for p in c["published_ports"]:
                docker_map.setdefault((p["proto"], p["host_port"]), []).append({
                    "container": c["name"],
                    "image": c["image"],
                    "container_port": p["container_port"],
                })

    rows = []
    seen_keys = set()
    for entry in listening:
        key = (entry["proto"], entry["port"])
        seen_keys.add(key)
        owners = docker_map.get(key)
        if owners:
            rows.append({
                "proto": entry["proto"],
                "port": entry["port"],
                "addresses": entry["addresses"],
                "owner_type": "container",
                "owners": owners,
                "processes": entry["processes"],
            })
        else:
            procs = entry["processes"]
            rows.append({
                "proto": entry["proto"],
                "port": entry["port"],
                "addresses": entry["addresses"],
                "owner_type": "host",
                "owners": [{"process": p["name"], "pid": p["pid"]} for p in procs] or [
                    {"process": "unknown", "pid": None}
                ],
                "processes": procs,
            })

    # Docker sometimes publishes a port whose docker-proxy/listener we didn't
    # catch (e.g. permission issues reading `ss` output) - still surface it.
    for (proto, port), owners in docker_map.items():
        if (proto, port) in seen_keys:
            continue
        rows.append({
            "proto": proto,
            "port": port,
            "addresses": [],
            "owner_type": "container",
            "owners": owners,
            "processes": [],
        })

    rows.sort(key=lambda r: (r["port"], r["proto"]))
    return rows, containers, docker_error


def check_port(port, proto=None):
    rows, _containers, _err = build_port_table()
    matches = [r for r in rows if r["port"] == port and (proto is None or r["proto"] == proto)]
    return matches


def find_free_ports(start, end, proto="tcp", limit=10):
    rows, _containers, _err = build_port_table()
    used = {r["port"] for r in rows if r["proto"] == proto}
    free = []
    for p in range(start, end + 1):
        if p not in used:
            free.append(p)
            if len(free) >= limit:
                break
    return free
