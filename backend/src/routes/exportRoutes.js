// Export routes: JSON and CSV export of interaction and result data
// GET /api/export/interacciones?userId=...&exerciseId=...&format=csv|json
// GET /api/export/resultados?userId=...&exerciseId=...&format=csv|json

const express = require("express");
const mongoose = require("mongoose");
const Interaccion = require("../models/interaccion");
const Resultado = require("../models/resultado");
const Usuario = require("../models/usuario");
const Ejercicio = require("../models/ejercicio");

const router = express.Router();

// Build MongoDB filter from query params
function buildFilter(query) {
  var filter = {};
  if (query.userId && mongoose.Types.ObjectId.isValid(query.userId)) {
    filter.usuario_id = query.userId;
  }
  if (query.exerciseId && mongoose.Types.ObjectId.isValid(query.exerciseId)) {
    filter.ejercicio_id = query.exerciseId;
  }
  if (query.from || query.to) {
    filter.inicio = {};
    if (query.from) filter.inicio.$gte = new Date(query.from);
    if (query.to) filter.inicio.$lte = new Date(query.to);
  }
  return filter;
}

// Escape a value for CSV (handle commas, quotes, newlines)
function csvEscape(val) {
  if (val == null) return "";
  var s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Flatten an interaction into one row per message (for CSV)
function flattenInteraccion(inter, usuario, ejercicio) {
  var rows = [];
  var conv = inter.conversacion || [];
  for (var i = 0; i < conv.length; i++) {
    var msg = conv[i];
    var meta = msg.metadata || {};
    var timing = meta.timing || {};
    var guardrails = meta.guardrails || {};

    rows.push({
      interaccionId: inter._id,
      usuarioId: inter.usuario_id,
      upvLogin: usuario ? usuario.upvLogin : "",
      nombreCompleto: usuario ? ((usuario.nombre || "") + " " + (usuario.apellidos || "")).trim() : "",
      ejercicioId: inter.ejercicio_id,
      ejercicioTitulo: ejercicio ? ejercicio.titulo : "",
      sesionInicio: inter.inicio,
      sesionFin: inter.fin,
      mensajeIndex: i,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      classification: meta.classification || "",
      decision: meta.decision || "",
      isCorrectAnswer: meta.isCorrectAnswer != null ? meta.isCorrectAnswer : "",
      sourcesCount: meta.sourcesCount != null ? meta.sourcesCount : "",
      studentResponseMs: meta.studentResponseMs != null ? meta.studentResponseMs : "",
      pipelineMs: timing.pipelineMs != null ? timing.pipelineMs : "",
      ollamaMs: timing.ollamaMs != null ? timing.ollamaMs : "",
      totalMs: timing.totalMs != null ? timing.totalMs : "",
      guardrail_solutionLeak: guardrails.solutionLeak || false,
      guardrail_falseConfirmation: guardrails.falseConfirmation || false,
      guardrail_prematureConfirmation: guardrails.prematureConfirmation || false,
      guardrail_stateReveal: guardrails.stateReveal || false,
    });
  }
  return rows;
}

// Convert rows to CSV string
function rowsToCsv(rows) {
  if (rows.length === 0) return "";
  var headers = Object.keys(rows[0]);
  var lines = [headers.join(",")];
  for (var i = 0; i < rows.length; i++) {
    var vals = [];
    for (var j = 0; j < headers.length; j++) {
      vals.push(csvEscape(rows[i][headers[j]]));
    }
    lines.push(vals.join(","));
  }
  return lines.join("\n");
}

// GET /api/export/interacciones
router.get("/interacciones", async function (req, res) {
  try {
    var filter = buildFilter(req.query);
    var format = req.query.format || "json";

    var interacciones = await Interaccion.find(filter).sort({ inicio: -1 }).lean();

    // Load users and exercises for enrichment
    var userIds = [];
    var exerciseIds = [];
    for (var i = 0; i < interacciones.length; i++) {
      if (interacciones[i].usuario_id) userIds.push(interacciones[i].usuario_id);
      if (interacciones[i].ejercicio_id) exerciseIds.push(interacciones[i].ejercicio_id);
    }

    var usuarios = await Usuario.find({ _id: { $in: userIds } }).lean();
    var ejercicios = await Ejercicio.find({ _id: { $in: exerciseIds } }).lean();

    var userMap = {};
    for (var i = 0; i < usuarios.length; i++) {
      userMap[usuarios[i]._id.toString()] = usuarios[i];
    }
    var exMap = {};
    for (var i = 0; i < ejercicios.length; i++) {
      exMap[ejercicios[i]._id.toString()] = ejercicios[i];
    }

    if (format === "csv") {
      var allRows = [];
      for (var i = 0; i < interacciones.length; i++) {
        var inter = interacciones[i];
        var usuario = userMap[String(inter.usuario_id)] || null;
        var ejercicio = exMap[String(inter.ejercicio_id)] || null;
        var rows = flattenInteraccion(inter, usuario, ejercicio);
        for (var j = 0; j < rows.length; j++) {
          allRows.push(rows[j]);
        }
      }

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=interacciones.csv");
      return res.send(rowsToCsv(allRows));
    }

    // JSON: enrich with user and exercise info
    var result = [];
    for (var i = 0; i < interacciones.length; i++) {
      var inter = interacciones[i];
      var usuario = userMap[String(inter.usuario_id)] || null;
      var ejercicio = exMap[String(inter.ejercicio_id)] || null;
      result.push({
        interaccionId: inter._id,
        usuario: usuario ? { upvLogin: usuario.upvLogin, nombre: usuario.nombre, apellidos: usuario.apellidos } : null,
        ejercicio: ejercicio ? { titulo: ejercicio.titulo, concepto: ejercicio.concepto } : null,
        inicio: inter.inicio,
        fin: inter.fin,
        numMensajes: (inter.conversacion || []).length,
        conversacion: inter.conversacion,
      });
    }

    return res.json(result);
  } catch (err) {
    console.error("[EXPORT] Error:", err.message);
    return res.status(500).json({ error: "Error exporting interactions" });
  }
});

// GET /api/export/resultados
router.get("/resultados", async function (req, res) {
  try {
    var filter = buildFilter(req.query);
    // Resultado uses fecha instead of inicio
    if (filter.inicio) {
      filter.fecha = filter.inicio;
      delete filter.inicio;
    }
    var format = req.query.format || "json";

    var resultados = await Resultado.find(filter).sort({ fecha: -1 }).lean();

    var userIds = [];
    var exerciseIds = [];
    for (var i = 0; i < resultados.length; i++) {
      if (resultados[i].usuario_id) userIds.push(resultados[i].usuario_id);
      if (resultados[i].ejercicio_id) exerciseIds.push(resultados[i].ejercicio_id);
    }

    var usuarios = await Usuario.find({ _id: { $in: userIds } }).lean();
    var ejercicios = await Ejercicio.find({ _id: { $in: exerciseIds } }).lean();

    var userMap = {};
    for (var i = 0; i < usuarios.length; i++) {
      userMap[usuarios[i]._id.toString()] = usuarios[i];
    }
    var exMap = {};
    for (var i = 0; i < ejercicios.length; i++) {
      exMap[ejercicios[i]._id.toString()] = ejercicios[i];
    }

    if (format === "csv") {
      var rows = [];
      for (var i = 0; i < resultados.length; i++) {
        var r = resultados[i];
        var usuario = userMap[String(r.usuario_id)] || null;
        var ejercicio = exMap[String(r.ejercicio_id)] || null;
        var errTags = (r.errores || []).map(function (e) { return e.etiqueta; }).join("; ");

        rows.push({
          resultadoId: r._id,
          usuarioId: r.usuario_id,
          upvLogin: usuario ? usuario.upvLogin : "",
          nombreCompleto: usuario ? ((usuario.nombre || "") + " " + (usuario.apellidos || "")).trim() : "",
          ejercicioId: r.ejercicio_id,
          ejercicioTitulo: ejercicio ? ejercicio.titulo : "",
          interaccionId: r.interaccion_id || "",
          fecha: r.fecha,
          numMensajes: r.numMensajes,
          resueltoALaPrimera: r.resueltoALaPrimera,
          errores: errTags,
          analisisIA: r.analisisIA || "",
          consejoIA: r.consejoIA || "",
        });
      }

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=resultados.csv");
      return res.send(rowsToCsv(rows));
    }

    // JSON
    var result = [];
    for (var i = 0; i < resultados.length; i++) {
      var r = resultados[i];
      var usuario = userMap[String(r.usuario_id)] || null;
      var ejercicio = exMap[String(r.ejercicio_id)] || null;
      result.push({
        resultadoId: r._id,
        usuario: usuario ? { upvLogin: usuario.upvLogin, nombre: usuario.nombre, apellidos: usuario.apellidos } : null,
        ejercicio: ejercicio ? { titulo: ejercicio.titulo } : null,
        interaccionId: r.interaccion_id,
        fecha: r.fecha,
        numMensajes: r.numMensajes,
        resueltoALaPrimera: r.resueltoALaPrimera,
        errores: r.errores,
        analisisIA: r.analisisIA,
        consejoIA: r.consejoIA,
      });
    }

    return res.json(result);
  } catch (err) {
    console.error("[EXPORT] Error:", err.message);
    return res.status(500).json({ error: "Error exporting results" });
  }
});

module.exports = router;
