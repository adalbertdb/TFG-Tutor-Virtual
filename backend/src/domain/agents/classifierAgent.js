"use strict";

const AgentInterface = require("./base/AgentInterface");

/**
 * ClassifierAgent: Classifies the student's message to determine response strategy.
 * Thin wrapper around the existing rule-based queryClassifier.
 *
 * Extracted from ragPipeline.js classification step.
 */
class ClassifierAgent extends AgentInterface {
  /**
   * @param {object} deps
   * @param {Function} deps.classifyQuery - The classifyQuery function from queryClassifier.js
   */
  constructor(deps) {
    super("classifierAgent");
    this.classifyQuery = deps.classifyQuery;
  }

  async execute(context) {
    context.classification = this.classifyQuery(
      context.userMessage,
      context.correctAnswer,
      context.evaluableElements
    );
  }

  canSkip() {
    return false; // Classification always runs
  }
}

module.exports = ClassifierAgent;
