"use strict";

/**
 * Shared mutable context object (blackboard pattern) that flows through
 * the agent pipeline. Each agent reads what it needs and writes its output.
 */
class AgentContext {
  /**
   * @param {object} request
   * @param {string}      request.userId
   * @param {string}      request.exerciseId
   * @param {string}      request.userMessage
   * @param {string|null} request.interaccionId
   */
  constructor(request) {
    // --- Input (immutable) ---
    this.userId = request.userId;
    this.exerciseId = request.exerciseId;
    this.userMessage = request.userMessage;
    this.interaccionId = request.interaccionId || null;

    // --- Populated by ContextAgent ---
    this.ejercicio = null;
    this.exerciseNum = null;
    this.correctAnswer = [];
    this.evaluableElements = [];
    /** @type {import('../../entities/Message')[]} */
    this.history = [];
    this.lang = "es";
    this.loopState = {
      prevCorrectTurns: 0,
      consecutiveWrongTurns: 0,
      totalAssistantTurns: 0,
      tutorRepeating: false,
      studentFrustrated: false,
    };

    // --- Populated by ClassifierAgent ---
    this.classification = null;

    // --- Populated by RetrievalAgent ---
    this.ragResult = {
      augmentation: "",
      decision: null,
      sources: [],
    };

    // --- Populated by TutorAgent ---
    this.llmResponse = null;

    // --- Populated by GuardrailAgent ---
    this.finalResponse = null;
    this.guardrailsTriggered = {
      solutionLeak: false,
      falseConfirmation: false,
      prematureConfirmation: false,
      stateReveal: false,
    };

    // --- Timing ---
    this.timing = {
      pipelineStartMs: Date.now(),
      pipelineMs: null,
      ollamaMs: null,
      totalMs: null,
    };

    // --- Flags ---
    this.deterministicFinish = false;
    this.fallthrough = false;
  }
}

module.exports = AgentContext;
