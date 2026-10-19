/**
 * analysis.js — pure data-crunching. No DOM access, no network calls, no globals: just
 * (rubrics, responses, sessions, scores, config) in, {candidates, itemStats, summary} out.
 * That separation is what makes this reusable — app.js could be swapped for a CLI export
 * script or a different chart library without touching a single line here.
 *
 * The per-candidate math mirrors review.html's analyse() function (the per-question
 * reviewing tool this dashboard sits alongside) so the two never silently disagree on a
 * candidate's score. If you change a formula here, change it there too, or vice versa.
 */

const norm = s => String(s == null ? "" : s).trim();
const emailKey = s => norm(s).toLowerCase();
const normOpt = s => norm(s).replace(/\s+/g, " ").toLowerCase();
const tsOf = v => { const t = Date.parse(v); return isNaN(t) ? 0 : t; };
const byTs = (a, b) => tsOf(a["Timestamp"]) - tsOf(b["Timestamp"]);
const splitList = s => (norm(s) ? norm(s).split(",").map(x => x.trim()).filter(Boolean) : []);
const AI_NAME = "AI";

function wmean(list) {
  let s = 0, sw = 0, n = 0;
  list.forEach(x => { if (x.v == null) return; s += x.v * x.w; sw += x.w; n++; });
  return { pct: sw ? (s / sw) * 100 : null, n, total: list.length };
}

export function isExcludedEmail(email, config) {
  const e = emailKey(email);
  if (!e || e.indexOf("@") === -1) return true;
  if (config.excludeEmailPrefixes.some(p => e.indexOf(p) === 0)) return true;
  if ((config.excludeEmailSubstrings || []).some(s => e.includes(s))) return true;
  const domain = e.split("@")[1] || "";
  return config.excludeEmailDomains.includes(domain);
}

/** Latest-row-wins score per (email, qid, reviewer); a human score always beats "AI". */
function buildScoreIndex(scores) {
  const idx = new Map();
  scores.slice().sort(byTs).forEach(r => {
    const email = emailKey(r["Candidate Email"]), qid = norm(r["Question ID"]), rv = norm(r["Reviewer"]);
    if (!email || !qid || !rv) return;
    const k = email + "|" + qid;
    if (!idx.has(k)) idx.set(k, new Map());
    idx.get(k).set(rv, { score: Number(r["Score"]) });
  });
  return idx;
}
function scoreFor(idx, email, qid) {
  const m = idx.get(email + "|" + qid);
  if (!m) return null;
  const human = []; let ai = null;
  m.forEach((v, rv) => { if (v.score < 0) return; if (rv === AI_NAME) ai = v; else human.push(v.score); });
  const vals = human.length ? human : ai ? [ai.score] : [];
  if (!vals.length) return null;
  return { avg: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length, source: human.length ? "human" : "ai" };
}

export const STATUS = {
  pass: { label: "Meets all gates", tone: "good" },
  likely: { label: "Meets gates so far", tone: "info" },
  awaiting: { label: "Awaiting scores", tone: "plain" },
  lowprov: { label: "Below gate so far", tone: "warn" },
  below: { label: "Below gate", tone: "bad" },
  incomplete: { label: "Session missing", tone: "plain" }
};

/**
 * Runs the full analysis. `rubrics` is the {items, roles, competencies, dimensions,
 * quantOrder, commOrder} object your backend's "rubrics" action returns. `responses`,
 * `sessions`, `scores` are the row arrays from "review_data" / "scores". `config` is
 * config.js's CONFIG object (or your own, same shape).
 */
export function analyse(rubrics, responses, sessions, scores, config) {
  const R = rubrics;
  const scoreIdx = buildScoreIndex(scores);
  const compKeys = Object.keys(R.competencies || {});
  const roleIds = Object.keys(R.roles || {});

  const cands = new Map();
  const getCand = (email, name) => {
    if (!cands.has(email)) cands.set(email, { email, name: "", sess: {}, ans: {}, roles: [] });
    const c = cands.get(email);
    if (name && norm(name)) c.name = norm(name);
    return c;
  };

  sessions.slice().sort(byTs).forEach(r => {
    const email = emailKey(r["Candidate Email"]); if (!email || isExcludedEmail(email, config)) return;
    const sid = norm(r["Session"]); if (sid !== "session1" && sid !== "session2") return;
    const c = getCand(email, r["Candidate Name"]);
    const s = c.sess[sid] || (c.sess[sid] = {});
    const status = norm(r["Status"]);
    if (status === "started") {
      if (!s.startedAt) { s.startedAt = r["Timestamp"]; s.roles = splitList(r["Roles Selected"]); }
    } else if (!s.endedAt) {
      s.endedAt = r["Timestamp"]; s.status = status;
      const auto = status.indexOf("auto-completed") === 0;
      const m = /\(([^)]*)\)/.exec(status);
      s.reason = auto ? (m ? m[1] : "auto") : "completed";
    }
  });

  responses.slice().sort(byTs).forEach(r => {
    const email = emailKey(r["Candidate Email"]); if (!email || isExcludedEmail(email, config)) return;
    const qid = norm(r["Question ID"]); if (!qid) return;
    const c = getCand(email, r["Candidate Name"]);
    c.ans[qid] = {
      text: norm(r["Answer Text"]),
      sel: norm(r["Selected Option"]),
      video: norm(r["Video Link"]),
      time: Number(r["Time Spent (sec)"]) || 0
    };
  });

  cands.forEach(c => {
    let roles = (c.sess.session2 && c.sess.session2.roles) || [];
    if (!roles.length) {
      const set = new Set();
      Object.keys(c.ans).forEach(q => { const i = q.lastIndexOf("_"); if (i > 0 && roleIds.includes(q.slice(0, i))) set.add(q.slice(0, i)); });
      roles = [...set];
    }
    c.roles = roles.filter(r => roleIds.includes(r));
    c.ended = { s1: !!(c.sess.session1 && c.sess.session1.endedAt), s2: !!(c.sess.session2 && c.sess.session2.endedAt) };

    const expected = [];
    if (c.sess.session1) Object.values(R.items).forEach(it => { if (it.section !== "beh") expected.push(it.id); });
    if (c.sess.session2) c.roles.forEach(role => compKeys.forEach(k => expected.push(role + "_" + k)));

    c.recs = {};
    expected.forEach(qid => {
      const it = R.items[qid]; if (!it) return; // unknown question id (e.g. a retired role naming) — skip, never crash
      const sessEnded = it.section === "beh" ? c.ended.s2 : c.ended.s1;
      const a = c.ans[qid] || null;
      const rec = { qid, it, a, sessEnded };
      if (it.kind === "mcq") {
        rec.answered = !!(a && a.sel);
        rec.correct = rec.answered && normOpt(a.sel) === normOpt(it.key);
        rec.v = rec.answered ? (rec.correct ? 1 : 0) : sessEnded ? 0 : null;
      } else {
        rec.empty = !a || (it.video ? !a.video : !a.text.trim());
        rec.score = scoreFor(scoreIdx, c.email, qid);
        if (rec.empty && sessEnded) { rec.v = 0; rec.autoZero = true; }
        else if (rec.empty) rec.v = null;
        else rec.v = rec.score ? rec.score.avg / 3 : null;
        rec.needsScore = !rec.empty && !rec.score;
      }
      c.recs[qid] = rec;
    });

    const recs = Object.values(c.recs);
    const quantRecs = recs.filter(r => r.it.section === "quant");
    const mcq = quantRecs.filter(r => r.it.kind === "mcq"), subj = quantRecs.filter(r => r.it.kind === "subjective");
    const mcqAgg = wmean(mcq.map(r => ({ v: r.v, w: 1 }))), subjAgg = wmean(subj.map(r => ({ v: r.v, w: 1 })));
    c.quant = {
      mcq: mcqAgg, subj: subjAgg,
      pct: mcqAgg.pct != null && subjAgg.pct != null ? config.mcqShare * mcqAgg.pct + config.subjShare * subjAgg.pct : null,
      has: quantRecs.length > 0
    };

    const commRecs = recs.filter(r => r.it.section === "comm");
    c.comm = { ...wmean(commRecs.map(r => ({ v: r.v, w: 1 }))), has: commRecs.length > 0 };

    const behRecs = recs.filter(r => r.it.section === "beh");
    c.beh = { ...wmean(behRecs.map(r => ({ v: r.v, w: 1 }))), has: behRecs.length > 0, byRole: {}, byComp: {} };
    c.roles.forEach(role => { c.beh.byRole[role] = wmean(behRecs.filter(r => r.it.role === role).map(r => ({ v: r.v, w: 1 }))); });
    compKeys.forEach(k => { c.beh.byComp[k] = wmean(behRecs.filter(r => r.it.competency === k).map(r => ({ v: r.v, w: 1 }))); });

    c.dims = {};
    Object.keys(R.dimensions || {}).forEach(d => {
      c.dims[d] = wmean(quantRecs.filter(r => r.it.dims && r.it.dims.includes(d)).map(r => ({ v: r.v, w: r.it.kind === "mcq" ? 1 : config.algoSubjWeight })));
    });
    c.algo = c.dims.algorithmic || null;

    c.unscored = recs.filter(r => r.needsScore);
    c.unscoredVideo = c.unscored.filter(r => r.it.video);
    c.unscoredText = c.unscored.filter(r => !r.it.video);
    c.aiScoredN = recs.filter(r => r.score && r.score.source === "ai").length;
    c.humanScoredN = recs.filter(r => r.score && r.score.source === "human").length;
    c.provisional = c.unscored.length > 0;

    c.integrityFlags = [];
    Object.entries(c.sess).forEach(([sid, s]) => {
      const label = sid === "session1" ? "Session 1" : "Session 2";
      if (s.reason === "tab_hidden") c.integrityFlags.push({ level: "hard", text: label + " ended automatically (tab switched/hidden)" });
      else if (s.reason === "time_limit") c.integrityFlags.push({ level: "info", text: label + " ran out of time" });
    });
  });

  applyGatesAndStatus(cands, config);

  const candidates = [...cands.values()];
  return { candidates, itemStats: computeItemStats(candidates, R), summary: computeSummary(candidates, config) };
}

function applyGatesAndStatus(cands, config) {
  const g = config.gates, w = config.weights;
  cands.forEach(c => {
    const secs = [["quant", c.quant.pct], ["comm", c.comm.pct], ["beh", c.beh.pct]];
    let sw = 0, s = 0;
    secs.forEach(([k, p]) => { if (p != null) { s += p * w[k]; sw += w[k]; } });
    c.total = sw ? s / sw : null;
    c.floor = c.quant.pct != null && c.comm.pct != null && c.beh.pct != null ? Math.min(c.quant.pct, c.comm.pct, c.beh.pct) : null;

    const checks = [["quant", c.quant.pct, g.quant], ["comm", c.comm.pct, g.comm], ["beh", c.beh.pct, g.beh], ["algo", c.algo ? c.algo.pct : null, g.algo]];
    c.gateFails = checks.filter(([, p, gate]) => p != null && p < gate).map(([k]) => k);
    c.gateMissing = checks.filter(([, p]) => p == null).map(([k]) => k);

    if (!(c.ended.s1 && c.ended.s2)) c.status = "incomplete";
    else if (c.gateFails.length) c.status = c.provisional ? "lowprov" : "below";
    else if (c.gateMissing.length >= 2 || c.quant.pct == null || c.beh.pct == null) c.status = "awaiting";
    else if (c.provisional || c.gateMissing.length) c.status = "likely";
    else c.status = "pass";
  });
}

/** MCQ difficulty (% correct) and discrimination (top-27% minus bottom-27% correct rate,
 *  by overall total) — a low or negative discrimination flags a question worth reviewing:
 *  it isn't separating stronger candidates from weaker ones the way it should. */
function computeItemStats(candidates, R) {
  const stats = {};
  Object.values(R.items).forEach(it => {
    if (it.kind !== "mcq") return;
    const answered = candidates.map(c => c.recs[it.id]).filter(r => r && r.answered);
    if (!answered.length) return;
    stats[it.id] = { id: it.id, tag: it.tag, n: answered.length, pctCorrect: (answered.filter(r => r.correct).length / answered.length) * 100 };
  });
  const ranked = candidates.filter(c => c.total != null).sort((a, b) => b.total - a.total);
  const k = Math.floor(ranked.length * 0.27);
  if (ranked.length >= 10 && k >= 3) {
    const top = ranked.slice(0, k), bottom = ranked.slice(-k);
    const rate = (group, qid) => {
      const a = group.map(c => c.recs[qid]).filter(r => r && r.answered);
      return a.length ? a.filter(r => r.correct).length / a.length : null;
    };
    Object.values(stats).forEach(s => {
      const pt = rate(top, s.id), pb = rate(bottom, s.id);
      s.discrimination = pt != null && pb != null ? pt - pb : null;
    });
  }
  return stats;
}

function computeSummary(candidates, config) {
  const n = candidates.length;
  const startedBoth = candidates.filter(c => c.sess.session1 && c.sess.session2).length;
  const endedBoth = candidates.filter(c => c.ended.s1 && c.ended.s2).length;
  const byStatus = {}; candidates.forEach(c => { byStatus[c.status] = (byStatus[c.status] || 0) + 1; });
  const byRole = {}; candidates.forEach(c => c.roles.forEach(r => { byRole[r] = (byRole[r] || 0) + 1; }));
  const aiScoredN = candidates.reduce((a, c) => a + c.aiScoredN, 0);
  const humanScoredN = candidates.reduce((a, c) => a + c.humanScoredN, 0);
  const unscoredN = candidates.reduce((a, c) => a + c.unscored.length, 0);
  const unscoredVideoN = candidates.reduce((a, c) => a + c.unscoredVideo.length, 0);
  const avg = key => { const v = candidates.map(c => c[key] && c[key].pct).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const flaggedN = candidates.filter(c => c.integrityFlags.length).length;
  return {
    n, startedBoth, endedBoth, byStatus, byRole,
    aiScoredN, humanScoredN, unscoredN, unscoredVideoN, flaggedN,
    sectionAverages: { quant: avg("quant"), comm: avg("comm"), beh: avg("beh") },
    priorityPool: candidates.filter(c => c.quant.mcq.pct != null && c.quant.mcq.pct >= config.mcqPriorityMin).length
  };
}
