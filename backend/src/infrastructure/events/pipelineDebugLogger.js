"use strict";

// Zero-overhead pipeline debug logger.
// Enable with DEBUG_PIPELINE=1. When disabled, every call returns immediately.
//
// Each stage prints ONE line prefixed with [DEBUG_PIPELINE] so the full flow
// can be grepped with: `node server.js | grep DEBUG_PIPELINE`
//
// Stages instrumented:
//   - security  : what HeuristicSecurityAdapter decided (safe / blocked + pattern)
//   - classify  : classifier output (type, proposed, negated, concepts, hasReasoning)
//   - prompt    : final augmented prompt sent to the LLM (tail only, 1200 chars)
//   - llm_out   : raw LLM response (first 400 chars)
//   - guardrail : which guardrails fired and the final response tail

function isOn() {
  return process.env.DEBUG_PIPELINE === "1";
}

function shortStr(s, max) {
  if (typeof s !== "string") return "";
  if (s.length <= max) return s;
  return s.substring(0, max) + "...(truncated " + (s.length - max) + ")";
}

function tailStr(s, max) {
  if (typeof s !== "string") return "";
  if (s.length <= max) return s;
  return "...(" + (s.length - max) + " chars before)..." + s.substring(s.length - max);
}

function oneLine(s) {
  if (typeof s !== "string") return "";
  return s.replace(/\r?\n/g, " \\n ").replace(/\s+/g, " ").trim();
}

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

module.exports = {
  isOn: isOn,
  logSecurity: logSecurity,
  logClassify: logClassify,
  logPrompt: logPrompt,
  logLlmOut: logLlmOut,
  logGuardrail: logGuardrail,
};
