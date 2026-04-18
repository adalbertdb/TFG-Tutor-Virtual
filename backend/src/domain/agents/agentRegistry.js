"use strict";

const ContextAgent = require("./contextAgent");
const ClassifierAgent = require("./classifierAgent");
const RetrievalAgent = require("./retrievalAgent");
const TutorAgent = require("./tutorAgent");
const GuardrailAgent = require("./guardrailAgent");
const PersistenceAgent = require("./persistenceAgent");

/**
 * Creates and returns the default agent registry.
 * All agents receive their dependencies via constructor injection.
 *
 * To add a new agent:
 * 1. Create the agent class extending AgentInterface
 * 2. Add it here with its dependencies
 * 3. Add the corresponding stage call in orchestrator.js
 *
 * @param {object} deps - All injectable dependencies
 * @param {object} deps.ejercicioRepo
 * @param {object} deps.interaccionRepo
 * @param {object} deps.messageRepo
 * @param {object} deps.llmService
 * @param {Function} deps.classifyQuery
 * @param {Function} deps.runFullPipeline
 * @param {object} deps.guardrails
 * @param {Function} deps.buildSystemPrompt
 * @param {Function} [deps.logInteraction]
 * @param {Function} [deps.emitEvent]
 * @param {object} deps.config
 */
function createAgentRegistry(deps) {
  return {
    context: new ContextAgent({
      ejercicioRepo: deps.ejercicioRepo,
      interaccionRepo: deps.interaccionRepo,
      messageRepo: deps.messageRepo,
      config: deps.config,
    }),

    classifier: new ClassifierAgent({
      classifyQuery: deps.classifyQuery,
    }),

    retrieval: new RetrievalAgent({
      runFullPipeline: deps.runFullPipeline,
    }),

    tutor: new TutorAgent({
      llmService: deps.llmService,
      buildSystemPrompt: deps.buildSystemPrompt,
      config: deps.config,
    }),

    guardrail: new GuardrailAgent({
      llmService: deps.llmService,
      guardrails: deps.guardrails,
      buildSystemPrompt: deps.buildSystemPrompt,
      config: deps.config,
    }),

    persistence: new PersistenceAgent({
      messageRepo: deps.messageRepo,
      interaccionRepo: deps.interaccionRepo,
      logInteraction: deps.logInteraction,
      emitEvent: deps.emitEvent,
    }),
  };
}

module.exports = { createAgentRegistry };
