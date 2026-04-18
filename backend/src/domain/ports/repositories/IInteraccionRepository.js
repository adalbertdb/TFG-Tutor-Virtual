"use strict";

/**
 * Port interface for Interaccion persistence.
 * Note: Messages are handled by IMessageRepository, not here.
 * Implementations: MongoInteraccionRepository, PgInteraccionRepository
 */
class IInteraccionRepository {
  /** @returns {Promise<import('../../entities/Interaccion')>} */
  async findById(id) {
    throw new Error("Not implemented");
  }

  /**
   * @param {object} data - { usuarioId, ejercicioId }
   * @returns {Promise<import('../../entities/Interaccion')>}
   */
  async create(data) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<void>} */
  async deleteById(id) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<boolean>} */
  async exists(id) {
    throw new Error("Not implemented");
  }

  /**
   * Check if an interaccion exists AND belongs to the given user.
   * @returns {Promise<boolean>}
   */
  async existsForUser(id, userId) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<void>} */
  async updateFin(id, fin) {
    throw new Error("Not implemented");
  }

  /**
   * Find all interactions for a user, sorted by fin DESC.
   * @returns {Promise<import('../../entities/Interaccion')[]>}
   */
  async findByUserId(userId) {
    throw new Error("Not implemented");
  }

  /**
   * Find the latest interaction for a user + exercise pair.
   * @returns {Promise<import('../../entities/Interaccion')|null>}
   */
  async findLatestByExerciseAndUser(ejercicioId, userId) {
    throw new Error("Not implemented");
  }

  /**
   * Find recent interactions (admin/test endpoint).
   * @returns {Promise<import('../../entities/Interaccion')[]>}
   */
  async findRecent(limit) {
    throw new Error("Not implemented");
  }

  /**
   * Find by filter (for export).
   * @returns {Promise<import('../../entities/Interaccion')[]>}
   */
  async findByFilter(filter) {
    throw new Error("Not implemented");
  }
}

module.exports = IInteraccionRepository;
