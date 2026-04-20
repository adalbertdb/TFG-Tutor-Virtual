"use strict";

const AgentInterface = require("./base/AgentInterface");
const debugLogger = require("../../infrastructure/events/pipelineDebugLogger");

/**
 * GuardrailAgent: Validates LLM responses against educational safety rules.
 * Checks for solution leak, false confirmation, premature confirmation,
 * state reveal, and element naming violations. Retries with stronger
 * instructions when violations are detected.
 *
 * Extracted from ragMiddleware.js lines 585-703.
 */
class GuardrailAgent extends AgentInterface {
  /**
   * @param {object} deps
   * @param {import('../ports/services/ILlmService')} deps.llmService
   * @param {object} deps.guardrails - The guardrails module (guardrails.js)
   * @param {Function} deps.buildSystemPrompt
   * @param {object} deps.config
   */
  constructor(deps) {
    super("guardrailAgent");
    this.llmService = deps.llmService;
    this.guardrails = deps.guardrails;
    this.buildSystemPrompt = deps.buildSystemPrompt;
    this.config = deps.config;
  }

  canSkip(context) {
    return context.deterministicFinish;
  }

  async execute(context) {
    let response = context.llmResponse;
    const g = this.guardrails;
    const triggered = {
      solutionLeak: false,
      falseConfirmation: false,
      prematureConfirmation: false,
      stateReveal: false,
    };

    // 1. Solution Leak Check
    if (g.checkSolutionLeak(response, context.correctAnswer)) {
      triggered.solutionLeak = true;
      response = await this._retry(
        context,
        g.getStrongerInstruction(context.lang)
      );
    }

    // 2. False Confirmation Check
    if (
      g.checkFalseConfirmation(response, context.classification?.type)
    ) {
      triggered.falseConfirmation = true;
      response = await this._retry(
        context,
        g.getFalseConfirmationInstruction(context.lang)
      );
    }

    // 3. Premature Confirmation Check
    if (
      g.checkPrematureConfirmation(response, context.classification?.type)
    ) {
      triggered.prematureConfirmation = true;
      response = await this._retry(
        context,
        g.getPartialConfirmationInstruction(
          context.lang,
          context.classification?.type
        )
      );
    }

    // 4. State Reveal Check — generic over evaluableElements + KG-derived
    // concept patterns. If LLM retries can't fix it, surgical redaction.
    var stateCheck = g.checkStateReveal(
      response,
      context.evaluableElements,
      context.kgConceptPatterns || []
    );
    for (var stateAttempt = 1; stateAttempt <= 2 && stateCheck.revealed; stateAttempt++) {
      triggered.stateReveal = true;
      response = await this._retry(
        context,
        g.getStateRevealInstruction(context.lang)
      );
      stateCheck = g.checkStateReveal(
        response,
        context.evaluableElements,
        context.kgConceptPatterns || []
      );
    }
    if (stateCheck.revealed && typeof g.redactStateRevealSentence === "function") {
      var redact = g.redactStateRevealSentence(
        response,
        context.evaluableElements,
        stateCheck.pattern,
        context.lang
      );
      if (redact.redacted) {
        triggered.stateReveal = true;
        response = redact.text;
      }
    }

    context.finalResponse = response;
    context.guardrailsTriggered = triggered;

    debugLogger.logGuardrail(triggered, response);
  }

  async _retry(context, additionalInstruction) {
    const basePrompt = this.buildSystemPrompt(
      context.ejercicio,
      context.lang
    );
    const augmented =
      basePrompt +
      "\n\n" +
      additionalInstruction +
      "\n\n" +
      (context.ragResult.augmentation || "");

    const messages = [
      { role: "system", content: augmented },
      ...context.history,
    ];

    return this.llmService.chatCompletion(messages, {
      temperature: this.config.OLLAMA_TEMPERATURE,
      numPredict: this.config.OLLAMA_NUM_PREDICT,
      numCtx: this.config.OLLAMA_NUM_CTX,
    });
  }
}

module.exports = GuardrailAgent;
