/**
 * grading_orchestrator.gs - one trigger that drives both AI scorers (text in ai.gs, video
 * in video_grading.gs) from a single schedule, instead of two independent timers.
 *
 * This matters for one concrete reason: ai.gs's own budget (AI_BUDGET_MS, 4 min) and
 * video_grading.gs's own budget (VIDEO_BUDGET_MS, 4 min) were each sized assuming they'd
 * run ALONE in a 6-minute Apps Script execution. Call them back-to-back in one trigger
 * without adjusting that, and you get an 8-minute request that Apps Script will simply
 * kill partway through — which doesn't corrupt anything (every write is a single
 * atomic appendRow), but wastes the run and makes failures look mysterious. This file
 * exists to split one real 6-minute ceiling between the two phases correctly.
 *
 * Use this instead of ai.gs's aiInstallTrigger once you're running both scorers.
 * (ai.gs's aiInstallTrigger / aiRun_() and video_grading.gs's videoRun_() still work
 * completely standalone — with their own default budgets — if you ever want to run only
 * one of them, e.g. while debugging the other.)
 */
const GRADING_TOTAL_BUDGET_MS = 5 * 60 * 1000; // ~1 min margin under the real 6-min ceiling for sheet I/O, Drive reads, etc.
const GRADING_TEXT_SHARE_MS = 3 * 60 * 1000;   // text goes first: far more text answers than video ones, and each call is cheap

function gradingInstallTrigger(){
  gradingRemoveTrigger();
  ScriptApp.newTrigger("gradingRunBatch").timeBased().everyMinutes(10).create();
}
function gradingRemoveTrigger(){
  ScriptApp.getProjectTriggers().forEach(t => { if(t.getHandlerFunction() === "gradingRunBatch") ScriptApp.deleteTrigger(t); });
}

/** Runs text scoring, then whatever video scoring fits in the time left over, in one execution. */
function gradingRunBatch(){
  const t0 = Date.now();
  const results = {text:null, video:null};

  results.text = aiConfigured_()
    ? aiRun_(Math.min(GRADING_TEXT_SHARE_MS, GRADING_TOTAL_BUDGET_MS))
    : {ok:false, error:"text AI not configured"};

  const remaining = GRADING_TOTAL_BUDGET_MS - (Date.now() - t0);
  if(!videoConfigured_()){
    results.video = {ok:false, error:"video AI not configured"};
  } else if(remaining < 20000){
    results.video = {ok:true, scored:0, note:"no time left this run after text scoring"};
  } else {
    results.video = videoRun_(remaining);
  }

  Logger.log(JSON.stringify(results));
  return results;
}

function gradingStatus_(){
  return {
    ok:true,
    text: aiConfigured_() ? aiStatus_() : {configured:false},
    video: videoConfigured_() ? videoStatus_() : {configured:false}
  };
}
