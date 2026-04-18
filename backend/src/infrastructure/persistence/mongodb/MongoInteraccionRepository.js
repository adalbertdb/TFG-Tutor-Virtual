"use strict";

const IInteraccionRepository = require("../../../domain/ports/repositories/IInteraccionRepository");
const Interaccion = require("../../../domain/entities/Interaccion");
const InteraccionModel = require("./models/interaccion");

function toDomain(doc) {
  if (!doc) return null;
  const obj = doc.toObject ? doc.toObject() : doc;
  return new Interaccion({
    id: String(obj._id),
    usuarioId: String(obj.usuario_id),
    ejercicioId: String(obj.ejercicio_id),
    inicio: obj.inicio,
    fin: obj.fin,
    createdAt: obj.createdAt || obj.inicio,
  });
}

class MongoInteraccionRepository extends IInteraccionRepository {
  async findById(id) {
    const doc = await InteraccionModel.findById(id).lean();
    return toDomain(doc);
  }

  async create(data) {
    const doc = await InteraccionModel.create({
      usuario_id: data.usuarioId,
      ejercicio_id: data.ejercicioId,
      inicio: new Date(),
      fin: new Date(),
      conversacion: [],
    });
    return toDomain(doc);
  }

  async deleteById(id) {
    await InteraccionModel.findByIdAndDelete(id);
  }

  async exists(id) {
    const result = await InteraccionModel.exists({ _id: id });
    return !!result;
  }

  async existsForUser(id, userId) {
    const result = await InteraccionModel.exists({
      _id: id,
      usuario_id: userId,
    });
    return !!result;
  }

  async updateFin(id, fin) {
    await InteraccionModel.updateOne({ _id: id }, { $set: { fin } });
  }

  async findByUserId(userId) {
    const docs = await InteraccionModel.find({ usuario_id: userId })
      .sort({ fin: -1 })
      .lean();
    return docs.map(toDomain);
  }

  async findLatestByExerciseAndUser(ejercicioId, userId) {
    const doc = await InteraccionModel.findOne({
      ejercicio_id: ejercicioId,
      usuario_id: userId,
    })
      .sort({ fin: -1 })
      .lean();
    return toDomain(doc);
  }

  async findRecent(limit = 50) {
    const docs = await InteraccionModel.find()
      .sort({ fin: -1 })
      .limit(limit)
      .lean();
    return docs.map(toDomain);
  }

  async findByFilter(filter) {
    const mongoFilter = {};
    if (filter.userId) mongoFilter.usuario_id = filter.userId;
    if (filter.ejercicioId) mongoFilter.ejercicio_id = filter.ejercicioId;

    const docs = await InteraccionModel.find(mongoFilter)
      .sort({ inicio: -1 })
      .lean();
    return docs.map(toDomain);
  }
}

module.exports = MongoInteraccionRepository;
