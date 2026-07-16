(() => {
  const ROWS_PAGE_SIZE = 10;
  const gsapAvailable = typeof window.gsap !== "undefined";
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const animationsEnabled = gsapAvailable && !prefersReducedMotion;

  const state = {
    ports: [],
    containers: [],
    sort: { key: "port", dir: 1 },
    checkProto: "tcp",
    rangeProto: "tcp",
    autoRefresh: true,
    firstRender: true,
    refreshInFlight: false,
    collapsedGroups: new Set(["ports-container", "ports-host"]), // port groups collapsed by default, same as container cards
    collapsedContainers: new Set(),      // container cards collapsed by name (default: all, filled in on first render)
    knownContainerNames: new Set(),      // names seen so far, so newly-appeared containers also default to collapsed
    visibleCounts: {},                   // group key -> how many rows currently shown
    statValues: {},                      // stat key -> last rendered numeric value, for count-up deltas
    lastPortsSignature: null,
    lastContainersSignature: null,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function fmtTime(d) {
    return d.toLocaleTimeString([], { hour12: false });
  }

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

  /* ---------------- preferences (persisted across visits) ---------------- */

  const PREF_KEYS = { autoRefresh: "pc_autoRefresh", activeTab: "pc_activeTab" };

  function loadPreferences() {
    try {
      const storedAutoRefresh = localStorage.getItem(PREF_KEYS.autoRefresh);
      if (storedAutoRefresh !== null) state.autoRefresh = storedAutoRefresh === "1";
      return { activeTab: localStorage.getItem(PREF_KEYS.activeTab) };
    } catch {
      return {}; // localStorage can throw in locked-down/private-browsing contexts
    }
  }

  function savePreference(key, value) {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  }

  /* ---------------- refresh cycle ---------------- */

  async function refresh() {
    if (state.refreshInFlight) return;
    state.refreshInFlight = true;
    const btn = $("#refresh-btn");
    btn.disabled = true;
    try {
      const [portsData, containersData] = await Promise.all([
        fetchJSON("/api/ports"),
        fetchJSON("/api/containers"),
      ]);

      $("#fetch-error-banner").classList.add("hidden");

      const warn = $("#docker-warning");
      if (!portsData.docker_available) {
        warn.textContent = `Docker info unavailable: ${portsData.docker_error}. Showing host ports only.`;
        warn.classList.remove("hidden");
      } else {
        warn.classList.add("hidden");
      }

      // Newly-appeared containers default to collapsed, same as on first
      // load; containers the user has already toggled keep their state.
      containersData.containers.forEach((c) => {
        if (!state.knownContainerNames.has(c.name)) {
          state.knownContainerNames.add(c.name);
          state.collapsedContainers.add(c.name);
        }
      });

      // Auto-refresh fires every 10s regardless of whether anything on the
      // host actually changed. Rebuilding the DOM (and replaying entrance
      // animations) on every tick was a periodic jank source — skip the
      // rebuild entirely when the fetched data is byte-for-byte the same as
      // last time, which is the common case on a quiet box.
      const portsSignature = JSON.stringify(portsData.ports);
      const portsChanged = portsSignature !== state.lastPortsSignature;
      state.lastPortsSignature = portsSignature;
      state.ports = portsData.ports;

      const containersSignature = JSON.stringify(containersData.containers);
      const containersChanged = containersSignature !== state.lastContainersSignature;
      state.lastContainersSignature = containersSignature;
      state.containers = containersData.containers;

      renderStats(portsData.summary);
      if (portsChanged || state.firstRender) renderPortGroups();
      if (containersChanged || state.firstRender) renderContainerGroups();
      $("#last-updated").textContent = `Updated ${fmtTime(new Date())}`;

      if (state.firstRender) {
        state.firstRender = false;
        playEntrance();
      }
    } catch (err) {
      const banner = $("#fetch-error-banner");
      banner.textContent = `Couldn't reach the server (${err.message}). Retrying automatically...`;
      banner.classList.remove("hidden");
      $("#last-updated").textContent = `Error at ${fmtTime(new Date())}`;
    } finally {
      btn.disabled = false;
      state.refreshInFlight = false;
    }
  }

  function playEntrance() {
    if (!animationsEnabled) return;
    gsap.set([".hero-title", ".hero-sub", ".stat-card", ".tool-card", ".table-card"], { clearProps: "opacity,transform" });
    const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
    tl.from(".hero-title", { y: 24, opacity: 0, duration: 0.6 })
      .from(".hero-sub", { y: 16, opacity: 0, duration: 0.5 }, "-=0.4")
      .from(".stat-card", { y: 18, opacity: 0, duration: 0.5, stagger: 0.06 }, "-=0.25")
      .from(".tool-card", { y: 18, opacity: 0, duration: 0.5, stagger: 0.08 }, "-=0.3")
      .from(".table-card", { y: 18, opacity: 0, duration: 0.5 }, "-=0.3");
  }

  /* ---------------- stats ---------------- */

  function renderStats(summary) {
    const cards = [
      { key: "total", label: "Listening ports", value: summary.total },
      { key: "tcp", label: "TCP", value: summary.tcp },
      { key: "udp", label: "UDP", value: summary.udp },
      { key: "by_container", label: "Used by containers", value: summary.by_container },
      { key: "by_host", label: "Used by host", value: summary.by_host },
      { key: "containers_running", label: "Containers running", value: summary.containers_running, suffix: `/${summary.containers_total}` },
    ];

    const container = $("#stats");
    if (!container.children.length) {
      container.innerHTML = cards
        .map((c) => `
          <div class="stat-card">
            <div class="value" data-key="${c.key}">0${c.suffix ? c.suffix : ""}</div>
            <div class="label">${c.label}</div>
          </div>
        `)
        .join("");
    }

    cards.forEach((c) => {
      const el = container.querySelector(`.value[data-key="${c.key}"]`);
      const from = state.statValues[c.key] ?? 0;
      const to = c.value;
      state.statValues[c.key] = to;
      if (from === to) return;
      if (animationsEnabled) {
        const proxy = { v: from };
        gsap.to(proxy, {
          v: to,
          duration: 0.6,
          ease: "power2.out",
          onUpdate: () => {
            el.textContent = `${Math.round(proxy.v)}${c.suffix ?? ""}`;
          },
        });
      } else {
        el.textContent = `${to}${c.suffix ?? ""}`;
      }
    });
  }

  /* ---------------- collapsible primitive ---------------- */

  function setCollapsed(rootEl, bodyEl, collapsed, animate) {
    const header = rootEl.querySelector("[data-toggle], [data-toggle-container]");
    if (header) header.setAttribute("aria-expanded", String(!collapsed));

    if (collapsed) {
      rootEl.classList.add("collapsed");
      if (animate && animationsEnabled) {
        gsap.to(bodyEl, {
          height: 0, duration: 0.32, ease: "power2.inOut",
          onComplete: () => { bodyEl.style.display = "none"; },
        });
      } else {
        bodyEl.style.display = "none";
        bodyEl.style.height = "0px";
      }
    } else {
      rootEl.classList.remove("collapsed");
      bodyEl.style.display = "";
      const target = bodyEl.scrollHeight;
      if (animate && animationsEnabled) {
        gsap.fromTo(bodyEl, { height: 0 }, {
          height: target, duration: 0.36, ease: "power2.inOut",
          onComplete: () => { bodyEl.style.height = "auto"; },
        });
      } else {
        bodyEl.style.height = "auto";
      }
    }
  }

  function wireKeyboardToggle(header) {
    header.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        header.click();
      }
    });
  }

  /* ---------------- ports tab (grouped by owner type) ---------------- */

  function matchesFilter(row, q) {
    if (!q) return true;
    q = q.toLowerCase();
    const haystack = [row.port, row.proto, ownerLabel(row), detailLabel(row), ...(row.addresses || [])]
      .join(" ").toLowerCase();
    return haystack.includes(q);
  }

  function sortRows(rows) {
    const { key, dir } = state.sort;
    return rows.slice().sort((a, b) => {
      let av, bv;
      if (key === "owner") { av = ownerLabel(a); bv = ownerLabel(b); }
      else if (key === "detail") { av = detailLabel(a); bv = detailLabel(b); }
      else if (key === "address") { av = (a.addresses || []).join(); bv = (b.addresses || []).join(); }
      else { av = a[key]; bv = b[key]; }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }

  const PORT_GROUPS = [
    { key: "container", title: "Docker Containers", iconClass: "group-icon-container", icon: "▣" },
    { key: "host", title: "Host Services", iconClass: "group-icon-host", icon: "⌂" },
  ];

  function renderPortGroups() {
    const q = $("#ports-search").value.trim();
    const filtered = state.ports.filter((r) => matchesFilter(r, q));
    const containerEl = $("#groups-ports");
    const isFirstBuild = !containerEl.dataset.built;

    containerEl.innerHTML = PORT_GROUPS.map((g) => {
      const rows = sortRows(filtered.filter((r) => r.owner_type === g.key));
      const groupKey = `ports-${g.key}`;
      if (!(groupKey in state.visibleCounts) || q !== containerEl.dataset.lastQuery) {
        state.visibleCounts[groupKey] = ROWS_PAGE_SIZE;
      }
      const visibleCount = state.visibleCounts[groupKey];
      const visibleRows = rows.slice(0, visibleCount);
      const collapsed = state.collapsedGroups.has(groupKey);

      const tableHtml = rows.length === 0
        ? `<div class="group-empty">No ${g.title.toLowerCase()} match.</div>`
        : `
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th data-sort="port">Port</th>
                  <th data-sort="proto">Proto</th>
                  <th data-sort="owner">Owner</th>
                  <th data-sort="detail">Detail</th>
                  <th data-sort="address">Bound address</th>
                </tr>
              </thead>
              <tbody>
                ${visibleRows.map((r) => `
                  <tr>
                    <td class="port-num" data-label="Port">${r.port}</td>
                    <td data-label="Proto"><span class="badge badge-${r.proto}">${r.proto}</span></td>
                    <td data-label="Owner">${escapeHtml(ownerLabel(r)) || '<span class="mono">unknown</span>'}</td>
                    <td class="mono" data-label="Detail">${escapeHtml(detailLabel(r))}</td>
                    <td class="mono" data-label="Bound address">${(r.addresses || []).join(", ") || "—"}</td>
                  </tr>
                `).join("")}
                ${rows.length > visibleCount ? `
                  <tr class="show-more-row">
                    <td colspan="5">
                      <button class="show-more-btn" data-group="${groupKey}">
                        Show ${Math.min(20, rows.length - visibleCount)} more (${rows.length - visibleCount} hidden)
                      </button>
                    </td>
                  </tr>
                ` : ""}
              </tbody>
            </table>
          </div>
        `;

      return `
        <div class="group ${collapsed ? "collapsed" : ""}" data-group="${groupKey}">
          <div class="group-header" data-toggle="${groupKey}" role="button" tabindex="0" aria-expanded="${!collapsed}">
            <span class="group-icon ${g.iconClass}">${g.icon}</span>
            <span class="group-title">${g.title}</span>
            <span class="group-count">${rows.length}</span>
            <svg class="group-chevron" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
          </div>
          <div class="group-body">${tableHtml}</div>
        </div>
      `;
    }).join("");

    containerEl.dataset.built = "1";
    containerEl.dataset.lastQuery = q;

    // bodies start expanded in the DOM; instantly hide the ones that should be collapsed (no animation on rebuild)
    $$(".group", containerEl).forEach((groupEl) => {
      const key = groupEl.dataset.group;
      const body = $(".group-body", groupEl);
      if (state.collapsedGroups.has(key)) {
        body.style.display = "none";
      } else {
        body.style.height = "auto";
      }
    });

    wireGroupToggles(containerEl, state.collapsedGroups);
    wireSortHeaders(containerEl, renderPortGroups);
    wireShowMore(containerEl, (key) => {
      state.visibleCounts[key] = (state.visibleCounts[key] || ROWS_PAGE_SIZE) + 20;
      renderPortGroups();
    });

    if (!isFirstBuild && animationsEnabled) {
      gsap.from($$(".group", containerEl), { opacity: 0, y: 8, duration: 0.3, stagger: 0.04, overwrite: "auto" });
    }
  }

  function wireGroupToggles(root, collapsedSet) {
    $$("[data-toggle]", root).forEach((header) => {
      header.addEventListener("click", () => {
        const key = header.dataset.toggle;
        const groupEl = header.closest("[data-group]");
        const body = $(".group-body", groupEl);
        const collapsed = !collapsedSet.has(key);
        if (collapsed) collapsedSet.add(key); else collapsedSet.delete(key);
        setCollapsed(groupEl, body, collapsed, true);
      });
      wireKeyboardToggle(header);
    });
  }

  function wireShowMore(root, onClick) {
    $$(".show-more-btn", root).forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick(btn.dataset.group);
      });
    });
  }

  function wireSortHeaders(root, rerender) {
    $$("thead th[data-sort]", root).forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (state.sort.key === key) state.sort.dir *= -1;
        else state.sort = { key, dir: 1 };
        rerender();
      });
    });
  }

  /* ---------------- containers tab (accordion cards) ---------------- */

  function renderContainerGroups() {
    const q = $("#containers-search").value.trim().toLowerCase();
    const rows = state.containers.filter((c) => !q || `${c.name} ${c.image}`.toLowerCase().includes(q));
    const containerEl = $("#groups-containers");
    const isFirstBuild = !containerEl.dataset.built;

    if (!rows.length) {
      containerEl.innerHTML = `<div class="group-empty">No containers found.</div>`;
      containerEl.dataset.built = "1";
      return;
    }

    containerEl.innerHTML = rows.map((c) => {
      const collapsed = state.collapsedContainers.has(c.name);
      const statusClass = c.status === "running" ? "badge-container" : "badge-host";
      const published = c.published_ports
        .map((p) => `<span class="chip">${p.host_port} → ${p.container_port}/${p.proto}</span>`)
        .join("") || `<span class="chip">none</span>`;
      const internal = c.internal_ports
        .map((p) => `<span class="chip">${p.container_port}/${p.proto}</span>`)
        .join("") || `<span class="chip">none</span>`;

      return `
        <div class="container-card ${collapsed ? "collapsed" : ""}" data-container="${escapeHtml(c.name)}">
          <div class="container-header" data-toggle-container="${escapeHtml(c.name)}" role="button" tabindex="0" aria-expanded="${!collapsed}">
            <svg class="group-chevron" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
            <div class="container-meta">
              <div class="container-name">${escapeHtml(c.name)}</div>
              <div class="container-image">${escapeHtml(c.image)}</div>
            </div>
            <span class="badge ${statusClass}">${c.status}</span>
            <span class="group-count">${c.published_ports.length} published</span>
          </div>
          <div class="container-body">
            <div class="port-chip-row">
              <div class="chip-label">Published to host</div>
              <div class="chip-list">${published}</div>
            </div>
            <div class="port-chip-row">
              <div class="chip-label">Internal only</div>
              <div class="chip-list">${internal}</div>
            </div>
          </div>
        </div>
      `;
    }).join("");

    containerEl.dataset.built = "1";

    $$(".container-card", containerEl).forEach((cardEl) => {
      const body = $(".container-body", cardEl);
      const name = cardEl.dataset.container;
      if (state.collapsedContainers.has(name)) {
        body.style.display = "none";
      } else {
        body.style.height = "auto";
      }
    });

    $$("[data-toggle-container]", containerEl).forEach((header) => {
      header.addEventListener("click", () => {
        const name = header.dataset.toggleContainer;
        const cardEl = header.closest("[data-container]");
        const body = $(".container-body", cardEl);
        const collapsed = !state.collapsedContainers.has(name);
        if (collapsed) state.collapsedContainers.add(name); else state.collapsedContainers.delete(name);
        setCollapsed(cardEl, body, collapsed, true);
      });
      wireKeyboardToggle(header);
    });

    if (!isFirstBuild && animationsEnabled) {
      gsap.from($$(".container-card", containerEl), { opacity: 0, y: 8, duration: 0.3, stagger: 0.03, overwrite: "auto" });
    }
  }

  /* ---------------- collapse-all / expand-all ---------------- */

  function toggleAllForActiveTab() {
    const activeTab = $(".tab.active").dataset.tab;
    const btn = $("#toggle-all-btn");

    if (activeTab === "ports") {
      const shouldCollapse = state.collapsedGroups.size < PORT_GROUPS.length;
      PORT_GROUPS.forEach((g) => {
        const key = `ports-${g.key}`;
        if (shouldCollapse) state.collapsedGroups.add(key); else state.collapsedGroups.delete(key);
      });
      $$("#groups-ports .group").forEach((groupEl) => {
        const body = $(".group-body", groupEl);
        setCollapsed(groupEl, body, shouldCollapse, true);
      });
      btn.textContent = shouldCollapse ? "Expand all" : "Collapse all";
    } else {
      const names = state.containers.map((c) => c.name);
      const shouldCollapse = state.collapsedContainers.size < names.length;
      names.forEach((n) => {
        if (shouldCollapse) state.collapsedContainers.add(n); else state.collapsedContainers.delete(n);
      });
      $$("#groups-containers .container-card").forEach((cardEl) => {
        const body = $(".container-body", cardEl);
        setCollapsed(cardEl, body, shouldCollapse, true);
      });
      btn.textContent = shouldCollapse ? "Expand all" : "Collapse all";
    }
  }

  function syncToggleAllLabel() {
    const activeTab = $(".tab.active").dataset.tab;
    const btn = $("#toggle-all-btn");
    if (activeTab === "ports") {
      btn.textContent = state.collapsedGroups.size >= PORT_GROUPS.length ? "Expand all" : "Collapse all";
    } else {
      const total = state.containers.length;
      btn.textContent = total && state.collapsedContainers.size >= total ? "Expand all" : "Collapse all";
    }
  }

  /* ---------------- quick check / free port finder ---------------- */

  async function checkPort() {
    const portInput = $("#check-port-input");
    const port = parseInt(portInput.value, 10);
    const proto = state.checkProto;
    const resultEl = $("#check-result");
    if (!port || port < 1 || port > 65535) {
      resultEl.innerHTML = `<span class="pill pill-used">Enter a valid port (1-65535)</span>`;
      return;
    }
    try {
      const data = await fetchJSON(`/api/check/${port}?proto=${proto}`);
      let html;
      if (!data.in_use) {
        html = `<span class="pill pill-free">Port ${port}/${proto} is free</span>`;
      } else {
        const owners = data.matches.map((m) => ownerLabel(m)).join(", ");
        html = `<span class="pill pill-used">Port ${port}/${proto} is in use</span> by <strong>${escapeHtml(owners)}</strong>`;
      }
      resultEl.innerHTML = html;
      if (animationsEnabled) gsap.from(resultEl.firstElementChild, { opacity: 0, y: -6, duration: 0.3 });
    } catch (err) {
      resultEl.textContent = `Error: ${err.message}`;
    }
  }

  const FREE_PORTS_FETCH_LIMIT = 100;

  async function findFreePorts() {
    const start = $("#range-start").value || 8000;
    const end = $("#range-end").value || 9000;
    const proto = state.rangeProto;
    const resultEl = $("#free-ports-result");
    resultEl.textContent = "Searching...";
    try {
      const data = await fetchJSON(`/api/free-ports?start=${start}&end=${end}&proto=${proto}&limit=${FREE_PORTS_FETCH_LIMIT}`);
      if (data.error) { resultEl.textContent = `Error: ${data.error}`; return; }
      if (!data.free_ports.length) { resultEl.textContent = "No free ports found in that range."; return; }
      const truncated = data.free_ports.length >= FREE_PORTS_FETCH_LIMIT;
      resultEl.innerHTML = `
        <div class="pill-strip">${data.free_ports.map((p) => `<span class="pill">${p}</span>`).join("")}</div>
        ${truncated ? `<div class="pill-strip-note">Showing the first ${FREE_PORTS_FETCH_LIMIT} — narrow the range for a shorter list.</div>` : ""}
      `;
      if (animationsEnabled) gsap.from($$(".pill", resultEl), { opacity: 0, y: -6, duration: 0.25, stagger: 0.015 });
    } catch (err) {
      resultEl.textContent = `Error: ${err.message}`;
    }
  }

  /* ---------------- wiring ---------------- */

  function setupSegmented() {
    $$(".segmented").forEach((seg) => {
      const targetKey = seg.dataset.target === "check-proto" ? "checkProto" : "rangeProto";
      $$(".segmented-opt", seg).forEach((opt) => {
        opt.addEventListener("click", () => {
          $$(".segmented-opt", seg).forEach((o) => o.classList.remove("active"));
          opt.classList.add("active");
          state[targetKey] = opt.dataset.value;
        });
      });
    });
  }

  function setupTabs(initialTab) {
    if (initialTab && initialTab !== "ports") {
      const tab = $(`.tab[data-tab="${initialTab}"]`);
      if (tab) {
        $$(".tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        $$(".tab-panel").forEach((p) => p.classList.remove("active"));
        $(`#panel-${initialTab}`).classList.add("active");
      }
    }

    $$(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        if (tab.classList.contains("active")) return;
        const nextPanel = $(`#panel-${tab.dataset.tab}`);
        const currentPanel = $(".tab-panel.active");

        $$(".tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        savePreference(PREF_KEYS.activeTab, tab.dataset.tab);

        if (animationsEnabled && currentPanel) {
          gsap.to(currentPanel, {
            opacity: 0, duration: 0.15, onComplete: () => {
              currentPanel.classList.remove("active");
              currentPanel.style.opacity = "";
              nextPanel.classList.add("active");
              gsap.from(nextPanel, { opacity: 0, y: 6, duration: 0.25 });
            },
          });
        } else {
          $$(".tab-panel").forEach((p) => p.classList.remove("active"));
          nextPanel.classList.add("active");
        }
        syncToggleAllLabel();
      });
    });
  }

  let refreshTimer = null;
  function scheduleAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    if (state.autoRefresh) refreshTimer = setInterval(refresh, 10000);
  }

  document.addEventListener("DOMContentLoaded", () => {
    const prefs = loadPreferences();
    $("#auto-refresh").checked = state.autoRefresh;

    setupTabs(prefs.activeTab);
    setupSegmented();
    syncToggleAllLabel(); // groups start collapsed, so the button should read "Expand all"

    $("#refresh-btn").addEventListener("click", refresh);
    $("#check-port-btn").addEventListener("click", checkPort);
    $("#check-port-input").addEventListener("keydown", (e) => { if (e.key === "Enter") checkPort(); });
    $("#find-free-btn").addEventListener("click", findFreePorts);
    $("#range-start").addEventListener("keydown", (e) => { if (e.key === "Enter") findFreePorts(); });
    $("#range-end").addEventListener("keydown", (e) => { if (e.key === "Enter") findFreePorts(); });
    $("#ports-search").addEventListener("input", debounce(renderPortGroups, 150));
    $("#containers-search").addEventListener("input", debounce(renderContainerGroups, 150));
    $("#toggle-all-btn").addEventListener("click", toggleAllForActiveTab);
    $("#auto-refresh").addEventListener("change", (e) => {
      state.autoRefresh = e.target.checked;
      savePreference(PREF_KEYS.autoRefresh, state.autoRefresh ? "1" : "0");
      scheduleAutoRefresh();
    });

    refresh();
    scheduleAutoRefresh();
  });
})();
