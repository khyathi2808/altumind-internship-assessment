/**
 * common.gs — shared plumbing for the AI grading pipeline (text_grading / ai.gs and
 * video_grading.gs). Keeping this in one place means the two scorers can't quietly
 * drift apart on "who is even eligible to be graded yet" — the kind of bug that stays
 * invisible until someone asks why a specific candidate was never scored.
 *
 * Depends on things already defined in Code.gs: SHEET_ID, RESPONSES_TAB, SESSIONS_TAB,
 * SCORES_TAB, SCORES_HEADERS, sheetToObjects(), getScoresRows(), getOrCreateSheet().
 * Apps Script merges all .gs files into one global scope, so load order doesn't matter.
 */

/** Only candidates at or above this MCQ percent get AI-graded (0 = everyone). Shared across
 *  text and video so the two scorers prioritise the same people in the same order. Defaults
 *  to 0 so every finished answer is graded; candidates are still graded highest-MCQ first.
 *  Override with the AI_MCQ_MIN script property (e.g. 75) to grade only the priority pool. */
const AI_MCQ_MIN = Number(PropertiesService.getScriptProperties().getProperty("AI_MCQ_MIN") || 0);
const AI_LOG_TAB = "AI Log";

/**
 * Email prefixes and domains treated as test/internal accounts, excluded from AI grading.
 * The original check only caught "test*" and "rohitkum*" prefixes, which missed internal
 * @altumindglobal.com dry-run accounts (visible in the sheet using pre-launch question IDs
 * like "design_ownership" / "engineering_ownership" instead of the current
 * "product_design_ownership" / "full_stack_ownership" naming) — add any other internal
 * domains here if you see them show up as "eligible" by mistake.
 */
const TEST_EMAIL_PREFIXES = ["test", "rohitkum"];
const TEST_EMAIL_DOMAINS = ["altumindglobal.com", "mailinator.com"];
// Catches malformed staff entries like "sruthivarmaaltumindglobal" that have no real domain.
const TEST_EMAIL_SUBSTRINGS = ["altumindglobal"];

function isTestOrStaffEmail_(email){
  const e = String(email || "").toLowerCase();
  if(!e || e.indexOf("@") === -1) return true;
  if(TEST_EMAIL_PREFIXES.some(p => e.indexOf(p) === 0)) return true;
  if(TEST_EMAIL_SUBSTRINGS.some(s => e.indexOf(s) !== -1)) return true;
  const domain = e.split("@")[1] || "";
  return TEST_EMAIL_DOMAINS.indexOf(domain) !== -1;
}

/** True when the session this question belongs to has ended for the candidate — only then
 *  is the answer final and safe to grade. Behavioral items live in session2, the rest in session1. */
function gradingAnswerFinal_(info, it){
  return !!info.ended[it.section === "beh" ? "session2" : "session1"];
}

/**
 * Candidates eligible for AI grading of any kind (text or video): at least one session
 * ended, not a test/staff account, and at or above mcqMin on the 14 MCQs. Returns a Map keyed
 * by lowercased email -> {pct, rows, ended} where rows is every Responses row for that
 * candidate and ended is {session1, session2}. Callers grade an answer only once its own
 * session has ended (gradingAnswerFinal_), so a candidate who finished Session 1 but not
 * Session 2 still gets their Session 1 answers graded.
 *
 * A Question ID not found in RUBRICS.items (an orphan from an earlier build, or a typo) is
 * silently skipped everywhere it's looked up below — it just doesn't count toward the MCQ
 * percent and never becomes a "pending" item for either scorer. That's deliberate: an
 * unknown question should never crash a batch run, it should just be invisible to grading.
 */
function gradingEligibleCandidates_(ss, mcqMin){
  const norm = s => String(s == null ? "" : s).trim();
  const normOpt = s => norm(s).replace(/\s+/g, " ").toLowerCase();
  const resp = sheetToObjects(ss, RESPONSES_TAB), sess = sheetToObjects(ss, SESSIONS_TAB);
  const ended = {};
  sess.forEach(r => {
    const st = norm(r["Status"]);
    if(st && st !== "started") ended[norm(r["Candidate Email"]).toLowerCase() + "|" + norm(r["Session"])] = true;
  });
  const by = {};
  resp.forEach(r => { const e = norm(r["Candidate Email"]).toLowerCase(); (by[e] = by[e] || []).push(r); });
  const out = new Map();
  Object.keys(by).forEach(email => {
    if(isTestOrStaffEmail_(email)) return;
    const endedFlags = {session1:!!ended[email + "|session1"], session2:!!ended[email + "|session2"]};
    if(!endedFlags.session1 && !endedFlags.session2) return;
    const rows = by[email];
    let mc = 0, ok = 0;
    rows.forEach(r => {
      const it = RUBRICS.items[norm(r["Question ID"])];
      if(it && it.kind === "mcq" && norm(r["Selected Option"])){
        mc++;
        if(normOpt(r["Selected Option"]) === normOpt(it.key)) ok++;
      }
    });
    const pct = mc ? ok / 14 * 100 : 0; // 14 = fixed MCQ count per session1, matches rubrics.gs quantOrder
    if(pct < mcqMin) return;
    out.set(email, {pct:pct, rows:rows, ended:endedFlags});
  });
  return out;
}

/**
 * UrlFetchApp wrapper with retry + short backoff for transient failures (429 rate limits,
 * 5xx, or a dropped connection). Apps Script's own 6-minute execution ceiling bounds how
 * much this can ever cost: 2 retries with short, doubling sleeps is enough to ride out a
 * brief rate-limit window without eating the whole time budget on one stuck call.
 */
function fetchWithRetry_(url, options, maxRetries){
  maxRetries = maxRetries == null ? 2 : maxRetries;
  const opts = Object.assign({muteHttpExceptions:true}, options || {});
  let lastErr;
  for(let attempt = 0; attempt <= maxRetries; attempt++){
    try{
      const res = UrlFetchApp.fetch(url, opts);
      const code = res.getResponseCode();
      if(code === 429 || (code >= 500 && code < 600)){
        lastErr = new Error("HTTP " + code + ": " + res.getContentText().slice(0, 300));
        if(attempt < maxRetries){ Utilities.sleep(800 * Math.pow(2, attempt)); continue; }
        throw lastErr;
      }
      return res;
    } catch(err){
      lastErr = err;
      if(attempt < maxRetries){ Utilities.sleep(800 * Math.pow(2, attempt)); continue; }
      throw lastErr;
    }
  }
  throw lastErr;
}

/** Pulls the file ID out of a Drive share URL like .../file/d/<ID>/view?usp=... or ?id=<ID>. */
function driveFileIdFromUrl_(url){
  const m = String(url || "").match(/\/file\/d\/([^/]+)/) || String(url || "").match(/[?&]id=([^&]+)/);
  return m ? m[1] : null;
}

/** Shared log, used by both scorers. Prefix kind ("[text]" / "[video]") is in the message
 *  itself rather than its own column, so this works against a log tab from either scorer
 *  without a header migration. */
function aiLog_(ss, msg){
  const sh = getOrCreateSheet(ss, AI_LOG_TAB, ["Timestamp", "Message"]);
  sh.appendRow([new Date(), safeCell_(msg)]);
}
