"use strict";

/**
 * DualWriteRepository: Writes to both MongoDB and PostgreSQL simultaneously.
 * Reads come from the primary source (MongoDB during migration, PG after switchover).
 *
 * Usage:
 *   const dualRepo = new DualWriteRepository(mongoRepo, pgRepo, "mongodb");
 *   await dualRepo.appendMessage(id, msg); // writes to BOTH
 *   await dualRepo.getLastMessages(id, 6); // reads from primary only
 */
class DualWriteRepository {
  /**
   * @param {object} primary   - The primary repository (reads come from here)
   * @param {object} secondary - The secondary repository (writes are mirrored here)
   * @param {string} primaryLabel - Label for logging ("mongodb" or "postgresql")
   */
  constructor(primary, secondary, primaryLabel = "mongodb") {
    this.primary = primary;
    this.secondary = secondary;
    this.primaryLabel = primaryLabel;
  }

  /**
   * Wrap any write method: execute on primary, mirror to secondary.
   * Secondary failures are logged but don't fail the operation.
   */
  async _dualWrite(method, args) {
    const result = await this.primary[method](...args);
    try {
      await this.secondary[method](...args);
    } catch (e) {
      console.error(
        `[DUAL-WRITE] ${this.primaryLabel}→secondary ${method} failed:`,
        e.message
      );
    }
    return result;
  }

  /**
   * Wrap any read method: reads from primary only.
   */
  async _read(method, args) {
    return this.primary[method](...args);
  }
}

/**
 * Factory: creates a DualWrite wrapper for any repository interface.
 * Automatically wraps all methods — writes go to both, reads go to primary.
 *
 * @param {object} primary
 * @param {object} secondary
 * @param {string[]} writeMethods - Method names that should dual-write
 * @param {string} primaryLabel
 */
function createDualWriteProxy(primary, secondary, writeMethods, primaryLabel = "mongodb") {
  const dual = new DualWriteRepository(primary, secondary, primaryLabel);

  return new Proxy(primary, {
    get(target, prop) {
      if (typeof target[prop] !== "function") return target[prop];

      if (writeMethods.includes(prop)) {
        return (...args) => dual._dualWrite(prop, args);
      }
      return (...args) => dual._read(prop, args);
    },
  });
}

module.exports = { DualWriteRepository, createDualWriteProxy };
