import os
import secrets

from flask import Flask, jsonify, render_template, request, Response

import portscan

app = Flask(__name__)

AUTH_USERNAME = os.environ.get("AUTH_USERNAME", "")
AUTH_PASSWORD = os.environ.get("AUTH_PASSWORD", "")
AUTH_ENABLED = bool(AUTH_USERNAME and AUTH_PASSWORD)


@app.before_request
def _protect_all_routes():
    if AUTH_ENABLED and request.endpoint != "static":
        auth = request.authorization
        valid = (
            auth
            and secrets.compare_digest(auth.username, AUTH_USERNAME)
            and secrets.compare_digest(auth.password, AUTH_PASSWORD)
        )
        if not valid:
            return Response(
                "Authentication required", 401,
                {"WWW-Authenticate": 'Basic realm="portchecker"'},
            )


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/favicon.ico")
def favicon():
    # the tab icon is an inline data: URI in index.html; this just quiets
    # browsers' legacy fallback request for /favicon.ico
    return "", 204


@app.route("/api/ports")
def api_ports():
    rows, containers, docker_error = portscan.build_port_table()
    return jsonify({
        "ports": rows,
        "docker_available": docker_error is None,
        "docker_error": docker_error,
        "summary": {
            "total": len(rows),
            "tcp": sum(1 for r in rows if r["proto"] == "tcp"),
            "udp": sum(1 for r in rows if r["proto"] == "udp"),
            "by_container": sum(1 for r in rows if r["owner_type"] == "container"),
            "by_host": sum(1 for r in rows if r["owner_type"] == "host"),
            "containers_running": sum(1 for c in (containers or []) if c["status"] == "running"),
            "containers_total": len(containers or []),
        },
    })


@app.route("/api/containers")
def api_containers():
    containers, docker_error = portscan.get_containers()
    return jsonify({
        "containers": containers or [],
        "docker_available": docker_error is None,
        "docker_error": docker_error,
    })


@app.route("/api/check/<int:port>")
def api_check(port):
    proto = request.args.get("proto")
    matches = portscan.check_port(port, proto=proto)
    return jsonify({
        "port": port,
        "in_use": bool(matches),
        "matches": matches,
    })


@app.route("/api/free-ports")
def api_free_ports():
    try:
        start = int(request.args.get("start", 8000))
        end = int(request.args.get("end", 9000))
        limit = min(int(request.args.get("limit", 10)), 100)
    except ValueError:
        return jsonify({"error": "start/end/limit must be integers"}), 400
    proto = request.args.get("proto", "tcp")
    if end < start:
        return jsonify({"error": "end must be >= start"}), 400
    if end - start > 200000:
        return jsonify({"error": "range too large"}), 400
    free = portscan.find_free_ports(start, end, proto=proto, limit=limit)
    return jsonify({"start": start, "end": end, "proto": proto, "free_ports": free})


@app.route("/api/health")
def api_health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8420))
    app.run(host="0.0.0.0", port=port)
