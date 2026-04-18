"use strict";

const IUsuarioRepository = require("../../../domain/ports/repositories/IUsuarioRepository");
const Usuario = require("../../../domain/entities/Usuario");
const UsuarioModel = require("./models/usuario");

function toDomain(doc) {
  if (!doc) return null;
  const obj = doc.toObject ? doc.toObject() : doc;
  return new Usuario({
    id: String(obj._id),
    upvLogin: obj.upvLogin,
    email: obj.email || "",
    nombre: obj.nombre || "",
    apellidos: obj.apellidos || "",
    dni: obj.dni || "",
    grupos: obj.grupos || [],
    rol: obj.rol || "alumno",
    lastLoginAt: obj.lastLoginAt || null,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  });
}

class MongoUsuarioRepository extends IUsuarioRepository {
  async findById(id) {
    const doc = await UsuarioModel.findById(id).lean();
    return toDomain(doc);
  }

  async findByUpvLogin(upvLogin) {
    const doc = await UsuarioModel.findOne({ upvLogin }).lean();
    return toDomain(doc);
  }

  async upsertByUpvLogin(upvLogin, updateFields, insertFields) {
    const doc = await UsuarioModel.findOneAndUpdate(
      { upvLogin },
      {
        $set: updateFields,
        $setOnInsert: insertFields || {},
      },
      { new: true, upsert: true }
    );
    return toDomain(doc);
  }

  async create(userData) {
    const doc = await UsuarioModel.create({
      upvLogin: userData.upvLogin,
      email: userData.email,
      nombre: userData.nombre,
      apellidos: userData.apellidos,
      dni: userData.dni,
      grupos: userData.grupos,
      rol: userData.rol || "alumno",
    });
    return toDomain(doc);
  }

  async updateById(id, fields) {
    const doc = await UsuarioModel.findByIdAndUpdate(
      id,
      { $set: fields },
      { new: true }
    );
    return toDomain(doc);
  }

  async findAll() {
    const docs = await UsuarioModel.find().lean();
    return docs.map(toDomain);
  }

  async findByIds(ids) {
    const docs = await UsuarioModel.find({ _id: { $in: ids } }).lean();
    return docs.map(toDomain);
  }
}

module.exports = MongoUsuarioRepository;
