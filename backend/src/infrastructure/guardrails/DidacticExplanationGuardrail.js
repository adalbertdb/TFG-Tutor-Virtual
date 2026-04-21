"use strict";

const IGuardrail = require("../../domain/ports/services/IGuardrail");

/**
 * Detects when the tutor explains concepts didactically instead of scaffolding.
 * Patterns like "esto significa que", "cuando una resistencia está" etc.
 *
 * No surgical fix available — the whole response is an explanation; only an
 * LLM retry can turn it into a scaffolding question. Pipeline will fallback
 * to LLM retry if this fires.
 */
class DidacticExplanationGuardrail extends IGuardrail {
  get id() { return "didactic_explanation"; }
  get severity() { return "med"; }

  check(response, ctx) {
    if (typeof response !== "string") return { violated: false };
    const { checkDidacticExplanation } = require("../../domain/services/rag/guardrails");
    const r = checkDidacticExplanation(response);
    if (!r || !r.explaining) return { violated: false };
    return { violated: true, evidence: r.details };
  }

  buildRetryHint(lang) {
    const { getScaffoldInstruction } = require("../../domain/services/rag/guardrails");
    return getScaffoldInstruction(lang || "es");
  }
}

module.exports = DidacticExplanationGuardrail;
