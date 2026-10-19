/**
 * Altumind Internship Assessment — Apps Script backend
 *
 * Deployment:
 * 1. Create a new Google Sheet. Copy its ID from the URL into SHEET_ID below.
 * 2. Create a Google Drive folder for video responses. Copy its ID into DRIVE_FOLDER_ID below.
 * 3. Add a Script property ADMIN_KEY (Project Settings > Script properties) set to a secret string — this gates the live-map
 *    endpoint so a random visitor to your Web App URL can't see candidate locations.
 * 4. Open Extensions > Apps Script on that Sheet, paste this file in as Code.gs.
 * 5. Deploy > New deployment > type "Web app". Execute as "Me", access "Anyone".
 * 6. Copy the Web App URL into ENDPOINT_URL in index.html, and into the prompt on
 *    first load of admin.html (or edit ADMIN_ENDPOINT_URL directly in admin.html).
 * 7. Re-deploy (new version) any time you edit this file — the URL stays the same
 *    only if you edit an existing deployment rather than creating a new one.
 */

const SHEET_ID = "REPLACE_WITH_YOUR_SHEET_ID";
const DRIVE_FOLDER_ID = "REPLACE_WITH_YOUR_DRIVE_FOLDER_ID";
// Set ADMIN_KEY under Project Settings > Script properties, never in this file: this repo is
// published on GitHub Pages, so anything written here is public. With no property set, every
// admin action is refused.
const ADMIN_KEY = PropertiesService.getScriptProperties().getProperty("ADMIN_KEY") || "";
function isAdminKey_(k){ return !!ADMIN_KEY && k === ADMIN_KEY; }

const RESPONSES_TAB = "Responses";
const SESSIONS_TAB = "Sessions";
const LIVE_TAB = "Live";

// A candidate is treated as "currently logged in" for the live map if their most
// recent heartbeat is within this many seconds. Heartbeats are sent every 20s from
// the app, so 60s tolerates one or two missed pings before dropping them from the map.
const LIVE_WINDOW_SECONDS = 60;

function doPost(e){
  try{
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.openById(SHEET_ID);

    // Reviewer score from the review dashboard. Gated by the admin key; anything else
    // in this handler is the candidate app, which never carries a key.
    if(data.type === "score_save"){
      if(!isAdminKey_(data.key)){
        return jsonOutput({ok:false, error:"Invalid key"});
      }
      saveScore(ss, data);
      return jsonOutput({ok:true});
    }

    if(data.type === "session_start"){
      logSessionEvent(ss, data, "started");
      upsertLive(ss, data);
    } else if(data.type === "session_complete" || data.type === "session_complete_autotimeout"){
      const status = data.type === "session_complete_autotimeout"
        ? "auto-completed (" + (data.reason || "time_limit") + ")"
        : "completed";
      logSessionEvent(ss, data, status);
      removeLive(ss, data);
      sendCompletionReceipt(data, status);
    } else if(data.type === "question_submit" || data.type === "question_submit_autotimeout"){
      logQuestionResponse(ss, data);
    } else if(data.type === "heartbeat"){
      upsertLive(ss, data);
    }

    return ContentService.createTextOutput(JSON.stringify({ok:true}))
      .setMimeType(ContentService.MimeType.JSON);
  } catch(err){
    return ContentService.createTextOutput(JSON.stringify({ok:false, error:String(err)}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * GET ?action=live&key=ADMIN_KEY — returns JSON of candidates whose last heartbeat
 * was within LIVE_WINDOW_SECONDS, for the admin live-map page to poll.
 * Any other GET just confirms the deployment is reachable.
 */
function doGet(e){
  const params = e && e.parameter ? e.parameter : {};
  if(params.action === "live"){
    if(!isAdminKey_(params.key)){
      return jsonOutput({ok:false, error:"Invalid key"});
    }
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const rows = getLiveRows(ss);
    return jsonOutput({ok:true, candidates:rows});
  }
  if(params.action === "check_attempt"){
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const used = hasExistingAttempt(ss, params.email, params.session);
    return jsonOutput({ok:true, alreadyUsed:used});
  }
  if(params.action === "all_locations"){
    if(!isAdminKey_(params.key)){
      return jsonOutput({ok:false, error:"Invalid key"});
    }
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const rows = getAllLocationsRows(ss);
    return jsonOutput({ok:true, candidates:rows});
  }
  // ---- Review dashboard (all admin-key gated) ----
  if(params.action === "rubrics" || params.action === "review_data" || params.action === "scores"){
    if(!isAdminKey_(params.key)){
      return jsonOutput({ok:false, error:"Invalid key"});
    }
    if(params.action === "rubrics"){
      return jsonOutput({ok:true, rubrics:RUBRICS}); // RUBRICS lives in rubrics.gs
    }
    const ss = SpreadsheetApp.openById(SHEET_ID);
    if(params.action === "scores"){
      return jsonOutput({ok:true, scores:getScoresRows(ss)});
    }
    return jsonOutput({
      ok:true,
      responses:sheetToObjects(ss, RESPONSES_TAB),
      sessions:sheetToObjects(ss, SESSIONS_TAB),
      scores:getScoresRows(ss)
    });
  }
  // ---- AI grading (all admin-key gated) ----
  // ai_status / ai_run: text-only (ai.gs). video_status / video_run: video-only (video_grading.gs).
  // grading_status / grading_run: both, via grading_orchestrator.gs's shared time budget —
  // use this pair once both scorers are configured, since it's the one that won't overrun
  // Apps Script's execution ceiling when both are run together.
  if(params.action === "ai_status" || params.action === "ai_run"){
    if(!isAdminKey_(params.key)){ return jsonOutput({ok:false, error:"Invalid key"}); }
    try{ return jsonOutput(params.action === "ai_status" ? aiStatus_() : aiRun_()); }
    catch(err){ return jsonOutput({ok:false, error:String(err.message || err)}); }
  }
  if(params.action === "video_status" || params.action === "video_run"){
    if(!isAdminKey_(params.key)){ return jsonOutput({ok:false, error:"Invalid key"}); }
    try{ return jsonOutput(params.action === "video_status" ? videoStatus_() : videoRun_()); }
    catch(err){ return jsonOutput({ok:false, error:String(err.message || err)}); }
  }
  if(params.action === "grading_status" || params.action === "grading_run"){
    if(!isAdminKey_(params.key)){ return jsonOutput({ok:false, error:"Invalid key"}); }
    try{ return jsonOutput(params.action === "grading_status" ? gradingStatus_() : gradingRunBatch()); }
    catch(err){ return jsonOutput({ok:false, error:String(err.message || err)}); }
  }
  return ContentService.createTextOutput("Altumind assessment backend is live.");
}

/* ---------- Review dashboard support ---------- */

const SCORES_TAB = "Scores";
const SCORES_HEADERS = ["Timestamp","Reviewer","Candidate Email","Question ID","Score","Checklist","Notes"];

/** Reads a tab into an array of {header: value} objects. Returns [] if the tab is missing. */
function sheetToObjects(ss, tabName){
  const sheet = ss.getSheetByName(tabName);
  if(!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if(values.length < 2) return [];
  const headers = values[0].map(String);
  const out = [];
  for(let i=1;i<values.length;i++){
    const row = {};
    for(let c=0;c<headers.length;c++){
      const v = values[i][c];
      row[headers[c]] = (v instanceof Date) ? v.toISOString() : v;
    }
    out.push(row);
  }
  return out;
}

function getScoresRows(ss){
  return sheetToObjects(ss, SCORES_TAB);
}

/**
 * Appends one reviewer score. The dashboard treats the latest row per
 * (reviewer, candidate, question) as that reviewer's current score, so edits are
 * appends and the full history stays in the sheet. Score -1 means "cleared".
 */
function saveScore(ss, data){
  const reviewer = String(data.reviewer || "").trim().slice(0, 60);
  const email = String(data.email || "").trim().toLowerCase().slice(0, 200);
  const qid = String(data.questionId || "").trim().slice(0, 60);
  const score = Number(data.score);
  if(!reviewer) throw new Error("Reviewer name is required");
  if(reviewer.toLowerCase() === "ai") throw new Error("The reviewer name AI is reserved");
  if(!email || !qid) throw new Error("Missing candidate or question");
  if(!(score >= -1 && score <= 3) || Math.floor(score) !== score) throw new Error("Score must be -1, 0, 1, 2 or 3");
  const sheet = getOrCreateSheet(ss, SCORES_TAB, SCORES_HEADERS);
  sheet.appendRow([
    new Date().toISOString(),
    safeCell_(reviewer),
    safeCell_(email),
    safeCell_(qid),
    score,
    safeCell_(JSON.stringify(data.checklist || []).slice(0, 500)),
    safeCell_(String(data.notes || "").slice(0, 2000))
  ]);
}

/**
 * Candidate-controlled text goes into cells via appendRow, which Sheets parses like typed
 * input. A value beginning with = + - or @ would be treated as a formula, which lets a
 * candidate run formulas (for example IMPORTXML) with the sheet owner's access. A leading
 * apostrophe forces plain text. Apply to every candidate- or reviewer-supplied string.
 */
function safeCell_(v){
  const s = (v === null || v === undefined) ? "" : String(v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

/** Returns true if this email has any logged Sessions row (started or completed) for this session. */
function hasExistingAttempt(ss, email, session){
  if(!email || !session) return false;
  const sheet = ss.getSheetByName(SESSIONS_TAB);
  if(!sheet) return false;
  const values = sheet.getDataRange().getValues();
  const emailLower = String(email).toLowerCase();
  for(let i=1;i<values.length;i++){
    const rowEmail = String(values[i][2] || "").toLowerCase();
    const rowSession = values[i][3];
    if(rowEmail === emailLower && rowSession === session) return true;
  }
  return false;
}

/**
 * Returns one entry per candidate (deduped by email) for the "all attempts" admin map,
 * covering every candidate who has ever started a session — not just those currently
 * active. Only "session_start" rows carry a location (session_complete events don't
 * re-send it), so this reads those rows specifically. When a candidate appears more
 * than once (e.g. they started both Session 1 and Session 2, possibly from different
 * locations), the most recent location is used as the pin position, and every session
 * they've started is listed in `sessions` for the popup.
 */
function getAllLocationsRows(ss){
  const sheet = ss.getSheetByName(SESSIONS_TAB);
  if(!sheet) return [];
  const values = sheet.getDataRange().getValues();
  const byEmail = {};

  for(let i=1;i<values.length;i++){
    const row = values[i];
    const status = row[4];
    if(status !== "started") continue; // only start events carry location
    const lat = row[8], lng = row[9];
    if(lat === "" || lng === "" || lat == null || lng == null) continue;

    const email = row[2] || ("unknown_" + i);
    const timestamp = row[0];
    const entry = byEmail[email] || {
      name: row[1] || "Unknown",
      email: email,
      lat: lat, lng: lng,
      locationSource: row[7] || "",
      city: row[10] || "", region: row[11] || "",
      lastSeen: timestamp,
      sessions: []
    };

    entry.sessions.push({session: row[3], timestamp: timestamp});

    // Keep the most recent location as the pin position.
    if(new Date(timestamp).getTime() >= new Date(entry.lastSeen).getTime()){
      entry.lat = lat; entry.lng = lng;
      entry.locationSource = row[7] || "";
      entry.city = row[10] || ""; entry.region = row[11] || "";
      entry.lastSeen = timestamp;
    }

    byEmail[email] = entry;
  }

  return Object.values(byEmail);
}

function jsonOutput(obj){
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateSheet(ss, name, headers){
  let sheet = ss.getSheetByName(name);
  if(!sheet){
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function logSessionEvent(ss, data, status){
  const sheet = getOrCreateSheet(ss, SESSIONS_TAB,
    ["Timestamp","Candidate Name","Candidate Email","Session","Status","Roles Selected","Question IDs","Location Source","Lat","Lng","City","Region"]);
  const loc = data.location || {};
  sheet.appendRow([
    data.timestamp || new Date().toISOString(),
    safeCell_(data.candidate ? data.candidate.name : ""),
    safeCell_(data.candidate ? data.candidate.email : ""),
    data.session || "",
    status,
    data.roles ? data.roles.join(", ") : "",
    data.questionIds ? data.questionIds.join(", ") : "",
    loc.source || "",
    loc.lat != null ? loc.lat : "",
    loc.lng != null ? loc.lng : "",
    loc.city || "",
    loc.region || ""
  ]);
}

function logQuestionResponse(ss, data){
  const sheet = getOrCreateSheet(ss, RESPONSES_TAB,
    ["Timestamp","Candidate Name","Candidate Email","Session","Section","Question ID",
     "Answer Text","Selected Option","Correct?","Video Link","Time Spent (sec)","Auto-submitted (timeout)","Reason"]);

  let videoLink = "";
  if(data.videoBase64){
    videoLink = saveVideoToDrive(data);
  }

  sheet.appendRow([
    data.timestamp || new Date().toISOString(),
    safeCell_(data.candidate ? data.candidate.name : ""),
    safeCell_(data.candidate ? data.candidate.email : ""),
    data.session || "",
    data.section || "",
    data.questionId || "",
    safeCell_(data.answerText || ""),
    safeCell_(data.selectedOptionText || ""),
    data.isCorrect === true ? "Yes" : (data.isCorrect === false ? "No" : ""),
    videoLink,
    data.timeSpentSec || 0,
    data.type === "question_submit_autotimeout" ? "Yes" : "No",
    data.reason || ""
  ]);
}

function saveVideoToDrive(data){
  const rootFolder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const candidateName = (data.candidate && data.candidate.name) ? data.candidate.name : "unknown";
  const safeName = candidateName.replace(/[^a-zA-Z0-9]/g, "_");

  let candidateFolder;
  const existing = rootFolder.getFoldersByName(safeName);
  candidateFolder = existing.hasNext() ? existing.next() : rootFolder.createFolder(safeName);

  const bytes = Utilities.base64Decode(data.videoBase64);
  const blob = Utilities.newBlob(bytes, data.videoMime || "video/webm",
    (data.questionId || "response") + "_" + new Date().getTime() + ".webm");

  const file = candidateFolder.createFile(blob);
  return file.getUrl();
}

/* ---------- Completion acknowledgment email (receipt) ---------- */

const SESSION_DISPLAY_NAMES = {
  session1: "Session 1 — Quantitative Ability & Communication",
  session2: "Session 2 — Behavioral Competencies"
};

/**
 * Sends the candidate a short receipt-style confirmation email when their session ends,
 * whether by a normal Finish or an automatic submission (time limit / integrity violation).
 * Wrapped in try/catch so a failed send (e.g. daily MailApp quota exceeded, or a malformed
 * email) never breaks the underlying Sessions/Responses logging above it.
 */
function sendCompletionReceipt(data, status){
  try{
    const email = data.candidate && data.candidate.email;
    if(!email) return;
    const name = (data.candidate && data.candidate.name) || "Candidate";
    const sessionName = SESSION_DISPLAY_NAMES[data.session] || data.session || "Assessment session";
    const completedAt = data.timestamp || new Date().toISOString();
    const wasAuto = status && status.indexOf("auto-completed") === 0;

    const subject = "Altumind Assessment — " + sessionName + " received";
    const statusLine = wasAuto
      ? "Your responses were submitted automatically (" + status.replace("auto-completed ", "").replace(/[()]/g, "") + ") and have been recorded."
      : "Your responses have been recorded as submitted.";

    const body =
      "Hi " + name + ",\n\n" +
      "This confirms Altumind received your submission for:\n\n" +
      "  " + sessionName + "\n" +
      "  Completed at: " + completedAt + "\n\n" +
      statusLine + "\n\n" +
      "Keep this email as your receipt. If you believe this was submitted in error, or have any questions, contact " + "rashmi.kotagiri@altumindglobal.com" + ".\n\n" +
      "— Altumind";

    MailApp.sendEmail({
      to: email,
      subject: subject,
      body: body
    });
  } catch(err){
    // Swallow errors (e.g. daily send quota exceeded) — a missed receipt email
    // should never take down the underlying response logging.
    console.error("sendCompletionReceipt failed: " + err);
  }
}

/* ---------- Live tracking (for the admin live map) ---------- */

const LIVE_HEADERS = ["Candidate Email","Candidate Name","Session","Lat","Lng","Location Source","City","Region","Current Question","Last Seen"];

function upsertLive(ss, data){
  const sheet = getOrCreateSheet(ss, LIVE_TAB, LIVE_HEADERS);
  const email = data.candidate ? data.candidate.email : "";
  if(!email) return;

  const loc = data.location || {};
  const rowValues = [
    email,
    data.candidate ? data.candidate.name : "",
    data.session || "",
    loc.lat != null ? loc.lat : "",
    loc.lng != null ? loc.lng : "",
    loc.source || "",
    loc.city || "",
    loc.region || "",
    data.currentQuestionId || "",
    data.timestamp || new Date().toISOString()
  ];

  const values = sheet.getDataRange().getValues();
  let rowIndex = -1;
  for(let i=1;i<values.length;i++){
    if(values[i][0] === email && values[i][2] === data.session){ rowIndex = i+1; break; }
  }
  if(rowIndex > 0){
    sheet.getRange(rowIndex,1,1,rowValues.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }
}

function removeLive(ss, data){
  const sheet = ss.getSheetByName(LIVE_TAB);
  if(!sheet) return;
  const email = data.candidate ? data.candidate.email : "";
  const values = sheet.getDataRange().getValues();
  for(let i=values.length-1;i>=1;i--){
    if(values[i][0] === email && values[i][2] === data.session){
      sheet.deleteRow(i+1);
    }
  }
}

function getLiveRows(ss){
  const sheet = ss.getSheetByName(LIVE_TAB);
  if(!sheet) return [];
  const values = sheet.getDataRange().getValues();
  const now = new Date().getTime();
  const out = [];
  for(let i=1;i<values.length;i++){
    const row = values[i];
    const lastSeen = new Date(row[9]).getTime();
    if(isNaN(lastSeen)) continue;
    if((now - lastSeen) / 1000 > LIVE_WINDOW_SECONDS) continue;
    out.push({
      email:row[0], name:row[1], session:row[2],
      lat:row[3], lng:row[4], locationSource:row[5],
      city:row[6], region:row[7],
      currentQuestion:row[8], lastSeen:row[9]
    });
  }
  return out;
}
