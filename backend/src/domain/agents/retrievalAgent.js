"use strict";

const AgentInterface = require("./base/AgentInterface");

/**
 * RetrievalAgent: Executes the RAG retrieval pipeline.
 * Wraps the existing runFullPipeline from ragPipeline.js.
 *
 * Routes to hybrid search (BM25 + semantic + RRF), knowledge graph,
 * and CRAG reformulation based on classification type.
 */
class RetrievalAgent extends AgentInterface {
  /**
   * @param {object} deps
   * @param {Function} deps.runFullPipeline - The runFullPipeline function from ragPipeline.js
   */
  constructor(deps) {
    super("retrievalAgent");
    this.runFullPipeline = deps.runFullPipeline;
  }

  canSkip(context) {
    return (
      context.classification?.type === "greeting" ||
      context.classification?.type === "off_topic"
    );
  }

  async execute(context) {
    if (this.canSkip(context)) {
      context.ragResult = {
        augmentation: "",
        decision: "no_rag",
        sources: [],
        classification: context.classification,
      };
      return;
    }

    const ragResult = await this.runFullPipeline(
      context.userMessage,
      context.exerciseNum,
      context.correctAnswer,
      context.userId,
      context.evaluableElements,
      context.lang
    );

    context.ragResult = {
      augmentation: ragResult.augmentation || "",
      decision: ragResult.decision || null,
      sources: ragResult.sources || [],
      classification: ragResult.classification || context.classification,
    };

    // Update classification if the pipeline refined it
    if (ragResult.classification) {
      context.classification = ragResult.classification;
    }
  }
}

module.exports = RetrievalAgent;
