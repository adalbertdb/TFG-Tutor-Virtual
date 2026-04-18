// progresoRoutes.js
const express = require("express");
const mongoose = require("mongoose");
const Resultado = require("../../../infrastructure/persistence/mongodb/models/resultado");
const Ejercicio = require("../../../infrastructure/persistence/mongodb/models/ejercicio");

const router = express.Router();

/**
 * ✅ Key de día en zona Europe/Madrid (evita problemas UTC -> racha incorrecta)
 * Devuelve "YYYY-MM-DD"
 */
function dayKeyMadrid(date) {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const da = parts.find((p) => p.type === "day")?.value;
  return y && m && da ? `${y}-${m}-${da}` : null;
}

/**
 * ✅ Racha: cuenta días consecutivos hacia atrás desde el último día con actividad.
 * dates: array de Date/string (fecha del resultado)
 */
function computeStreak(dates) {
  const set = new Set();
  for (const dt of dates) {
    const k = dayKeyMadrid(dt);
    if (k) set.add(k);
  }
  if (set.size === 0) return 0;

  const days = Array.from(set).sort(); // YYYY-MM-DD ordena cronológicamente
  let streak = 1;

  for (let i = days.length - 1; i > 0; i--) {
    const a = new Date(days[i] + "T00:00:00");
    const b = new Date(days[i - 1] + "T00:00:00");
    const diff = (a - b) / (1000 * 60 * 60 * 24);

    if (diff === 1) streak += 1;
    else break;
  }

  return streak;
}

// Shared handler: loads results and returns progress JSON
async function loadAndReturnProgreso(userId, res) {
  const todosResultados = await Resultado.find({ usuario_id: userId })
      .sort({ fecha: -1 })
      .populate({ path: "ejercicio_id", select: "titulo concepto nivel" });

    if (todosResultados.length === 0) {
      return res.json({
        interaccionesMedias: 0,
        eficienciaPorConcepto: [],
        resumenSemanal: { ejerciciosCompletados: 0, conceptosDistintos: 0, rachaDias: 0 },
        ultimaSesion: {
          tituloEjercicio: "¡Bienvenido!",
          analisis: "Aún no has completado ningún ejercicio.",
          consejo: "Empieza con uno para ver aquí tu progreso.",
        },
        erroresFrecuentes: [],
        recomendacion: {
          titulo: "",
          motivo: "Haz un ejercicio para que el tutor pueda recomendarte una práctica personalizada.",
          ejercicioId: null,
          concepto: "",
        },
      });
    }

    // A) Interacciones medias (con numMensajes)
    const totalInteracciones = todosResultados.reduce((sum, r) => sum + (r.numMensajes || 0), 0);
    const interaccionesMedias = totalInteracciones / todosResultados.length;

    // B) Dificultad por concepto (media numMensajes)
    const eficiencia = {};
    for (const r of todosResultados) {
      const concepto = r.ejercicio_id?.concepto;
      if (!concepto) continue;

      if (!eficiencia[concepto]) eficiencia[concepto] = { total: 0, count: 0 };
      eficiencia[concepto].total += r.numMensajes || 0;
      eficiencia[concepto].count += 1;
    }

    const eficienciaPorConcepto = Object.keys(eficiencia).map((c) => ({
      concepto: c,
      interacciones: eficiencia[c].total / eficiencia[c].count,
    }));

    // C) Resumen semanal (✅ ejercicios únicos, no intentos)
    const hoy = new Date();
    const haceUnaSemana = new Date();
    haceUnaSemana.setDate(hoy.getDate() - 7);

    const resultadosSemana = todosResultados.filter((r) => r.fecha && new Date(r.fecha) >= haceUnaSemana);

    const conceptosSemana = new Set(resultadosSemana.map((r) => r.ejercicio_id?.concepto).filter(Boolean));

    const ejerciciosUnicosSemana = new Set(
      resultadosSemana
        .map((r) => {
          const idPop = r.ejercicio_id?._id?.toString?.();
          if (idPop) return idPop;
          const idDirecto = r.ejercicio_id?.toString?.();
          return idDirecto || null;
        })
        .filter(Boolean)
    );

    // ✅ Racha real (por días con actividad, zona Madrid)
    const rachaDias = computeStreak(todosResultados.map((r) => r.fecha || r.createdAt || r.updatedAt));

    const resumenSemanal = {
      ejerciciosCompletados: ejerciciosUnicosSemana.size,
      conceptosDistintos: conceptosSemana.size,
      rachaDias,
    };

    // D) Última sesión (insights IA opcionales)
    const ultimoResultado = todosResultados[0];
    const ultimaSesion = {
      tituloEjercicio: ultimoResultado.ejercicio_id?.titulo || "Ejercicio Reciente",
      analisis: ultimoResultado.analisisIA || "Análisis no disponible.",
      consejo: ultimoResultado.consejoIA || "Sigue practicando.",
    };

    // E) Errores frecuentes
    const mapaErrores = {};
    for (const r of todosResultados) {
      for (const e of r.errores || []) {
        if (!e?.etiqueta) continue;
        if (!mapaErrores[e.etiqueta]) {
          mapaErrores[e.etiqueta] = {
            etiqueta: e.etiqueta,
            texto: e.texto || e.etiqueta,
            veces: 0,
          };
        }
        mapaErrores[e.etiqueta].veces += 1;
      }
    }

    const erroresFrecuentes = Object.values(mapaErrores).sort((a, b) => b.veces - a.veces).slice(0, 3);

    // F) Recomendación:
    // - si hay errores reales (≠ AC_UNK), recomendación “basada en tus errores”
    // - si no, por “peor concepto” (más mensajes)
    let recomendacion = {
      titulo: "",
      motivo: "Haz un ejercicio para que el tutor pueda recomendarte una práctica personalizada.",
      ejercicioId: null,
      concepto: "",
    };

    const hasRealErrors = erroresFrecuentes.some((e) => e.etiqueta && e.etiqueta !== "AC_UNK");

    if (hasRealErrors) {
      const conceptoObjetivo = ultimoResultado.ejercicio_id?.concepto || "";
      if (conceptoObjetivo) {
        const ej = await Ejercicio.findOne({ concepto: conceptoObjetivo }).select("_id titulo concepto");
        if (ej) {
          recomendacion = {
            titulo: ej.titulo || "Ejercicio recomendado",
            motivo: "Recomendación basada en tus errores recientes.",
            ejercicioId: ej._id.toString(),
            concepto: ej.concepto || conceptoObjetivo,
          };
        } else {
          recomendacion = {
            titulo: "Recomendación",
            motivo: "Revisa el concepto de tu última sesión y prueba un ejercicio similar.",
            ejercicioId: null,
            concepto: conceptoObjetivo,
          };
        }
      }
    } else if (eficienciaPorConcepto.length > 0) {
      const peor = [...eficienciaPorConcepto].sort((a, b) => b.interacciones - a.interacciones)[0];
      const conceptoObjetivo = peor.concepto;

      const ej = await Ejercicio.findOne({ concepto: conceptoObjetivo }).select("_id titulo concepto");
      if (ej) {
        recomendacion = {
          titulo: ej.titulo || "Ejercicio recomendado",
          motivo: "Te recomiendo reforzar este concepto según tu actividad reciente.",
          ejercicioId: ej._id.toString(),
          concepto: ej.concepto || conceptoObjetivo,
        };
      } else {
        recomendacion = {
          titulo: "Recomendación",
          motivo: `Refuerza el concepto: ${conceptoObjetivo}.`,
          ejercicioId: null,
          concepto: conceptoObjetivo,
        };
      }
    }

    return res.status(200).json({
      interaccionesMedias,
      eficienciaPorConcepto,
      resumenSemanal,
      ultimaSesion,
      erroresFrecuentes,
      recomendacion,
    });
}

// GET /api/progreso — uses session userId
router.get("/", async (req, res) => {
  try {
    return await loadAndReturnProgreso(req.userId, res);
  } catch (error) {
    console.error("[PROGRESO] Error:", error?.message || error);
    return res.status(500).json({ message: "Error del servidor." });
  }
});

// LEGACY: Keep old URL pattern during frontend migration (with ownership check)
router.get("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "ID de usuario inválido." });
    }

    // Ownership check
    const { canAccessUserData } = require("../middleware/authMiddleware");
    if (!canAccessUserData(userId, req)) {
      return res.status(403).json({ message: "No autorizado." });
    }

    return await loadAndReturnProgreso(userId, res);
  } catch (error) {
    console.error("Error al generar progreso:", error);
    return res.status(500).json({ message: "Error en el servidor." });
  }
});

module.exports = router;
