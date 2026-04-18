"use strict";

const IMessageRepository = require("../../../domain/ports/repositories/IMessageRepository");
const Message = require("../../../domain/entities/Message");
const InteraccionModel = require("./models/interaccion");

/**
 * MongoDB adapter for IMessageRepository.
 * Wraps operations on the embedded conversacion[] array in Interaccion documents.
 * This is the KEY abstraction that decouples business logic from MongoDB's $push/$slice pattern.
 */

function mongoMsgToDomain(msg, interaccionId, index) {
  return new Message({
    id: msg._id ? String(msg._id) : null,
    interaccionId: String(interaccionId),
    sequenceNum: index,
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp,
    metadata: msg.metadata || null,
  });
}

class MongoMessageRepository extends IMessageRepository {
  /**
   * Append a message to the embedded conversacion[] array.
   * Wraps: $push + $set fin
   */
  async appendMessage(interaccionId, message) {
    const mongoMsg = {
      role: message.role,
      content: message.content,
      timestamp: message.timestamp || new Date(),
    };
    if (message.metadata) {
      mongoMsg.metadata = {
        classification: message.metadata.classification,
        decision: message.metadata.decision,
        isCorrectAnswer: message.metadata.isCorrectAnswer,
        sourcesCount: message.metadata.sourcesCount,
        studentResponseMs: message.metadata.studentResponseMs,
        guardrails: message.metadata.guardrails,
        timing: message.metadata.timing,
      };
    }
    await InteraccionModel.updateOne(
      { _id: interaccionId },
      {
        $push: { conversacion: mongoMsg },
        $set: { fin: new Date() },
      }
    );
  }

  /**
   * Load the last N messages.
   * Wraps: .slice("conversacion", -N).lean()
   */
  async getLastMessages(interaccionId, count) {
    const doc = await InteraccionModel.findById(interaccionId)
      .select({ conversacion: 1 })
      .slice("conversacion", -count)
      .lean();
    if (!doc || !doc.conversacion) return [];
    return doc.conversacion.map((msg, i) =>
      mongoMsgToDomain(msg, interaccionId, i)
    );
  }

  /**
   * Get all messages for an interaccion.
   */
  async getAllMessages(interaccionId) {
    const doc = await InteraccionModel.findById(interaccionId)
      .select({ conversacion: 1 })
      .lean();
    if (!doc || !doc.conversacion) return [];
    return doc.conversacion.map((msg, i) =>
      mongoMsgToDomain(msg, interaccionId, i)
    );
  }

  /**
   * Count consecutive assistant messages from the end with given classification types.
   * Used for wrong streak detection.
   */
  async countConsecutiveFromEnd(interaccionId, classificationTypes) {
    const doc = await InteraccionModel.findById(interaccionId)
      .select({ conversacion: 1 })
      .lean();
    if (!doc || !doc.conversacion) return 0;

    let count = 0;
    const msgs = doc.conversacion;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (msg.role !== "assistant") continue;
      if (
        msg.metadata?.classification &&
        classificationTypes.includes(msg.metadata.classification)
      ) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  /**
   * Count total assistant messages.
   */
  async countAssistantMessages(interaccionId) {
    const doc = await InteraccionModel.findById(interaccionId)
      .select({ conversacion: 1 })
      .lean();
    if (!doc || !doc.conversacion) return 0;
    return doc.conversacion.filter((m) => m.role === "assistant").length;
  }

  /**
   * Get last N assistant messages.
   */
  async getLastAssistantMessages(interaccionId, count) {
    const doc = await InteraccionModel.findById(interaccionId)
      .select({ conversacion: 1 })
      .lean();
    if (!doc || !doc.conversacion) return [];

    const assistantMsgs = doc.conversacion
      .map((msg, i) => ({ msg, i }))
      .filter(({ msg }) => msg.role === "assistant")
      .slice(-count);

    return assistantMsgs.map(({ msg, i }) =>
      mongoMsgToDomain(msg, interaccionId, i)
    );
  }

  /**
   * Get the last message (any role).
   */
  async getLastMessage(interaccionId) {
    const doc = await InteraccionModel.findById(interaccionId)
      .select({ conversacion: { $slice: -1 } })
      .lean();
    if (!doc || !doc.conversacion || doc.conversacion.length === 0) return null;
    const msg = doc.conversacion[0];
    return mongoMsgToDomain(msg, interaccionId, 0);
  }
}

module.exports = MongoMessageRepository;
