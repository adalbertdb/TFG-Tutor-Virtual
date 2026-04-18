"use strict";

/**
 * Port interface for Message persistence.
 * This is the KEY abstraction that decouples business logic from MongoDB's
 * embedded conversacion[] array pattern.
 *
 * MongoDB adapter: wraps $push/$slice on Interaccion.conversacion[]
 * PostgreSQL adapter: operates on the normalized messages table
 */
class IMessageRepository {
  /**
   * Append a message to a conversation.
   * MongoDB: $push to conversacion[] + $set fin
   * PostgreSQL: INSERT into messages with next sequence_num
   * @param {string} interaccionId
   * @param {import('../../entities/Message')} message
   * @returns {Promise<void>}
   */
  async appendMessage(interaccionId, message) {
    throw new Error("Not implemented");
  }

  /**
   * Load the last N messages for an interaccion.
   * MongoDB: .slice("conversacion", -N).lean()
   * PostgreSQL: SELECT ... ORDER BY sequence_num DESC LIMIT N, then reverse
   * @param {string} interaccionId
   * @param {number} count
   * @returns {Promise<import('../../entities/Message')[]>}
   */
  async getLastMessages(interaccionId, count) {
    throw new Error("Not implemented");
  }

  /**
   * Get all messages for an interaccion (for export, finalize).
   * @param {string} interaccionId
   * @returns {Promise<import('../../entities/Message')[]>}
   */
  async getAllMessages(interaccionId) {
    throw new Error("Not implemented");
  }

  /**
   * Count consecutive messages from the end with given classification types.
   * Used for wrong streak detection (loop breaking).
   * @param {string} interaccionId
   * @param {string[]} classificationTypes
   * @returns {Promise<number>}
   */
  async countConsecutiveFromEnd(interaccionId, classificationTypes) {
    throw new Error("Not implemented");
  }

  /**
   * Count total assistant messages.
   * @param {string} interaccionId
   * @returns {Promise<number>}
   */
  async countAssistantMessages(interaccionId) {
    throw new Error("Not implemented");
  }

  /**
   * Get last N assistant messages (for tutor repetition detection).
   * @param {string} interaccionId
   * @param {number} count
   * @returns {Promise<import('../../entities/Message')[]>}
   */
  async getLastAssistantMessages(interaccionId, count) {
    throw new Error("Not implemented");
  }

  /**
   * Get the last message of any role (for student response time calculation).
   * @param {string} interaccionId
   * @returns {Promise<import('../../entities/Message')|null>}
   */
  async getLastMessage(interaccionId) {
    throw new Error("Not implemented");
  }
}

module.exports = IMessageRepository;
