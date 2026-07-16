(() => {
  const state = {
    ports: [],
    containers: [],
    sort: { key: "port", dir: 1 },
    containerSort: { key: "name", dir: 1 },
    autoRefresh: true,
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function fmtTime(d) {
    return d.toLocaleTimeString([], { hour12: false });
  }

  function ownerLabel(row) {
    if (row.owner_type === "container") {
      return row.owners.map((o) => o.container).join(", ");
    }
    return row.owners.map((o) => o.process || "unknown").join(", ");
  }

  function detailLabel(row) {
    if (row.owner_type === "container") {
      return row.owners
        .map((o) => `${o.image || ""} → :${o.container_port}`.trim())
        .join("; ");
    }
    return row.owners
      .map((o) => (o.pid ? `pid ${o.pid}` : ""))
      .filter(Boolean)
      .join(", ");
  }

  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
  }

  async function refresh() {
    const btn = $("#refresh-btn");
    btn.disabled = true;
    try {
      const [portsData, containersData] = await Promise.all([
        fetchJSON("/api/ports"),
        fetchJSON("/api/containers"),
      ]);

      state.ports = portsData.ports;
      state.containers = containersData.containers;

      const warn = $("#docker-warning");
      if (!portsData.docker_available) {
        warn.textContent = `Docker info unavailable: ${portsData.docker_error}. Showing host ports only.`;
        warn.classList.remove("hidden");
      } else {
        warn.classList.add("hidden");
      }

      renderStats(portsData.summary);
      renderPortsTable();
      renderContainersTable();
      $("#last-updated").textContent = `Updated ${fmtTime(new Date())}`;
    } catch (err) {
      $("#last-updated").textContent = `Error: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  }

  function renderStats(summary) {
    const cards = [
      { label: "Listening ports", value: summary.total },
      { label: "TCP", value: summary.tcp },
      { label: "UDP", value: summary.udp },
      { label: "Used by containers", value: summary.by_container },
      { label: "Used by host", value: summary.by_host },
      { label: "Containers running", value: `${summary.containers_running}/${summary.containers_total}` },
    ];
    $("#stats").innerHTML = cards
      .map((c) => `<div class="stat-card"><div class="value">${c.value}</div><div class="label">${c.label}</div></div>`)
      .join("");
  }

  function matchesFilter(row, q) {
    if (!q) return true;
    q = q.toLowerCase();
    const haystack = [
      row.port,
      row.proto,
      ownerLabel(row),
      detailLabel(row),
      ...(row.addresses || []),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  }

  function renderPortsTable() {
    const q = $("#ports-search").value.trim();
    let rows = state.ports.filter((r) => matchesFilter(r, q));

    const { key, dir } = state.sort;
    rows = rows.slice().sort((a, b) => {
      let av, bv;
      if (key === "owner") { av = ownerLabel(a); bv = ownerLabel(b); }
      else if (key === "detail") { av = detailLabel(a); bv = detailLabel(b); }
      else if (key === "address") { av = (a.addresses || []).join(); bv = (b.addresses || []).join(); }
      else { av = a[key]; bv = b[key]; }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });

    const tbody = $("#ports-table tbody");
    if (!rows.length) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="6">No listening ports match.</td></tr>`;
      return;
    }

    tbody.innerHTML = rows
      .map((r) => `
        <tr>
          <td class="port-num">${r.port}</td>
          <td><span class="badge badge-${r.proto}">${r.proto}</span></td>
          <td><span class="badge badge-${r.owner_type}">${r.owner_type === "container" ? "Docker" : "Host"}</span></td>
          <td>${escapeHtml(ownerLabel(r)) || "<span class=\"mono\">unknown</span>"}</td>
          <td class="mono">${escapeHtml(detailLabel(r))}</td>
          <td class="mono">${(r.addresses || []).join(", ") || "—"}</td>
        </tr>
      `)
      .join("");
  }

  function renderContainersTable() {
    const q = $("#containers-search").value.trim().toLowerCase();
    let rows = state.containers.filter((c) => {
      if (!q) return true;
      return `${c.name} ${c.image}`.toLowerCase().includes(q);
    });

    const { key, dir } = state.containerSort;
    rows = rows.slice().sort((a, b) => {
      let av = a[key], bv = b[key];
      if (typeof av === "string") { av = av.toLowerCase(); bv = bv.toLowerCase(); }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });

    const tbody = $("#containers-table tbody");
    if (!rows.length) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="5">No containers found.</td></tr>`;
      return;
    }

    tbody.innerHTML = rows
      .map((c) => {
        const published = c.published_ports
          .map((p) => `<span class="badge badge-${p.proto}">${p.host_port}→${p.container_port}/${p.proto}</span>`)
          .join(" ") || "—";
        const internal = c.internal_ports
          .map((p) => `<span class="mono">${p.container_port}/${p.proto}</span>`)
          .join(", ") || "—";
        const statusClass = c.status === "running" ? "badge-container" : "badge-host";
        return `
          <tr>
            <td><strong>${escapeHtml(c.name)}</strong></td>
            <td class="mono">${escapeHtml(c.image)}</td>
            <td><span class="badge ${statusClass}">${c.status}</span></td>
            <td>${published}</td>
            <td>${internal}</td>
          </tr>
        `;
      })
      .join("");
  }

  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  async function checkPort() {
    const portInput = $("#check-port-input");
    const port = parseInt(portInput.value, 10);
    const proto = $("#check-proto").value;
    const resultEl = $("#check-result");
    if (!port || port < 1 || port > 65535) {
      resultEl.innerHTML = `<span class="pill pill-used">Enter a valid port (1-65535)</span>`;
      return;
    }
    try {
      const data = await fetchJSON(`/api/check/${port}?proto=${proto}`);
      if (!data.in_use) {
        resultEl.innerHTML = `<span class="pill pill-free">Port ${port}/${proto} is free</span>`;
      } else {
        const owners = data.matches
          .map((m) => (m.owner_type === "container" ? ownerLabel(m) : ownerLabel(m)))
          .join(", ");
        resultEl.innerHTML = `<span class="pill pill-used">Port ${port}/${proto} is in use</span> by <strong>${escapeHtml(owners)}</strong>`;
      }
    } catch (err) {
      resultEl.textContent = `Error: ${err.message}`;
    }
  }

  async function findFreePorts() {
    const start = $("#range-start").value || 8000;
    const end = $("#range-end").value || 9000;
    const proto = $("#range-proto").value;
    const resultEl = $("#free-ports-result");
    resultEl.textContent = "Searching...";
    try {
      const data = await fetchJSON(`/api/free-ports?start=${start}&end=${end}&proto=${proto}&limit=15`);
      if (data.error) {
        resultEl.textContent = `Error: ${data.error}`;
        return;
      }
      if (!data.free_ports.length) {
        resultEl.textContent = "No free ports found in that range.";
        return;
      }
      resultEl.innerHTML = data.free_ports.map((p) => `<span class="pill">${p}</span>`).join(" ");
    } catch (err) {
      resultEl.textContent = `Error: ${err.message}`;
    }
  }

  function setupTabs() {
    $$(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        $$(".tab").forEach((t) => t.classList.remove("active"));
        $$(".tab-panel").forEach((p) => p.classList.remove("active"));
        tab.classList.add("active");
        $(`#panel-${tab.dataset.tab}`).classList.add("active");
      });
    });
  }

  function setupSorting() {
    $$("#ports-table thead th").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (state.sort.key === key) state.sort.dir *= -1;
        else state.sort = { key, dir: 1 };
        renderPortsTable();
      });
    });
    $$("#containers-table thead th").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (state.containerSort.key === key) state.containerSort.dir *= -1;
        else state.containerSort = { key, dir: 1 };
        renderContainersTable();
      });
    });
  }

  let refreshTimer = null;
  function scheduleAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    if (state.autoRefresh) {
      refreshTimer = setInterval(refresh, 10000);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    setupTabs();
    setupSorting();
    $("#refresh-btn").addEventListener("click", refresh);
    $("#check-port-btn").addEventListener("click", checkPort);
    $("#check-port-input").addEventListener("keydown", (e) => { if (e.key === "Enter") checkPort(); });
    $("#find-free-btn").addEventListener("click", findFreePorts);
    $("#ports-search").addEventListener("input", renderPortsTable);
    $("#containers-search").addEventListener("input", renderContainersTable);
    $("#auto-refresh").addEventListener("change", (e) => {
      state.autoRefresh = e.target.checked;
      scheduleAutoRefresh();
    });

    refresh();
    scheduleAutoRefresh();
  });
})();
