"use strict";

// Unified pipeline debug/trace logger.
// Enable with DEBUG_PIPELINE=1. When disabled, every call is a no-op.
//
// Prefix: [TRACE] for the request-level flow trace (one line per stage)
// Prefix: [DEBUG_PIPELINE] kept for backward compat with agent calls
//
// Grep usage:
//   Full trace:       grep "TRACE"
//   Only decisions:   grep "TRACE.*decision\|TRACE.*fallthrough\|TRACE.*gate"
//   Only errors:      grep "TRACE.*ERROR\|TRACE.*fallthrough"
//   Legacy pipeline:  grep "DEBUG_PIPELINE"

const TAG = "[TRACE]";

function isOn() {
  return process.env.DEBUG_PIPELINE === "1";
}

function shortStr(s, max) {
  if (typeof s !== "string") return "";
  if (s.length <= max) return s;
  return s.substring(0, max) + "...(+" + (s.length - max) + ")";
}

function tailStr(s, max) {
  if (typeof s !== "string") return "";
  if (s.length <= max) return s;
  return "...(" + (s.length - max) + " before)..." + s.substring(s.length - max);
}

function oneLine(s) {
  if (typeof s !== "string") return "";
  return s.replace(/\r?\n/g, " | ").replace(/\s+/g, " ").trim();
}

// ─── Request lifecycle ───────────────────────────────────────────────────────

let _reqSeq = 0;

/**
 * Start tracing a new request. Returns a reqId for correlation.
 * Logs: handler identification + basic params.
 */
function traceRequestStart(handler, params) {
  if (!isOn()) return "";
  _reqSeq++;
  var id = "req" + _reqSeq;
  console.log(
    TAG + " [" + id + "] ▶ START handler=" + handler
    + " userId=" + (params.userId || "-")
    + " exerciseId=" + (params.exerciseId || "-")
    + " interaccionId=" + (params.interaccionId || "-")
    + " msgLen=" + (params.userMessage ? params.userMessage.length : 0)
    + " msg=" + JSON.stringify(shortStr(params.userMessage || "", 80))
  );
  return id;
}

function traceRequestEnd(reqId, outcome) {
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] ◀ END"
    + " outcome=" + (outcome.outcome || "-")
    + " totalMs=" + (outcome.totalMs || 0)
    + " responseLen=" + (outcome.responseLen || 0)
    + (outcome.classification ? " class=" + outcome.classification : "")
    + (outcome.decision ? " decision=" + outcome.decision : "")
    + (outcome.guardrailTriggered ? " guardrail=YES" : "")
  );
}

// ─── RAG Middleware gates ────────────────────────────────────────────────────

/**
 * Log why the ragMiddleware decided to fall through (call next()).
 * This is the MOST IMPORTANT log for diagnosing "why didn't RAG handle it?"
 */
function traceRagGate(reqId, reason, details) {
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] ⛔ RAG_FALLTHROUGH reason=\"" + reason + "\""
    + (details ? " " + formatDetails(details) : "")
  );
}

/**
 * Log that RAG middleware IS handling this request.
 */
function traceRagAccepted(reqId, details) {
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] ✓ RAG_ACCEPTED"
    + " exerciseNum=" + (details.exerciseNum || "-")
    + " correctAnswer=" + JSON.stringify(details.correctAnswer || [])
    + " evaluableElements=" + (details.evaluableElements || []).length
    + " lang=" + (details.lang || "-")
  );
}

// ─── Pipeline stages (ragMiddleware) ─────────────────────────────────────────

function traceSecurity(reqId, result) {
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] 🛡️ SECURITY"
    + " safe=" + result.safe
    + " category=" + (result.category || "-")
    + " pattern=" + (result.matchedPattern || "-")
  );
}

function traceClassify(reqId, classification) {
  if (!isOn()) return;
  var c = classification || {};
  console.log(
    TAG + " [" + reqId + "] 🏷️ CLASSIFY"
    + " type=" + (c.type || "-")
    + " decision=" + (c.decision || "-")
    + " proposed=" + JSON.stringify(c.proposed || [])
    + " negated=" + JSON.stringify(c.negated || [])
    + " concepts=" + JSON.stringify(c.concepts || [])
    + " hasReasoning=" + !!c.hasReasoning
  );
}

function traceLoopState(reqId, state) {
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] 🔄 LOOP_STATE"
    + " prevCorrectTurns=" + (state.prevCorrectTurns || 0)
    + " wrongStreak=" + (state.wrongStreak || 0)
    + " totalTurns=" + (state.totalTurns || 0)
    + " repetition=" + !!state.repetition
    + " frustration=" + !!state.frustration
    + " demandJustification=" + !!state.demandJustification
    + " stuckHint=" + !!state.stuckHint
  );
}

function traceDeterministicFinish(reqId, details) {
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] 🏁 DETERMINISTIC_FINISH"
    + " classification=" + (details.classification || "-")
    + " prevCorrectTurns=" + (details.prevCorrectTurns || 0)
    + " source=" + (details.source || "-")
    + " responseLen=" + (details.responseLen || 0)
  );
}

function traceLlmCall(reqId, phase, details) {
  if (!isOn()) return;
  if (phase === "start") {
    console.log(
      TAG + " [" + reqId + "] 🤖 LLM_CALL_START"
      + " model=" + (details.model || "-")
      + " messagesCount=" + (details.messagesCount || 0)
      + " promptLen=" + (details.promptLen || 0)
      + " reason=" + (details.reason || "primary")
    );
  } else {
    console.log(
      TAG + " [" + reqId + "] 🤖 LLM_CALL_END"
      + " durationMs=" + (details.durationMs || 0)
      + " responseLen=" + (details.responseLen || 0)
      + " reason=" + (details.reason || "primary")
      + " head=" + JSON.stringify(shortStr(details.response || "", 120))
    );
  }
}

function traceGuardrails(reqId, results) {
  if (!isOn()) return;
  var flags = [];
  if (results.solutionLeak) flags.push("LEAK");
  if (results.falseConfirmation) flags.push("FALSE_CONFIRM");
  if (results.prematureConfirmation) flags.push("PREMATURE");
  if (results.stateReveal) flags.push("STATE_REVEAL");
  if (results.elementNaming) flags.push("ELEMENT_NAMING");
  if (results.didacticExplanation) flags.push("DIDACTIC");
  if (results.styleFixed) flags.push("STYLE");
  if (results.finStripped) flags.push("FIN_STRIPPED");
  console.log(
    TAG + " [" + reqId + "] 🚧 GUARDRAILS"
    + " triggered=" + (flags.length > 0)
    + " flags=[" + flags.join(",") + "]"
    + " retries=" + (results.retries || 0)
    + " finalLen=" + (results.finalLen || 0)
    + " finalHead=" + JSON.stringify(shortStr(results.finalResponse || "", 120))
  );
}

function traceResponse(reqId, details) {
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] 📤 RESPONSE_SENT"
    + " len=" + (details.len || 0)
    + " containsFIN=" + !!details.containsFIN
    + " head=" + JSON.stringify(shortStr(details.response || "", 120))
  );
}

function traceError(reqId, stage, error) {
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] ❌ ERROR stage=" + stage
    + " message=" + JSON.stringify((error && error.message) || String(error))
    + " code=" + ((error && error.code) || "-")
  );
}

// ─── Route handler specific ──────────────────────────────────────────────────

function traceRouteHandler(reqId, event, details) {
  if (!isOn()) return;
  console.log(
    TAG + " [" + reqId + "] 📡 ROUTE_HANDLER event=" + event
    + (details ? " " + formatDetails(details) : "")
  );
}

// ─── Legacy compatibility (agents use these) ─────────────────────────────────

function logSecurity(userMessage, result) {
  if (!isOn()) return;
  var line = "[DEBUG_PIPELINE] stage=security"
    + " safe=" + result.safe
    + " category=" + (result.category || "-")
    + " pattern=" + (result.matchedPattern || "-")
    + " msg=" + JSON.stringify(shortStr(userMessage || "", 160));
  console.log(line);
}

function logClassify(userMessage, classification) {
  if (!isOn()) return;
  var c = classification || {};
  var line = "[DEBUG_PIPELINE] stage=classify"
    + " type=" + (c.type || "-")
    + " proposed=" + JSON.stringify(c.proposed || [])
    + " negated=" + JSON.stringify(c.negated || [])
    + " concepts=" + JSON.stringify(c.concepts || [])
    + " hasReasoning=" + !!c.hasReasoning
    + " msg=" + JSON.stringify(shortStr(userMessage || "", 160));
  console.log(line);
}

function logPrompt(augmentedPrompt, classificationType) {
  if (!isOn()) return;
  var len = typeof augmentedPrompt === "string" ? augmentedPrompt.length : 0;
  var tail = tailStr(augmentedPrompt || "", 1200);
  console.log(
    "[DEBUG_PIPELINE] stage=prompt"
    + " classType=" + (classificationType || "-")
    + " totalLen=" + len
    + " tail=" + JSON.stringify(oneLine(tail))
  );
}

function logLlmOut(response) {
  if (!isOn()) return;
  var head = shortStr(response || "", 400);
  console.log(
    "[DEBUG_PIPELINE] stage=llm_out"
    + " len=" + ((response || "").length)
    + " head=" + JSON.stringify(oneLine(head))
  );
}

function logGuardrail(triggered, finalResponse) {
  if (!isOn()) return;
  var t = triggered || {};
  var line = "[DEBUG_PIPELINE] stage=guardrail"
    + " solutionLeak=" + !!t.solutionLeak
    + " falseConfirmation=" + !!t.falseConfirmation
    + " prematureConfirmation=" + !!t.prematureConfirmation
    + " stateReveal=" + !!t.stateReveal
    + " finalHead=" + JSON.stringify(oneLine(shortStr(finalResponse || "", 300)));
  console.log(line);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDetails(obj) {
  if (!obj) return "";
  var parts = [];
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var v = obj[keys[i]];
    if (v === undefined || v === null) continue;
    if (typeof v === "string") {
      parts.push(keys[i] + "=" + JSON.stringify(shortStr(v, 60)));
    } else if (typeof v === "object") {
      parts.push(keys[i] + "=" + JSON.stringify(v));
    } else {
      parts.push(keys[i] + "=" + v);
    }
  }
  return parts.join(" ");
}

module.exports = {
  // Activation check
  isOn: isOn,

  // Request lifecycle
  traceRequestStart: traceRequestStart,
  traceRequestEnd: traceRequestEnd,

  // RAG middleware decisions
  traceRagGate: traceRagGate,
  traceRagAccepted: traceRagAccepted,

  // Pipeline stages
  traceSecurity: traceSecurity,
  traceClassify: traceClassify,
  traceLoopState: traceLoopState,
  traceDeterministicFinish: traceDeterministicFinish,
  traceLlmCall: traceLlmCall,
  traceGuardrails: traceGuardrails,
  traceResponse: traceResponse,
  traceError: traceError,

  // Route handler
  traceRouteHandler: traceRouteHandler,

  // Legacy (backward compat with agents)
  logSecurity: logSecurity,
  logClassify: logClassify,
  logPrompt: logPrompt,
  logLlmOut: logLlmOut,
  logGuardrail: logGuardrail,
};
