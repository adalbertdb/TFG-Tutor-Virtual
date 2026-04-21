"use strict";

const AgentInterface = require("./base/AgentInterface");
const debugLogger = require("../../infrastructure/events/pipelineDebugLogger");

/**
 * TutorAgent: Builds the augmented prompt and calls the LLM.
 * Includes loop-breaking hints, frustration detection, and conversation progress.
 *
 * Extracted from ragMiddleware.js lines 540-582.
 */
class TutorAgent extends AgentInterface {
  /**
   * @param {object} deps
   * @param {import('../ports/services/ILlmService')} deps.llmService
   * @param {Function} deps.buildSystemPrompt - buildTutorSystemPrompt from promptBuilder.js
   * @param {object} deps.config
   */
  constructor(deps) {
    super("tutorAgent");
    this.llmService = deps.llmService;
    this.buildSystemPrompt = deps.buildSystemPrompt;
    this.config = deps.config;
  }

  async execute(context) {
    // 1. Build base system prompt
    const basePrompt = this.buildSystemPrompt(context.ejercicio, context.lang);

    // 2. Build conversation progress hint
    const progressHint = this._buildProgressHint(context.history);

    // 3. Build loop-breaking hints
    let repetitionHint = "";
    if (context.loopState.tutorRepeating) {
      repetitionHint =
        "[ANTI-REPETITION] You have been asking the same question repeatedly. " +
        "Change your approach: try a different angle, give a concrete hint, " +
        "or ask about a different aspect of the problem.\n\n";
    }

    let frustrationHint = "";
    if (context.loopState.studentFrustrated) {
      frustrationHint =
        "[STUDENT FRUSTRATED] The student is expressing frustration. " +
        "Acknowledge their effort, be encouraging, and provide a more " +
        "concrete hint to help them make progress.\n\n";
    }

    let stuckHint = "";
    const { consecutiveWrongTurns, totalAssistantTurns } = context.loopState;
    const MAX_WRONG_STREAK = this.config.MAX_WRONG_STREAK || 4;
    const MAX_TOTAL_TURNS = this.config.MAX_TOTAL_TURNS || 16;

    if (
      consecutiveWrongTurns >= MAX_WRONG_STREAK ||
      totalAssistantTurns >= MAX_TOTAL_TURNS
    ) {
      stuckHint =
        "[LOOP BREAKING - SCAFFOLD] The student has been stuck for too long. " +
        "Provide a very concrete hint: name a specific concept to review, " +
        "or narrow down the problem significantly. " +
        "Do NOT repeat the same question.\n\n";
    }

    // 4. Combine all into augmented prompt
    const augmentedPrompt =
      basePrompt +
      "\n\n" +
      progressHint +
      repetitionHint +
      frustrationHint +
      stuckHint +
      (context.ragResult.augmentation || "");

    // 5. Build messages: system + history + CURRENT user message.
    //    The current message is NOT yet persisted (PersistenceAgent writes it
    //    at the end of the pipeline), so we must append it explicitly here or
    //    the LLM would respond without knowing what the student just said.
    const messages = [
      { role: "system", content: augmentedPrompt },
      ...context.history,
      { role: "user", content: context.userMessage },
    ];
    context.llmMessages = messages;

    debugLogger.logPrompt(augmentedPrompt, context.classification?.type);
    const trace = require("../../infrastructure/events/pipelineDebugLogger");
    trace.traceLlmCall(context.reqId, "start", {
      model: this.config.OLLAMA_MODEL,
      messagesCount: messages.length,
      promptLen: augmentedPrompt.length,
      reason: "primary",
    });

    // 6. Call LLM — propagate budget from context if set
    const ollamaStart = Date.now();
    const elapsed = Date.now() - context.timing.pipelineStartMs;
    const remainingBudget = context.budgetMs != null ? Math.max(0, context.budgetMs - elapsed) : undefined;
    context.llmResponse = await this.llmService.chatCompletion(messages, {
      temperature: this.config.OLLAMA_TEMPERATURE,
      numPredict: this.config.OLLAMA_NUM_PREDICT,
      numCtx: this.config.OLLAMA_NUM_CTX,
      budgetMs: remainingBudget,
    });
    context.timing.ollamaMs = Date.now() - ollamaStart;

    trace.traceLlmCall(context.reqId, "end", {
      durationMs: context.timing.ollamaMs,
      responseLen: (context.llmResponse || "").length,
      reason: "primary",
      response: context.llmResponse,
    });
    debugLogger.logLlmOut(context.llmResponse);
  }

  _buildProgressHint(history) {
    if (!Array.isArray(history) || history.length < 2) return "";

    let lastAssistant = null;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === "assistant") {
        lastAssistant = history[i].content;
        break;
      }
    }
    if (!lastAssistant) return "";

    const questions = lastAssistant.match(/[^.!?]*\?/g);
    const lastQuestion =
      questions && questions.length > 0
        ? questions[questions.length - 1].trim()
        : null;
    if (!lastQuestion) return "";

    return (
      "[CONVERSATION CONTEXT]\n" +
      'Your last question to the student was: "' +
      lastQuestion +
      '"\n' +
      "Evaluate the student's current response as an answer to THIS question.\n" +
      "If they answered it correctly, acknowledge and advance. Do NOT re-ask.\n\n"
    );
  }
}

module.exports = TutorAgent;
