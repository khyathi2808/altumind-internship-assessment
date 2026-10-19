/**
 * config.js — the one file you edit to point this dashboard at a different assessment
 * or change how it computes pass/fail. Everything else (analysis.js, app.js) reads from
 * this object rather than hardcoding numbers, so a new deployment is a config change,
 * not a code change.
 *
 * These defaults match review.html's DEFAULT_CFG exactly, so this dashboard and the
 * per-candidate review tool agree on every number unless you deliberately change one
 * of them here.
 */
export const CONFIG = {
  // Pre-fills the connect screen. Leave blank to always ask — recommended if this repo
  // (and therefore this file) is public, since the backend URL alone isn't secret but
  // you may not want it advertised. The admin key is NEVER stored here — see README.
  defaultEndpoint: "",

  // How much each section counts toward the overall total (must sum to something sane;
  // they don't have to sum to 100, they're just relative weights).
  weights: { quant: 35, comm: 25, beh: 40 },

  // Minimum % a candidate must clear in each section (and in "algo", the algorithmic-
  // thinking sub-score) to pass that gate. A candidate must clear every gate to show as
  // "Meets all gates".
  gates: { quant: 60, comm: 60, beh: 60, algo: 60 },

  // Inside the Quantitative section: how much of it is the 14 MCQs vs. the written items.
  mcqShare: 0.4,
  subjShare: 0.6,

  // Written reasoning counts double the MCQs for the "algorithmic thinking" sub-score,
  // since MCQs are the easiest item type to answer with outside help.
  algoSubjWeight: 2,

  // Only candidates at or above this MCQ percent are worth the dashboard's "priority"
  // sort in the leaderboard — mirrors the same cutoff the AI grading pipeline uses.
  mcqPriorityMin: 75,

  // Labels shown in the UI, keyed by the `section` value used in rubrics.json.
  sectionLabels: { quant: "Quantitative", comm: "Communication", beh: "Behavioral" },

  // Candidates whose email matches one of these is excluded from every chart and stat —
  // keep this in sync with whatever your grading backend treats as test/staff accounts.
  // Mirrors common.gs's TEST_EMAIL_* lists — change both together.
  excludeEmailPrefixes: ["test", "rohitkum"],
  excludeEmailDomains: ["altumindglobal.com", "mailinator.com"],
  excludeEmailSubstrings: ["altumindglobal"]
};
