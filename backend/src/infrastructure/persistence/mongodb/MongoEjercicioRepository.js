"use strict";

const IEjercicioRepository = require("../../../domain/ports/repositories/IEjercicioRepository");
const Ejercicio = require("../../../domain/entities/Ejercicio");
const EjercicioModel = require("./models/ejercicio");

function toDomain(doc) {
  if (!doc) return null;
  const obj = doc.toObject ? doc.toObject() : doc;
  return new Ejercicio({
    id: String(obj._id),
    titulo: obj.titulo,
    enunciado: obj.enunciado,
    imagen: obj.imagen || "",
    asignatura: obj.asignatura,
    concepto: obj.concepto,
    nivel: obj.nivel,
    ca: obj.CA || "",
    tutorContext: obj.tutorContext || null,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  });
}

class MongoEjercicioRepository extends IEjercicioRepository {
  async findById(id) {
    const doc = await EjercicioModel.findById(id).lean();
    return toDomain(doc);
  }

  async findAll() {
    const docs = await EjercicioModel.find().sort({ _id: 1 }).lean();
    return docs.map(toDomain);
  }

  async create(data) {
    const doc = await EjercicioModel.create(data);
    return toDomain(doc);
  }

  async updateById(id, fields) {
    await EjercicioModel.updateOne({ _id: id }, { $set: fields });
    return this.findById(id);
  }

  async deleteById(id) {
    await EjercicioModel.deleteOne({ _id: id });
  }

  async findOneByConcepto(concepto) {
    const doc = await EjercicioModel.findOne({ concepto }).lean();
    return toDomain(doc);
  }

  async findByIds(ids) {
    const docs = await EjercicioModel.find({ _id: { $in: ids } }).lean();
    return docs.map(toDomain);
  }
}

module.exports = MongoEjercicioRepository;
