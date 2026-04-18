"use strict";

const IResultadoRepository = require("../../../domain/ports/repositories/IResultadoRepository");
const Resultado = require("../../../domain/entities/Resultado");
const Ejercicio = require("../../../domain/entities/Ejercicio");
const ResultadoModel = require("./models/resultado");

function toDomain(doc) {
  if (!doc) return null;
  const obj = doc.toObject ? doc.toObject() : doc;
  return new Resultado({
    id: String(obj._id),
    usuarioId: String(obj.usuario_id),
    ejercicioId: String(obj.ejercicio_id),
    interaccionId: String(obj.interaccion_id),
    numMensajes: obj.numMensajes || 0,
    resueltoALaPrimera: obj.resueltoALaPrimera || false,
    analisisIA: obj.analisisIA || null,
    consejoIA: obj.consejoIA || null,
    fecha: obj.fecha,
    errores: (obj.errores || []).map((e) => ({
      etiqueta: e.etiqueta,
      texto: e.texto,
    })),
  });
}

function ejercicioToDomain(doc) {
  if (!doc) return null;
  return new Ejercicio({
    id: String(doc._id),
    titulo: doc.titulo,
    enunciado: doc.enunciado || "",
    imagen: doc.imagen || "",
    asignatura: doc.asignatura || "",
    concepto: doc.concepto || "",
    nivel: doc.nivel || 0,
    ca: doc.CA || "",
    tutorContext: doc.tutorContext || null,
  });
}

class MongoResultadoRepository extends IResultadoRepository {
  async create(data) {
    const doc = await new ResultadoModel({
      usuario_id: data.usuarioId,
      ejercicio_id: data.ejercicioId,
      interaccion_id: data.interaccionId,
      numMensajes: data.numMensajes,
      resueltoALaPrimera: data.resueltoALaPrimera,
      analisisIA: data.analisisIA,
      consejoIA: data.consejoIA,
      errores: data.errores || [],
    }).save();
    return toDomain(doc);
  }

  async findByUserId(userId) {
    const docs = await ResultadoModel.find({ usuario_id: userId })
      .sort({ fecha: -1 })
      .lean();
    return docs.map(toDomain);
  }

  async findByUserIdWithExercise(userId) {
    const docs = await ResultadoModel.find({ usuario_id: userId })
      .sort({ fecha: -1 })
      .populate({
        path: "ejercicio_id",
        select: "titulo concepto nivel asignatura",
      })
      .lean();
    return docs.map((doc) => ({
      resultado: toDomain(doc),
      ejercicio: ejercicioToDomain(doc.ejercicio_id),
    }));
  }

  async findCompletedExerciseIds(userId) {
    const docs = await ResultadoModel.find({ usuario_id: userId })
      .select("ejercicio_id")
      .lean();
    return docs.map((d) => String(d.ejercicio_id));
  }

  async findByFilter(filter) {
    const mongoFilter = {};
    if (filter.userId) mongoFilter.usuario_id = filter.userId;
    if (filter.ejercicioId) mongoFilter.ejercicio_id = filter.ejercicioId;

    const docs = await ResultadoModel.find(mongoFilter)
      .sort({ fecha: -1 })
      .lean();
    return docs.map(toDomain);
  }

  async getErrorTagsByUserId(userId) {
    const docs = await ResultadoModel.find({ usuario_id: userId })
      .select("errores")
      .lean();
    const tags = new Set();
    for (const doc of docs) {
      for (const err of doc.errores || []) {
        if (err.etiqueta) tags.add(err.etiqueta);
      }
    }
    return Array.from(tags);
  }
}

module.exports = MongoResultadoRepository;
