"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");
const { getElementNamingInstruction } = require("../../domain/services/languageManager");

/**
 * Detects when the tutor names specific EVALUABLE elements in questions or
 * directives, which undermines the Socratic method (the student should
 * discover which elements matter, not be pointed at them).
 *
 * Thin wrapper over the existing domain function: this guardrail uses the
 * same logic as before. No false-positive fix needed here.
 */
class ElementNamingGuardrail extends IGuardrail {
  get id() { return "element_naming"; }
  get severity() { return "med"; }

  check(response, ctx) {
    if (typeof response !== "string") return { violated: false };
    const evaluableElements = (ctx && ctx.evaluableElements) || [];
    // No early return on empty evaluableElements: checkElementNaming has a
    // regex fallback that extracts R\d+ from the response itself, so we can
    // still catch obvious naming violations even when the exercise's
    // elementosEvaluables is incomplete or missing in the DB.
    const { checkElementNaming } = require("../../domain/services/rag/guardrails");
    const r = checkElementNaming(response, evaluableElements);
    if (!r || !r.named) return { violated: false };
    return { violated: true, evidence: r.details };
  }

  surgicalFix(response, ctx) {
    if (typeof response !== "string") return null;
    const correctAnswer = (ctx && ctx.correctAnswer) || [];
    const lang = (ctx && ctx.lang) || "es";
    const { redactElementMentions } = require("../../domain/services/rag/guardrails");
    const r = redactElementMentions(response, correctAnswer, lang);
    if (!r || !r.redacted) return { applied: false, text: response };
    return { applied: true, text: r.text, before: response, after: r.text };
  }

  buildRetryHint(lang) {
    return getElementNamingInstruction(lang || "es");
  }
}

module.exports = ElementNamingGuardrail;
