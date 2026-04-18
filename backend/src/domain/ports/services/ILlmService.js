"use strict";

/**
 * Port interface for LLM (Large Language Model) interactions.
 * Implementations: OllamaLlmService (current), OpenAILlmService (future)
 */
class ILlmService {
  /**
   * Non-streaming chat completion.
   * @param {Array<{role: string, content: string}>} messages
   * @param {object} [options]
   * @param {number} [options.temperature]
   * @param {number} [options.numPredict]
   * @param {number} [options.numCtx]
   * @returns {Promise<string>} The assistant response content
   */
  async chatCompletion(messages, options) {
    throw new Error("Not implemented");
  }

  /**
   * Streaming chat completion. Returns a readable stream of NDJSON chunks.
   * @param {Array<{role: string, content: string}>} messages
   * @param {object} [options]
   * @param {AbortSignal} [signal]
   * @returns {Promise<ReadableStream>}
   */
  async chatCompletionStream(messages, options, signal) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<boolean>} */
  async isHealthy() {
    throw new Error("Not implemented");
  }
}

module.exports = ILlmService;
