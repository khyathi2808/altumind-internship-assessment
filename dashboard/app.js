import { CONFIG } from "./config.js";
import { fetchAssessmentData, fetchGradingStatus, runGradingBatch, ApiError } from "./dataAdapter.js";
import { analyse, STATUS } from "./analysis.js";

const LS_ENDPOINT = "assessmentDashboard:endpoint";
const LS_KEY = "assessmentDashboard:adminKey"; // browser-local only — never written to this repo, see README

const $ = sel => document.querySelector(sel);
const charts = {}; // Chart.js instances, destroyed and rebuilt on each refresh

let STATE = { rubrics: null, responses: [], sessions: [], scores: [], candidates: [], itemStats: {}, summary: null };
let sort = { key: "total", dir: "desc" };
let filters = { role: "all", status: "all", search: "" };

init();

function init() {
  $("#connectForm").addEventListener("submit", onConnect);
  $("#changeBackend").addEventListener("click", showConnectScreen);
  $("#refreshBtn").addEventListener("click", () => loadAndRender(true));
  $("#runGradingBtn").addEventListener("click", onRunGrading);
  $("#roleFilter").addEventListener("change", e => { filters.role = e.target.value; renderLeaderboard(); });
  $("#statusFilter").addEventListener("change", e => { filters.status = e.target.value; renderLeaderboard(); });
  $("#searchBox").addEventListener("input", e => { filters.search = e.target.value.toLowerCase(); renderLeaderboard(); });
  document.querySelectorAll("#leaderboardTable thead th[data-sort]").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      sort.dir = sort.key === key && sort.dir === "desc" ? "asc" : "desc";
      sort.key = key;
      renderLeaderboard();
    });
  });

  const endpoint = localStorage.getItem(LS_ENDPOINT) || CONFIG.defaultEndpoint || "";
  const key = sessionStorage.getItem(LS_KEY) || "";
  if (endpoint && key) {
    $("#endpointInput").value = endpoint;
    $("#keyInput").value = key;
    loadAndRender(false);
  } else {
    $("#endpointInput").value = endpoint;
    showConnectScreen();
  }
}

function showConnectScreen() {
  $("#connectScreen").classList.remove("hidden");
  $("#dashboard").classList.add("hidden");
}

async function onConnect(e) {
  e.preventDefault();
  const endpoint = $("#endpointInput").value.trim();
  const key = $("#keyInput").value.trim();
  if (!endpoint || !key) return;
  localStorage.setItem(LS_ENDPOINT, endpoint);
  // The admin key is deliberately kept in sessionStorage, not localStorage: it clears when
  // the tab closes, rather than sitting on disk indefinitely on a shared or public machine.
  // Re-type it next visit, or switch this to localStorage yourself if that trade-off is
  // wrong for how you use this.
  sessionStorage.setItem(LS_KEY, key);
  await loadAndRender(false);
}

async function loadAndRender(forceShowErrors) {
  const endpoint = localStorage.getItem(LS_ENDPOINT), key = sessionStorage.getItem(LS_KEY);
  setStatus("Loading…");
  try {
    const data = await fetchAssessmentData(endpoint, key);
    STATE.rubrics = data.rubrics; STATE.responses = data.responses; STATE.sessions = data.sessions; STATE.scores = data.scores;
    const result = analyse(STATE.rubrics, STATE.responses, STATE.sessions, STATE.scores, CONFIG);
    STATE.candidates = result.candidates; STATE.itemStats = result.itemStats; STATE.summary = result.summary;
    $("#connectScreen").classList.add("hidden");
    $("#dashboard").classList.remove("hidden");
    populateFilters();
    renderAll();
    setStatus("Updated " + new Date().toLocaleTimeString());
    loadGradingStatus(); // slower (re-reads the sheet server-side), so it fills in after the charts
  } catch (err) {
    setStatus("");
    const msg = err instanceof ApiError ? err.message : "Unexpected error: " + err.message;
    if (forceShowErrors || $("#dashboard").classList.contains("hidden")) {
      showConnectScreen();
      $("#connectError").textContent = msg;
      $("#connectError").classList.remove("hidden");
    } else {
      alert(msg);
    }
  }
}

function setStatus(text) { $("#statusLine").textContent = text; }

/* ---------- grading (backend AI scorers: ai.gs for text, video_grading.gs for video) ---------- */
function backendCreds() { return [localStorage.getItem(LS_ENDPOINT), sessionStorage.getItem(LS_KEY)]; }

async function loadGradingStatus() {
  try {
    renderGradingStatus(await fetchGradingStatus(...backendCreds()));
  } catch (err) {
    $("#gradingStats").textContent = "Grading status unavailable: " + err.message;
  }
}

function renderGradingStatus(st) {
  const s = STATE.summary;
  const scorer = (part, label) => part && part.configured
    ? `<div><b>${part.pending}</b>${label} waiting for AI${part.model ? ` <span class="muted">(${esc(part.model)})</span>` : ""}</div>`
    : `<div><b>—</b>${label} scorer not configured</div>`;
  $("#gradingStats").innerHTML =
    scorer(st.text, "written answers") +
    scorer(st.video, "videos") +
    `<div><b>${s.aiScoredN}</b>items AI-scored</div>` +
    `<div><b>${s.humanScoredN}</b>items human-scored</div>` +
    `<div><b>${s.unscoredN}</b>still unscored (incl. ${s.unscoredVideoN} videos)</div>`;
  $("#runGradingBtn").disabled = !((st.text && st.text.configured) || (st.video && st.video.configured));
}

async function onRunGrading() {
  const btn = $("#runGradingBtn");
  btn.disabled = true;
  btn.textContent = "Grading… (up to 5 min)";
  try {
    const r = await runGradingBatch(...backendCreds());
    const part = (x, label) => !x ? "" : x.ok === false ? `${label}: ${x.error}` : `${label}: ${x.scored || 0} scored, ${x.failed || 0} failed, ${x.remaining != null ? x.remaining : "?"} left`;
    $("#gradingNote").textContent = "Last run — " + [part(r.text, "written"), part(r.video, "video")].filter(Boolean).join(" · ");
    await loadAndRender(false);
  } catch (err) {
    $("#gradingNote").textContent = "Grading run failed: " + err.message;
  } finally {
    btn.textContent = "Run grading batch now";
    btn.disabled = false;
  }
}

function populateFilters() {
  const roles = new Set(); STATE.candidates.forEach(c => c.roles.forEach(r => roles.add(r)));
  const roleSel = $("#roleFilter");
  roleSel.innerHTML = '<option value="all">All roles</option>' +
    [...roles].sort().map(r => `<option value="${r}">${roleLabel(r)}</option>`).join("");
  const statusSel = $("#statusFilter");
  statusSel.innerHTML = '<option value="all">All statuses</option>' +
    Object.keys(STATUS).map(s => `<option value="${s}">${STATUS[s].label}</option>`).join("");
}

function roleLabel(id) { return (STATE.rubrics.roles && STATE.rubrics.roles[id]) || id; }

function renderAll() {
  renderStatCards();
  renderFunnelChart();
  renderStatusChart();
  renderRoleChart();
  renderScoreHistograms();
  renderItemDifficultyChart();
  renderScoringCoverageChart();
  renderLeaderboard();
}

/* ---------- stat cards ---------- */
function renderStatCards() {
  const s = STATE.summary;
  const cards = [
    ["Candidates (real)", s.n],
    ["Completed both sessions", s.endedBoth + " / " + s.n],
    ["Meets all gates", (s.byStatus.pass || 0)],
    ["Flagged for integrity review", s.flaggedN],
    ["AI-scored items", s.aiScoredN],
    ["Human-scored items", s.humanScoredN],
    ["Still unscored", s.unscoredN],
    ["Avg total (of those scored)", fmtPct(wavg(STATE.candidates.map(c => c.total)))]
  ];
  $("#statCards").innerHTML = cards.map(([label, val]) => `
    <div class="stat-card">
      <div class="stat-value">${val}</div>
      <div class="stat-label">${label}</div>
    </div>`).join("");
}
function wavg(arr) { const v = arr.filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }
function fmtPct(p) { return p == null ? "n/a" : Math.round(p) + "%"; }

/* ---------- charts (Chart.js, loaded from CDN in index.html) ---------- */
function destroy(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }
function themeColors() {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches && document.documentElement.dataset.theme !== "light";
  return {
    text: dark ? "#e8e4da" : "#2a241a",
    grid: dark ? "#3a3326" : "#e7e1d2",
    series: ["#3d7a5f", "#c9973a", "#7b6fb0", "#c05a5a", "#4a8fc2", "#8aab4a"]
  };
}

function renderFunnelChart() {
  const c = STATE.candidates;
  const steps = [
    ["Started Session 1", c.filter(x => x.sess.session1).length],
    ["Completed Session 1", c.filter(x => x.ended.s1).length],
    ["Started Session 2", c.filter(x => x.sess.session2).length],
    ["Completed Session 2", c.filter(x => x.ended.s2).length],
    ["Meets all gates", c.filter(x => x.status === "pass").length]
  ];
  const t = themeColors();
  destroy("funnel");
  charts.funnel = new Chart($("#funnelChart"), {
    type: "bar",
    data: { labels: steps.map(s => s[0]), datasets: [{ data: steps.map(s => s[1]), backgroundColor: t.series[0] }] },
    options: baseBarOptions(t, { indexAxis: "y" })
  });
}

function renderStatusChart() {
  const s = STATE.summary.byStatus;
  const labels = Object.keys(STATUS).filter(k => s[k]);
  const t = themeColors();
  destroy("status");
  charts.status = new Chart($("#statusChart"), {
    type: "doughnut",
    data: { labels: labels.map(k => STATUS[k].label), datasets: [{ data: labels.map(k => s[k]), backgroundColor: t.series }] },
    options: { plugins: { legend: { labels: { color: t.text } } }, color: t.text }
  });
}

function renderRoleChart() {
  const r = STATE.summary.byRole;
  const labels = Object.keys(r).sort((a, b) => r[b] - r[a]);
  const t = themeColors();
  destroy("role");
  charts.role = new Chart($("#roleChart"), {
    type: "bar",
    data: { labels: labels.map(roleLabel), datasets: [{ data: labels.map(l => r[l]), backgroundColor: t.series[1] }] },
    options: baseBarOptions(t)
  });
}

function binInto10s(values) {
  const bins = new Array(10).fill(0);
  values.filter(v => v != null).forEach(v => { const i = Math.min(9, Math.floor(v / 10)); bins[i]++; });
  return bins;
}
function renderScoreHistograms() {
  const t = themeColors();
  const sections = [["quant", "quantHist"], ["comm", "commHist"], ["beh", "behHist"], ["total", "totalHist"]];
  sections.forEach(([key, canvasId]) => {
    const values = STATE.candidates.map(c => key === "total" ? c.total : c[key].pct);
    destroy(canvasId);
    charts[canvasId] = new Chart($("#" + canvasId), {
      type: "bar",
      data: {
        labels: ["0-10", "10-20", "20-30", "30-40", "40-50", "50-60", "60-70", "70-80", "80-90", "90-100"],
        datasets: [{ data: binInto10s(values), backgroundColor: t.series[2] }]
      },
      options: baseBarOptions(t)
    });
  });
}

function renderItemDifficultyChart() {
  const items = Object.values(STATE.itemStats).sort((a, b) => a.pctCorrect - b.pctCorrect);
  const t = themeColors();
  destroy("difficulty");
  charts.difficulty = new Chart($("#difficultyChart"), {
    type: "bar",
    data: {
      labels: items.map(i => i.id),
      datasets: [{
        label: "% correct",
        data: items.map(i => i.pctCorrect),
        backgroundColor: items.map(i => i.discrimination != null && i.discrimination < 0.1 ? t.series[3] : t.series[0])
      }]
    },
    options: { ...baseBarOptions(t, { indexAxis: "y" }),
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: ctx => {
          const it = items[ctx.dataIndex];
          return `${Math.round(it.pctCorrect)}% correct (n=${it.n})` + (it.discrimination != null ? `, discrimination ${it.discrimination.toFixed(2)}` : "");
        } } } } }
  });
}

function renderScoringCoverageChart() {
  const s = STATE.summary;
  const t = themeColors();
  destroy("coverage");
  charts.coverage = new Chart($("#coverageChart"), {
    type: "doughnut",
    data: {
      labels: ["AI-scored", "Human-scored", "Unscored"],
      datasets: [{ data: [s.aiScoredN, s.humanScoredN, s.unscoredN], backgroundColor: [t.series[4], t.series[0], t.series[3]] }]
    },
    options: { plugins: { legend: { labels: { color: t.text } } } }
  });
}

function baseBarOptions(t, extra) {
  return Object.assign({
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: t.text }, grid: { color: t.grid } },
      y: { ticks: { color: t.text }, grid: { color: t.grid }, beginAtZero: true }
    }
  }, extra || {});
}

/* ---------- leaderboard ---------- */
function renderLeaderboard() {
  let rows = STATE.candidates.slice();
  if (filters.role !== "all") rows = rows.filter(c => c.roles.includes(filters.role));
  if (filters.status !== "all") rows = rows.filter(c => c.status === filters.status);
  if (filters.search) rows = rows.filter(c => (c.name + " " + c.email).toLowerCase().includes(filters.search));

  rows.sort((a, b) => {
    // quant/comm/beh are {pct, ...} objects; total is a bare number.
    const get = c => (sort.key === "name" ? c.name || c.email : sort.key === "status" ? c.status
      : c[sort.key] != null && typeof c[sort.key] === "object" ? c[sort.key].pct : c[sort.key]);
    const av = get(a), bv = get(b);
    const cmp = typeof av === "string" || typeof bv === "string"
      ? String(av || "").localeCompare(String(bv || ""))
      : (av == null ? -1 : av) - (bv == null ? -1 : bv);
    return sort.dir === "asc" ? cmp : -cmp;
  });

  $("#leaderboardCount").textContent = rows.length + " candidate" + (rows.length === 1 ? "" : "s");
  $("#leaderboardBody").innerHTML = rows.map((c, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${esc(c.name || "(no name)")}<div class="muted small">${esc(c.email)}</div></td>
      <td>${c.roles.map(roleLabel).join(", ")}</td>
      <td>${fmtPct(c.quant.pct)}</td>
      <td>${fmtPct(c.comm.pct)}</td>
      <td>${fmtPct(c.beh.pct)}</td>
      <td><b>${fmtPct(c.total)}</b></td>
      <td><span class="badge badge-${STATUS[c.status].tone}">${STATUS[c.status].label}</span></td>
      <td>${c.unscored.length || "—"}</td>
      <td>${c.integrityFlags.length || "—"}</td>
    </tr>`).join("");
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }
