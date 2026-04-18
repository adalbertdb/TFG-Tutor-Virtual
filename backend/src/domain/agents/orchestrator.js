"use strict";

const AgentContext = require("./base/AgentContext");

/**
 * TutoringOrchestrator: Coordinates the agent pipeline for each tutoring interaction.
 *
 * Pipeline stages (each may be skipped based on context):
 * 1. CONTEXT         → Load exercise, history, language, loop state
 * 2. INPUT GUARDRAIL → Block prompt injection / off-topic BEFORE the LLM
 * 3. CLASSIFY        → Classify student message
 * 4. RETRIEVE        → RAG retrieval (BM25 + semantic + KG)
 * 5. TUTOR           → Build prompt + call LLM
 * 6. GUARDRAIL (out) → Validate response safety
 * 7. PERSIST         → Save messages + log
 *
 * Returns an AgentContext with the final response and metadata.
 */
class TutoringOrchestrator {
  /**
   * @param {object} agents - Agent registry
   * @param {import('./contextAgent')} agents.context
   * @param {import('./classifierAgent')} agents.classifier
   * @param {import('./retrievalAgent')} agents.retrieval
   * @param {import('./tutorAgent')} agents.tutor
   * @param {import('./guardrailAgent')} agents.guardrail
   * @param {import('./persistenceAgent')} agents.persistence
   * @param {object} [options]
   * @param {Function} [options.emitEvent] - Event emitter for workflow monitoring
   */
  constructor(agents, options = {}) {
    this.agents = agents;
    this.emitEvent = options.emitEvent || (() => {});
  }

  /**
   * Process a tutoring request through the full agent pipeline.
   *
   * @param {object} request
   * @param {string}      request.userId
   * @param {string}      request.exerciseId
   * @param {string}      request.userMessage
   * @param {string|null} request.interaccionId
   * @returns {Promise<AgentContext>}
   */
  async process(request) {
    const ctx = new AgentContext(request);

    try {
      // Stage 1: Load context
      this.emitEvent("agent_start", "context", { agent: "contextAgent" });
      await this.agents.context.execute(ctx);
      this.emitEvent("agent_end", "context", { agent: "contextAgent" });

      if (ctx.fallthrough) return ctx;

      // Stage 2: Input guardrail (prompt injection / off-topic)
      this.emitEvent("agent_start", "input_guardrail", {
        agent: "inputGuardrailAgent",
      });
      await this.agents.inputGuardrail.execute(ctx);
      this.emitEvent("agent_end", "input_guardrail", {
        agent: "inputGuardrailAgent",
        blocked: ctx.inputBlocked,
        category: ctx.inputSecurity?.category,
      });

      if (ctx.inputBlocked) {
        ctx.timing.pipelineMs = Date.now() - ctx.timing.pipelineStartMs;
        await this.agents.persistence.execute(ctx);
        return ctx;
      }

      // Stage 3: Classify
      this.emitEvent("agent_start", "classify", { agent: "classifierAgent" });
      await this.agents.classifier.execute(ctx);
      this.emitEvent("agent_end", "classify", {
        agent: "classifierAgent",
        classification: ctx.classification?.type,
      });

      // Early exit: greeting or off-topic → let fallback handler deal with it
      if (
        ctx.classification?.type === "greeting" ||
        ctx.classification?.type === "off_topic"
      ) {
        ctx.fallthrough = true;
        return ctx;
      }

      // Stage 3: Retrieve
      this.emitEvent("agent_start", "retrieve", {
        agent: "retrievalAgent",
      });
      if (!this.agents.retrieval.canSkip(ctx)) {
        await this.agents.retrieval.execute(ctx);
      }
      this.emitEvent("agent_end", "retrieve", {
        agent: "retrievalAgent",
        decision: ctx.ragResult?.decision,
        sourcesCount: ctx.ragResult?.sources?.length || 0,
      });

      // Check for deterministic finish
      if (this._shouldFinishDeterministically(ctx)) {
        ctx.deterministicFinish = true;
        ctx.finalResponse = this._buildFinishMessage(ctx);
        ctx.timing.pipelineMs = Date.now() - ctx.timing.pipelineStartMs;

        // Save and return
        await this.agents.persistence.execute(ctx);
        return ctx;
      }

      // Stage 4: Generate (Tutor)
      this.emitEvent("agent_start", "tutor", { agent: "tutorAgent" });
      await this.agents.tutor.execute(ctx);
      this.emitEvent("agent_end", "tutor", { agent: "tutorAgent" });

      // Stage 5: Validate (Guardrail)
      this.emitEvent("agent_start", "guardrail", {
        agent: "guardrailAgent",
      });
      if (!this.agents.guardrail.canSkip(ctx)) {
        await this.agents.guardrail.execute(ctx);
      } else {
        ctx.finalResponse = ctx.llmResponse;
      }
      this.emitEvent("agent_end", "guardrail", {
        agent: "guardrailAgent",
        triggered: ctx.guardrailsTriggered,
      });

      ctx.timing.pipelineMs = Date.now() - ctx.timing.pipelineStartMs;

      // Stage 6: Persist
      await this.agents.persistence.execute(ctx);

      return ctx;
    } catch (error) {
      console.error("[Orchestrator] Pipeline error:", error.message);
      ctx.error = error;
      return ctx;
    }
  }

  /**
   * Check if the exercise should be finished deterministically.
   * We ONLY finish when the student has shown good reasoning — never on
   * "correct_no_reasoning" or "correct_wrong_reasoning" alone, even after
   * many turns. This enforces "justify before validating" pedagogically.
   */
  _shouldFinishDeterministically(ctx) {
    const cls = ctx.classification?.type;
    const { prevCorrectTurns } = ctx.loopState;

    return cls === "correct_good_reasoning" && prevCorrectTurns >= 1;
  }

  /**
   * Closure message: congratulate, ask for remaining doubts, and mark
   * <FIN_EJERCICIO> so the frontend closes the session. The student can
   * still ask follow-up questions in the same chat; those are re-evaluated
   * by the pipeline on the next turn.
   */
  _buildFinishMessage(ctx) {
    const lang = ctx.lang;
    if (lang === "en") {
      return "Excellent work! You've correctly identified the answer and justified it well. Before we close: do you have any remaining doubts about this circuit or the concepts involved? <FIN_EJERCICIO>";
    }
    if (lang === "val") {
      return "Excel·lent treball! Has identificat correctament la resposta i l'has justificat bé. Abans de tancar: tens algun dubte pendent sobre aquest circuit o els conceptes implicats? <FIN_EJERCICIO>";
    }
    return "¡Excelente trabajo! Has identificado correctamente la respuesta y la has justificado bien. Antes de cerrar: ¿te queda alguna duda sobre este circuito o los conceptos implicados? <FIN_EJERCICIO>";
  }
}

module.exports = TutoringOrchestrator;
