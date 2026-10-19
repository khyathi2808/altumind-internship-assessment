# Altumind Internship Assessment — Deployment Notes

## Files
- `index.html` — candidate-facing app. Single file, deploy as-is to GitHub Pages.
- `admin.html` — live map of currently active candidates. Deployed alongside `index.html` but not linked from it — keep this URL private, it's gated by an admin key but the URL itself isn't otherwise hidden.
- `backend.gs` — Apps Script backend. Paste into a new Apps Script project bound to a Google Sheet.

## Setup order
1. Create the Google Sheet and Drive folder first (empty is fine — the script creates tabs automatically).
2. Paste `backend.gs` into Extensions > Apps Script on that Sheet, fill in `SHEET_ID`, `DRIVE_FOLDER_ID`, and `ADMIN_KEY` (a secret string you choose — this gates the live-map endpoint).
3. Deploy as Web App (execute as *me*, access *anyone*). Copy the resulting URL.
4. Paste that URL into `ENDPOINT_URL` near the top of `index.html`.
5. Open `admin.html`, enter the same Web App URL and your `ADMIN_KEY` once — it's saved in that browser's local storage for next time.
6. Push everything to your GitHub Pages repo.
7. Open the live link yourself once end-to-end (both sessions, including a video item, and check the live map updates) before sending it to candidates, and check the Sheet + Drive folder populate correctly.

## What's implemented

**Core flow (from earlier rounds):**
- Two independent sessions (Session 1: Quant + Communication, 25 questions, 60 min / Session 2: Behavioral, role-driven, 60 min), selectable at the start screen, same link.
- Global countdown timer per session, auto-submits everything at zero.
- Per-question stopwatch that pauses on Review and resumes/accumulates on return, stops permanently at Submit.
- One question per screen, question map showing not-started / in-progress / submitted, locked questions cannot be reopened.
- Session 1: 14 objective MCQs (auto-graded, logged as correct/incorrect) + 6 subjective written items, each targeting a distinct thinking pattern (arithmetic, pattern recognition, probability, statistical reasoning, root-cause elimination, proportional reasoning with bottlenecks, etc.) rather than repeating the same skill — plus 5 communication items (2 written incl. Mom's Test critique x2, 1 more Mom's Test, 2 video).
- Session 2 role selection drives which competency scenarios appear — multi-track candidates get the full 6-scenario set per track (12 if two tracks).
- Video capture (90 sec cap, live preview, re-record allowed until submit).
- All answers and timing sent to Apps Script on every question submit (not just at the end), so a browser crash mid-session doesn't lose earlier answers.
- Rubric is intentionally not built into this app — score manually against your existing rubric using the Responses sheet, except MCQs which are objectively auto-graded.

**New this round:**
- **Location capture (GPS with IP fallback):** on starting a session, the candidate is shown a consent checkbox ("collects my approximate location and monitors tab/window focus") that must be checked to proceed. If checked, the browser requests GPS permission; if denied or unavailable, it falls back to IP-based geolocation via `ipapi.co` (free tier, no key — rate-limited, so consider a paid key if you run high candidate volume). A heartbeat with current location and question ID is sent every 20 seconds while a session is active.
- **Live map (`admin.html`):** polls the backend every 15 seconds and plots currently active candidates (heartbeat within the last 60 seconds) on an OpenStreetMap/Leaflet map, with a popup showing name, email, session, current question, and location source.
- **Copy/paste disabled:** copy, cut, paste, and right-click context menu are blocked globally across the app for the whole session. Question text is also not selectable via CSS as a second layer.
- **Tab/window-switch auto-submit:** if the candidate switches to another browser tab, opens a new tab/window, or the window loses focus, the session is submitted immediately with whatever was answered so far, and the candidate sees a message explaining why. This starts only after they click "Start session" (not during landing/role-selection), so browsing around beforehand isn't penalized.

## Assumptions and honest limitations — please read before deploying

- **Consent is required, not optional or silent.** Location and activity monitoring can't be done covertly anyway (the browser prompts for GPS regardless), and India's DPDP Act treats this as personal data requiring consent. I built in an explicit checkbox rather than skipping it. You may want your own legal read on this before running it on real candidates, especially around how long you retain location data and who can access the Sheet.
- **Tab-switch detection is best-effort, not foolproof.** It reliably catches: opening a new tab, switching to an existing tab, minimizing the window, or bringing another application to the foreground on the same screen. It will **not** catch a candidate using a second physical monitor to view notes/AI tools while this tab stays visible and focused on monitor one — there's no browser API for that. Say this plainly to candidates rather than implying full proctoring.
- **Copy/paste blocking is also best-effort.** It stops the standard menu/keyboard paths (Ctrl+C/V, right-click). It does not stop a candidate typing from something they're reading on a second screen, which is a fundamentally different problem browser APIs can't solve.
- **IP-based location is approximate** (often city-level, sometimes off by tens of kilometers, and can reflect the candidate's ISP/VPN exit point rather than their literal location). Treat it as a rough integrity signal, not a precise address.
- **`ADMIN_KEY` is a shared secret in code, not real auth.** Anyone with the key and the Web App URL can see all live candidate locations. Keep both private, and change the key if you ever suspect it's leaked (requires a re-deploy).
- **Session 2 time limit (60 min):** not explicitly specified for that session; matches Session 1's 60 min. Change `SESSION_TIME_LIMITS.session2` in `index.html` if that's wrong.
- **Video codec:** recorded as `video/webm`. Safari support for `MediaRecorder` is inconsistent — test on Safari/iOS specifically, or restrict candidate instructions to desktop Chrome/Firefox.
- **No resume-across-devices:** if a candidate closes the tab mid-session, submitted questions are safely in your Sheet, but in-progress (reviewed, not submitted) answers and timer state restart if they reopen the link.

## Not yet built (flag if you want these next)
- Resume-after-disconnect for in-progress sessions.
- Any further anti-cheating beyond what's described above (e.g. flagging unusually fast MCQ completion, browser fingerprinting).

## Newest round: creative landing page, live map link, single attempt
- **Creative, welcoming landing page:** a warm hero section (distinct from the neutral, focus-first design of the actual test screens) with product pills for Clinexia.AI / Merxflo / Dronafy and a one-time entrance animation, meant to feel energetic rather than like walking into an exam hall. The actual question screens deliberately stay plain and low-distraction — the warmth is front-loaded before the clock starts.
- **Single attempt per session:** once a candidate starts a session, that email + session combination is permanently locked (checked against the Sessions sheet via a `check_attempt` backend call before they're allowed to proceed past the landing page, backed up by a local browser flag for instant feedback). They cannot restart, even in a new browser or incognito window, as long as the email matches.
- **Live map link is separate and not linked anywhere in the candidate app** (`admin.html`) — candidates have no path to it from `index.html`.

**Important consequence:** combined with the earlier no-resume limitation, if a candidate's browser crashes, their network drops, or they accidentally close the tab mid-session, **they cannot get back in** — the Sessions sheet already has a "started" row for their email, so `check_attempt` will block them. You'll need a manual override path — the simplest is deleting or editing that candidate's row in the `Sessions` tab yourself if a legitimate technical failure happens and they need a second chance. Worth deciding this policy before candidates start using it, since there's no in-app way for a candidate to self-recover.

## Analytics dashboard and grading

`dashboard/` is a static analytics dashboard (charts and a leaderboard), served by Pages at
`/dashboard/`. It reads from this same Web App using the admin key. Written answers are
first-pass scored by Claude (`ai.gs`) and video answers by Gemini (`video_grading.gs`), on one
10-minute trigger (`grading_orchestrator.gs`), into a **Scores** tab. `ADMIN_KEY` now comes
from Script properties, not `backend.gs`. Setup steps are in [dashboard/README.md](dashboard/README.md).
`rubrics.gs` (the answer key) is private and never committed.
