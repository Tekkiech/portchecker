(() => {
  const THEME_KEY = "pc_theme";
  const AUTO_KEY = "pc_autoRefresh";
  const BAND_DEFS = [
    ["System", 0, 1023],
    ["Registered", 1024, 9999],
    ["Dynamic", 10000, 65535],
  ];
  const NAV_ITEMS = [
    ["overview", "Overview"],
    ["ports", "Ports"],
    ["containers", "Containers"],
    ["tools", "Tools"],
  ];
  const VIEW_TITLES = {
    overview: ["Overview", "Live host and container port map, re-scanned on every request."],
    ports: ["Listening ports", "Every TCP and UDP socket bound on the host, with its owner."],
    containers: ["Containers", "Published and internal bindings, per container."],
    tools: ["Tools", "Availability checks and free-port lookups against live state."],
  };

  const state = {
    view: "overview",
    autoRefresh: true,
    theme: null,
    refreshInFlight: false,
    ports: [], containers: [], attention: [], host: {}, summary: {},
    dockerAvailable: true, scanMs: null,
    portsQ: "", portsProto: "all", portsKind: "all", sortKey: "port", sortDir: 1,
    selContainer: null,
    ovCheckProto: "tcp", tlCheckProto: "tcp", tlRangeProto: "tcp",
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  function fmtTime(d) {
    return d.toLocaleTimeString([], { hour12: false });
  }

  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
  }

  /* ---------------- row helpers ---------------- */

  function rowKind(r) {
    if (r.owner_type === "container") return "container";
    if (r.owners && r.owners.length && r.owners.every((o) => o.process === "unknown")) return "unknown";
    return "host";
  }

  function kindTone(kind) {
    if (kind === "container") return { fg: "var(--accent)", bg: "var(--accent-wash)", label: "Container" };
    if (kind === "host") return { fg: "var(--ink-2)", bg: "var(--line-2)", label: "Host" };
    return { fg: "var(--warn)", bg: "var(--warn-wash)", label: "Unknown" };
  }

  function ownerLabel(r) {
    if (r.owner_type === "container") return r.owners.map((o) => o.container).join(", ");
    return r.owners.map((o) => o.process || "unknown").join(", ");
  }

  function ownerSub(r) {
    if (r.owner_type === "container") {
      return r.owners.map((o) => `${o.image || ""} → :${o.container_port}`).join("; ");
    }
    if (rowKind(r) === "unknown") return "no process attribution";
    return r.owners.map((o) => (o.pid ? `pid ${o.pid}` : "kernel")).join(", ");
  }

  /* ---------------- preferences ---------------- */

  function loadPreferences() {
    try {
      const auto = localStorage.getItem(AUTO_KEY);
      if (auto !== null) state.autoRefresh = auto === "1";
      state.theme = localStorage.getItem(THEME_KEY) || null;
    } catch { /* localStorage can throw in locked-down/private-browsing contexts */ }
  }

  /* ---------------- theme ---------------- */

  function effectiveDark() {
    const attr = document.documentElement.getAttribute("data-theme");
    return attr ? attr === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function applyTheme() {
    if (state.theme) document.documentElement.setAttribute("data-theme", state.theme);
    else document.documentElement.removeAttribute("data-theme");
    const dark = effectiveDark();
    $("#theme-glyph").textContent = dark ? "○" : "●";
    $("#theme-label").textContent = dark ? "Light theme" : "Dark theme";
  }

  function toggleTheme() {
    state.theme = effectiveDark() ? "light" : "dark";
    try { localStorage.setItem(THEME_KEY, state.theme); } catch { /* ignore */ }
    applyTheme();
  }

  /* ---------------- auto-refresh ---------------- */

  let refreshTimer = null;
  function scheduleAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    if (state.autoRefresh) refreshTimer = setInterval(refresh, 15000);
  }

  function setAutoRefresh(on) {
    state.autoRefresh = on;
    const track = $("#auto-refresh-toggle").querySelector(".switch-track");
    track.dataset.on = String(on);
    $("#auto-refresh-toggle").setAttribute("aria-pressed", String(on));
    try { localStorage.setItem(AUTO_KEY, on ? "1" : "0"); } catch { /* ignore */ }
    scheduleAutoRefresh();
  }

  /* ---------------- nav / views ---------------- */

  function navCount(key) {
    if (key === "ports") return String(state.ports.length);
    if (key === "containers") return state.dockerAvailable === false ? "—" : String(state.containers.length);
    return "";
  }

  function renderNav() {
    const build = (container, itemClass) => {
      container.innerHTML = NAV_ITEMS.map(([key, label]) => `
        <button class="${itemClass}" data-view="${key}" type="button" ${state.view === key ? 'aria-current="page"' : ""}>
          ${itemClass === "nav-item" ? '<span class="nav-dot"></span>' : ""}
          <span class="nav-label">${label}</span>
          ${itemClass === "nav-item" ? `<span class="nav-count">${navCount(key)}</span>` : ""}
        </button>
      `).join("");
      $$("button", container).forEach((btn) => btn.addEventListener("click", () => switchView(btn.dataset.view)));
    };
    build($("#nav"), "nav-item");
    build($("#pill-nav"), "pill-nav-item");
  }

  function switchView(view) {
    state.view = view;
    $$(".view").forEach((v) => { v.hidden = v.dataset.view !== view; });
    $("#view-title").textContent = VIEW_TITLES[view][0];
    $("#view-sub").textContent = VIEW_TITLES[view][1];
    renderNav();
    renderCurrentView();
  }

  function renderCurrentView() {
    if (state.view === "overview") renderOverview();
    else if (state.view === "ports") renderPorts();
    else if (state.view === "containers") renderContainers();
  }

  /* ---------------- host meta ---------------- */

  function renderHostMeta() {
    $("#brand-host").textContent = state.host.hostname || " ";
    const rows = [
      ["Hostname", state.host.hostname || "—"],
      ["Docker", state.host.docker_version ? "v" + state.host.docker_version : "—"],
      ["Uptime", state.host.uptime || "—"],
      ["Scan", state.scanMs != null ? state.scanMs + " ms" : "—"],
    ];
    $("#host-meta").innerHTML = rows.map(([k, v]) => `
      <div class="host-row"><span class="host-row-k">${k}</span><span class="host-row-v">${escapeHtml(v)}</span></div>
    `).join("");
  }

  /* ---------------- overview ---------------- */

  function computeTiles() {
    const running = state.containers.filter((c) => c.status === "running").length;
    const hostN = state.ports.filter((r) => r.owner_type === "host").length;
    const unkN = state.ports.filter((r) => rowKind(r) === "unknown").length;
    const usedTcp = new Set(state.ports.filter((r) => r.proto === "tcp").map((r) => r.port));
    let nextFree = 8000;
    while (usedTcp.has(nextFree)) nextFree++;
    return [
      { label: "Listening sockets", value: state.ports.length, sub: `${state.summary.tcp || 0} tcp · ${state.summary.udp || 0} udp` },
      { label: "Containers", value: state.dockerAvailable ? running : "—",
        sub: state.dockerAvailable ? `${state.containers.length} total · ${state.containers.length - running} stopped` : "docker unreachable",
        accent: true },
      { label: "Outside docker", value: hostN, sub: `${unkN} unattributed` },
      { label: "Next free tcp", value: nextFree, sub: "from 8000 upward" },
    ];
  }

  function computeBands() {
    const toneMap = { container: "var(--accent)", host: "var(--ink-3)", unknown: "var(--warn)" };
    return BAND_DEFS.map(([name, lo, hi]) => {
      const inBand = state.ports.filter((r) => r.port >= lo && r.port <= hi);
      return {
        name, range: `${lo}–${hi}`, count: inBand.length,
        pct: ((inBand.length / (hi - lo + 1)) * 100).toFixed(2) + "%",
        ticks: inBand.map((r) => ({
          left: (((r.port - lo) / (hi - lo)) * 100).toFixed(2) + "%",
          color: toneMap[rowKind(r)],
          title: `${r.port}/${r.proto} (${ownerLabel(r)})`,
        })),
      };
    });
  }

  function renderOverview() {
    $("#tiles").innerHTML = computeTiles().map((t) => `
      <div class="tile ${t.accent ? "tile-accent" : ""}">
        <div class="tile-label">${t.label}</div>
        <div class="tile-value">${t.value}</div>
        <div class="tile-sub">${t.sub}</div>
      </div>
    `).join("");

    $("#bands").innerHTML = computeBands().map((b) => `
      <div>
        <div class="band-head"><span class="band-name">${b.name}</span><span class="band-range">${b.range}</span></div>
        <div class="band-track">${b.ticks.map((t) => `<span class="band-tick" style="left:${t.left};background:${t.color}" title="${escapeHtml(t.title)}"></span>`).join("")}</div>
        <div class="band-foot"><span>${b.count} bound</span><span>${b.pct} occupied</span></div>
      </div>
    `).join("");

    const countEl = $("#attn-count");
    const listEl = $("#attn-list");
    if (!state.attention.length) {
      countEl.textContent = "nothing needs attention";
      listEl.innerHTML = `<div class="attn-empty">Every socket is attributed and no stopped container holds a port.</div>`;
    } else {
      countEl.textContent = `${state.attention.length} thing${state.attention.length === 1 ? "" : "s"} worth a look`;
      listEl.innerHTML = state.attention.map((a) => `
        <div class="attn-row">
          <span class="attn-port" style="color:${a.kind === "stopped_claim" ? "var(--ink-2)" : "var(--warn)"}">${a.port}</span>
          <div>
            <div class="attn-title">${escapeHtml(a.title)}</div>
            <div class="attn-body">${escapeHtml(a.body)}</div>
          </div>
        </div>
      `).join("");
    }
  }

  /* ---------------- ports view ---------------- */

  function renderPorts() {
    const q = state.portsQ.trim().toLowerCase();
    let rows = state.ports.filter((r) => {
      if (state.portsProto !== "all" && r.proto !== state.portsProto) return false;
      if (state.portsKind !== "all" && rowKind(r) !== state.portsKind) return false;
      if (!q) return true;
      return `${r.port} ${ownerLabel(r)} ${ownerSub(r)} ${(r.addresses || []).join(" ")}`.toLowerCase().includes(q);
    });
    rows = rows.slice().sort((a, b) => {
      const d = state.sortKey === "owner"
        ? ownerLabel(a).localeCompare(ownerLabel(b))
        : (a.port - b.port) || a.proto.localeCompare(b.proto);
      return d * state.sortDir;
    });

    $("#ports-tbody").innerHTML = rows.map((r) => {
      const tone = kindTone(rowKind(r));
      return `
        <tr>
          <td class="port-num" data-label="Port">${r.port}</td>
          <td data-label="Proto"><span class="badge">${r.proto}</span></td>
          <td class="addr-col" data-label="Bind address">${(r.addresses || []).join(", ") || "—"}</td>
          <td data-label="Owner">
            <div class="owner-name">${escapeHtml(ownerLabel(r)) || "unknown"}</div>
            <div class="owner-sub">${escapeHtml(ownerSub(r))}</div>
          </td>
          <td data-label="Type" style="text-align:right"><span class="kind-badge" style="background:${tone.bg};color:${tone.fg}">${tone.label}</span></td>
        </tr>
      `;
    }).join("");

    $("#ports-empty").hidden = rows.length !== 0;
    $("#ports-empty-msg").textContent = q ? `no match for «${state.portsQ.trim()}»` : "nothing matches these filters";
    $("#ports-summary").textContent = `${rows.length} of ${state.ports.length} sockets`;

    $$("th[data-sort]").forEach((th) => {
      const on = th.dataset.sort === state.sortKey;
      th.classList.toggle("sorted", on);
      th.querySelector(".sort-arrow").textContent = on ? (state.sortDir === 1 ? "↑" : "↓") : "";
    });
  }

  /* ---------------- containers view ---------------- */

  function renderContainers() {
    if (state.dockerAvailable === false) {
      $("#containers-offline").hidden = false;
      $("#containers-online").hidden = true;
      return;
    }
    $("#containers-offline").hidden = true;
    $("#containers-online").hidden = false;

    const q = $("#containers-search").value.trim().toLowerCase();
    const list = state.containers.filter((c) => !q || `${c.name} ${c.image}`.toLowerCase().includes(q));

    if (!state.selContainer || !list.some((c) => c.name === state.selContainer)) {
      state.selContainer = list.length ? list[0].name : null;
    }

    const clistEl = $("#clist");
    if (!list.length) {
      clistEl.innerHTML = `<div class="clist-empty">${q ? `no match for «${escapeHtml(q)}»` : "no containers found"}</div>`;
    } else {
      clistEl.innerHTML = list.map((c) => `
        <button class="clist-item" data-name="${escapeHtml(c.name)}" type="button" ${c.name === state.selContainer ? 'aria-current="true"' : ""}>
          <span class="clist-dot" style="background:${c.status === "running" ? "var(--ok)" : "var(--ink-3)"}"></span>
          <span class="clist-text">
            <span class="clist-name">${escapeHtml(c.name)}</span>
            <span class="clist-image">${escapeHtml(c.image)}</span>
          </span>
          <span class="clist-count">${c.published_ports.length ? c.published_ports.length : "·"}</span>
        </button>
      `).join("");
      $$(".clist-item", clistEl).forEach((btn) => btn.addEventListener("click", () => {
        state.selContainer = btn.dataset.name;
        renderContainers();
      }));
    }

    renderContainerDetail(list.find((c) => c.name === state.selContainer));
  }

  function renderContainerDetail(c) {
    const el = $("#container-detail");
    if (!c) { el.innerHTML = ""; return; }

    const boundTcp = new Set(state.ports.filter((r) => r.proto === "tcp" && r.owner_type === "container").map((r) => r.port));
    const boundUdp = new Set(state.ports.filter((r) => r.proto === "udp" && r.owner_type === "container").map((r) => r.port));

    const pubHtml = c.published_ports.length ? c.published_ports.map((p) => {
      const live = (p.proto === "tcp" ? boundTcp : boundUdp).has(p.host_port) && c.status === "running";
      return `
        <div class="pub-row">
          <span class="pub-host">${p.host_port}</span>
          <span class="pub-arrow">→</span>
          <span class="pub-cport">:${p.container_port}</span>
          <span class="badge">${p.proto}</span>
          <span class="pub-state" style="color:${live ? "var(--ok)" : "var(--warn)"}">${live ? "listening" : "not bound"}</span>
        </div>
      `;
    }).join("") : `<div class="detail-empty">no host ports published</div>`;

    const intHtml = c.internal_ports.length
      ? `<div class="int-chips">${c.internal_ports.map((i) => `<span class="chip">:${i.container_port}/${i.proto}</span>`).join("")}</div>`
      : `<span style="font-family:var(--ff-mono);font-size:12.5px;color:var(--ink-3)">none</span>`;

    const note = c.status === "running"
      ? "Published ports are cross-referenced against the live socket table, so a binding Docker reports but the kernel never opened shows as not bound."
      : "Stopped containers keep their port bindings in Docker’s config. The ports read as free right now, but will collide the moment this container restarts.";

    el.innerHTML = `
      <div class="detail-card">
        <div class="detail-head">
          <div class="detail-head-row">
            <h2 class="detail-name">${escapeHtml(c.name)}</h2>
            <span class="status-badge" style="background:${c.status === "running" ? "var(--ok-wash)" : "var(--line-2)"};color:${c.status === "running" ? "var(--ok)" : "var(--ink-2)"}">${escapeHtml(c.status)}</span>
          </div>
          <div class="detail-image">${escapeHtml(c.image)}</div>
        </div>
        <div class="detail-meta">
          <div class="detail-meta-cell"><div class="detail-meta-k">Container id</div><div class="detail-meta-v">${escapeHtml(c.id)}</div></div>
          <div class="detail-meta-cell"><div class="detail-meta-k">Network</div><div class="detail-meta-v">${escapeHtml(c.network)}</div></div>
          <div class="detail-meta-cell"><div class="detail-meta-k">Uptime</div><div class="detail-meta-v">${c.uptime ? escapeHtml(c.uptime) : "—"}</div></div>
          <div class="detail-meta-cell"><div class="detail-meta-k">Bindings</div><div class="detail-meta-v">${c.published_ports.length} pub · ${c.internal_ports.length} int</div></div>
        </div>
        <div class="detail-section">
          <div class="detail-section-title">Published ports</div>
          ${pubHtml}
        </div>
        <div class="detail-section" style="padding-top:0">
          <div class="detail-section-title">Internal only</div>
          ${intHtml}
          <div class="detail-note">${escapeHtml(note)}</div>
        </div>
      </div>
    `;
  }

  /* ---------------- quick check / free port finder ---------------- */

  function resultBox(tone, headline, tag, bodyHtml) {
    const color = { bad: "var(--bad)", warn: "var(--warn)", ok: "var(--ok)" }[tone];
    const wash = { bad: "var(--bad-wash)", warn: "var(--warn-wash)", ok: "var(--ok-wash)" }[tone];
    return `
      <div class="result-box" style="background:${wash};border-color:${color}">
        <div class="head"><span class="headline" style="color:${color}">${escapeHtml(headline)}</span><span class="tag">${escapeHtml(tag)}</span></div>
        <div class="body">${bodyHtml}</div>
      </div>
    `;
  }

  async function runCheck(prefix) {
    const input = $(`#${prefix}-check-port`);
    const port = parseInt(input.value, 10);
    const proto = state[`${prefix}CheckProto`];
    const resultEl = $(`#${prefix}-check-result`);
    if (!port || port < 1 || port > 65535) {
      resultEl.innerHTML = resultBox("bad", "Invalid", "", "Enter a port between 1 and 65535.");
      return;
    }
    try {
      const data = await fetchJSON(`/api/check/${port}?proto=${proto}`);
      if (data.in_use) {
        const parts = data.matches.map((m) => `${escapeHtml(ownerLabel(m))} (${escapeHtml(ownerSub(m))})`).join("; ");
        const addr = escapeHtml((data.matches[0].addresses || []).join(", "));
        resultEl.innerHTML = resultBox("bad", "In use", `${port}/${proto}`, `${parts}, bound on ${addr}.`);
      } else if (data.claimed_by) {
        resultEl.innerHTML = resultBox("warn", "Free, but claimed", `${port}/${proto}`,
          `Nothing is listening, but the stopped container ${escapeHtml(data.claimed_by.container)} still holds this binding and will take it back on restart.`);
      } else {
        resultEl.innerHTML = resultBox("ok", "Free", `${port}/${proto}`, "No host socket and no container binding. Safe to publish.");
      }
    } catch (err) {
      resultEl.textContent = `Error: ${err.message}`;
    }
  }

  async function runFind(prefix, protoOverride) {
    const start = $(`#${prefix}-range-start`).value || 8000;
    const end = $(`#${prefix}-range-end`).value || 9000;
    const proto = protoOverride || state[`${prefix}RangeProto`] || "tcp";
    const resultEl = $(`#${prefix}-find-result`);
    resultEl.textContent = "Searching…";
    try {
      const data = await fetchJSON(`/api/free-ports?start=${start}&end=${end}&proto=${proto}&limit=10`);
      if (data.error) { resultEl.textContent = `Error: ${data.error}`; return; }
      if (!data.free_ports.length) {
        resultEl.innerHTML = `<div class="free-warn">No free ports found in that range.</div>`;
        return;
      }
      let html = `<div class="free-pills">${data.free_ports.map((p) => `<span class="free-pill">${p}</span>`).join("")}</div>`;
      if (data.claimed && data.claimed.length) {
        const list = data.claimed.map((c) => `${c.port} (${escapeHtml(c.container)})`).join(", ");
        html += `<div class="free-warn">Also free right now but claimed by stopped containers: ${list}.</div>`;
      }
      resultEl.innerHTML = html;
    } catch (err) {
      resultEl.textContent = `Error: ${err.message}`;
    }
  }

  /* ---------------- refresh cycle ---------------- */

  function showScanning(on) {
    $("#sweep-bar").hidden = !on;
    $("#rescan-btn").textContent = on ? "Scanning" : "Rescan";
  }

  async function refresh() {
    if (state.refreshInFlight) return;
    state.refreshInFlight = true;
    showScanning(true);
    try {
      const [portsData, containersData, attnData, hostData] = await Promise.all([
        fetchJSON("/api/ports"),
        fetchJSON("/api/containers"),
        fetchJSON("/api/attention"),
        fetchJSON("/api/host"),
      ]);

      $("#fetch-error-banner").hidden = true;
      state.dockerAvailable = portsData.docker_available;
      $("#offline-banner").hidden = portsData.docker_available;

      state.ports = portsData.ports;
      state.summary = portsData.summary;
      state.scanMs = portsData.scan_ms;
      state.containers = containersData.containers;
      state.attention = attnData.items;
      state.host = hostData;

      $("#scan-at").textContent = fmtTime(new Date());
      renderNav();
      renderHostMeta();
      renderCurrentView();
    } catch (err) {
      const banner = $("#fetch-error-banner");
      banner.hidden = false;
      banner.innerHTML = `<span class="mark">!</span><div><strong>Couldn’t reach the server</strong><p>${escapeHtml(err.message)}. Retrying automatically.</p></div>`;
    } finally {
      state.refreshInFlight = false;
      showScanning(false);
    }
  }

  /* ---------------- wiring ---------------- */

  function setupSegmented(target, onSelect) {
    const group = $(`.segmented[data-target="${target}"]`);
    if (!group) return;
    $$(".segmented-opt", group).forEach((opt) => {
      opt.addEventListener("click", () => {
        $$(".segmented-opt", group).forEach((o) => o.setAttribute("aria-pressed", "false"));
        opt.setAttribute("aria-pressed", "true");
        onSelect(opt.dataset.value);
      });
    });
  }

  function resetSegmented(target, value) {
    const group = $(`.segmented[data-target="${target}"]`);
    if (!group) return;
    $$(".segmented-opt", group).forEach((o) => o.setAttribute("aria-pressed", String(o.dataset.value === value)));
  }

  document.addEventListener("DOMContentLoaded", () => {
    loadPreferences();
    applyTheme();
    $("#auto-refresh-toggle").querySelector(".switch-track").dataset.on = String(state.autoRefresh);
    $("#auto-refresh-toggle").setAttribute("aria-pressed", String(state.autoRefresh));

    renderNav();
    switchView("overview");

    setupSegmented("ov-check-proto", (v) => { state.ovCheckProto = v; });
    setupSegmented("tl-check-proto", (v) => { state.tlCheckProto = v; });
    setupSegmented("tl-range-proto", (v) => { state.tlRangeProto = v; });
    setupSegmented("ports-proto", (v) => { state.portsProto = v; renderPorts(); });
    setupSegmented("ports-kind", (v) => { state.portsKind = v; renderPorts(); });

    $("#ports-search").addEventListener("input", debounce((e) => {
      state.portsQ = e.target.value;
      renderPorts();
    }, 150));
    $$("th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (state.sortKey === key) state.sortDir *= -1;
        else { state.sortKey = key; state.sortDir = 1; }
        renderPorts();
      });
    });
    $("#ports-clear-btn").addEventListener("click", () => {
      state.portsQ = ""; state.portsProto = "all"; state.portsKind = "all";
      $("#ports-search").value = "";
      resetSegmented("ports-proto", "all");
      resetSegmented("ports-kind", "all");
      renderPorts();
    });

    $("#containers-search").addEventListener("input", debounce(renderContainers, 150));

    $("#ov-check-btn").addEventListener("click", () => runCheck("ov"));
    $("#ov-check-port").addEventListener("keydown", (e) => { if (e.key === "Enter") runCheck("ov"); });
    $("#ov-find-btn").addEventListener("click", () => runFind("ov", "tcp"));

    $("#tl-check-btn").addEventListener("click", () => runCheck("tl"));
    $("#tl-check-port").addEventListener("keydown", (e) => { if (e.key === "Enter") runCheck("tl"); });
    $("#tl-find-btn").addEventListener("click", () => runFind("tl"));

    $("#rescan-btn").addEventListener("click", refresh);
    $("#auto-refresh-toggle").addEventListener("click", () => setAutoRefresh(!state.autoRefresh));
    $("#theme-toggle").addEventListener("click", toggleTheme);

    refresh();
    scheduleAutoRefresh();
  });
})();
