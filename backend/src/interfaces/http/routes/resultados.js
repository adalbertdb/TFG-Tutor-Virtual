// backend/src/routes/resultados.js
const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");
const https = require("https");

const Resultado = require("../../../infrastructure/persistence/mongodb/models/resultado");
const Interaccion = require("../../../infrastructure/persistence/mongodb/models/interaccion");

// ✅ Concepciones alternativas (lista cerrada)
const acData = require("../../../alternative_conceptions.json");
const AC_MAP = acData?.alternative_conceptions || {};
const ALLOWED_AC_IDS = Object.keys(AC_MAP);
const ALLOWED_AC_IDS_TEXT = ALLOWED_AC_IDS.join(", ");

const router = express.Router();

/**
 * ✅ Base URL Ollama:
 * - prioriza tu .env actual: OLLAMA_API_URL_UPV
 * - fallback a OLLAMA_UPV_URL / OLLAMA_API_URL
 */
const OLLAMA_BASE_URL =
  process.env.OLLAMA_API_URL_UPV ||
  process.env.OLLAMA_UPV_URL ||
  process.env.OLLAMA_API_URL ||
  "https://ollama.gti-ia.upv.es:443";

/**
 * ✅ Timeout realista para clasificación (no stream)
 */
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_CLASSIFIER_TIMEOUT_MS || 240000);

/**
 * ✅ Insecure TLS: acepta 1/true/on
 */
const insecureTLS = ["1", "true", "on", "yes"].includes(
  String(process.env.OLLAMA_INSECURE_TLS || "").toLowerCase()
);

const httpsAgent = insecureTLS ? new https.Agent({ rejectUnauthorized: false }) : undefined;

const ollama = axios.create({
  baseURL: String(OLLAMA_BASE_URL).replace(/\/+$/, ""),
  timeout: OLLAMA_TIMEOUT_MS,
  httpsAgent,
});

/**
 * Extrae el primer bloque JSON { ... } si existe (tolerante a texto alrededor)
 */
function extractJsonObject(text) {
  if (typeof text !== "string") return null;
  const s = text.trim();
  if (!s) return null;

  // Quita fences si aparecen
  const cleaned = s.replace(/^```(json)?/i, "").replace(/```$/i, "").trim();

  if (cleaned.startsWith("{") && cleaned.endsWith("}")) {
    try {
      return JSON.parse(cleaned);
    } catch {
      // continue
    }
  }

  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function callClassifier({ model, prompt }) {
  const r = await ollama.post("/api/chat", {
    model,
    stream: false,
    format: "json",
    options: { temperature: 0 },
    messages: [{ role: "user", content: prompt }],
  });
  return r?.data?.message?.content;
}

// GET /api/resultados/completed — uses session userId (no longer from URL)
router.get("/completed", async (req, res) => {
  try {
    const userId = req.userId; // Set by globalAuth from session

    const resultados = await Resultado.find({ usuario_id: userId }).select("ejercicio_id").lean();

    const completedIds = [...new Set(resultados.map((r) => String(r.ejercicio_id)))];
    return res.status(200).json(completedIds);
  } catch (error) {
    console.error("Error obteniendo ejercicios completados:", error);
    return res.status(500).json({ message: "Error del servidor." });
  }
});

// LEGACY: Keep old URL pattern during frontend migration
router.get("/completed/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "ID de usuario inválido." });
    }

    // Ownership check: only own data unless profesor/admin
    const { canAccessUserData } = require("../middleware/authMiddleware");
    if (!canAccessUserData(userId, req)) {
      return res.status(403).json({ message: "No autorizado." });
    }

    const resultados = await Resultado.find({ usuario_id: userId }).select("ejercicio_id").lean();

    const completedIds = [...new Set(resultados.map((r) => String(r.ejercicio_id)))];
    return res.status(200).json(completedIds);
  } catch (error) {
    console.error("Error obteniendo ejercicios completados:", error);
    return res.status(500).json({ message: "Error del servidor." });
  }
});

// POST /api/resultados/finalizar — userId from session, NOT from body
router.post("/finalizar", async (req, res) => {
  try {
    const userId = req.userId; // From session via globalAuth
    const { exerciseId, interaccionId, resueltoALaPrimera = false } = req.body;

    if (!exerciseId || !interaccionId) {
      return res.status(400).json({ message: "Faltan datos para finalizar el resultado." });
    }

    if (
      !mongoose.Types.ObjectId.isValid(exerciseId) ||
      !mongoose.Types.ObjectId.isValid(interaccionId)
    ) {
      return res.status(400).json({ message: "Alguno de los IDs no es válido." });
    }

    const interaccion = await Interaccion.findById(interaccionId);
    if (!interaccion) {
      return res.status(404).json({ message: "Interacción no encontrada." });
    }

    const conversacion = Array.isArray(interaccion.conversacion) ? interaccion.conversacion : [];
    const numMensajes = conversacion.length;

    const conversacionTexto =
      conversacion.length > 0
        ? conversacion.map((m) => `${m.role}: ${m.content}`).join("\n")
        : "Conversación vacía.";

    const promptBase = `
Eres un asistente que clasifica concepciones alternativas (AC) en un diálogo de tutoría.

REGLAS ESTRICTAS (OBLIGATORIAS):
- Devuelve ÚNICAMENTE JSON válido.
- No escribas ningún texto fuera del JSON.
- No incluyas explicaciones, comentarios ni markdown.

Solo puedes devolver IDs de esta lista cerrada:
${ALLOWED_AC_IDS_TEXT}

Devuelve como máximo 3 IDs.
Si no detectas ninguna con claridad, devuelve [].

FORMATO EXACTO:
{
  "analisis": "1-2 frases muy cortas",
  "consejo": "1 frase muy corta",
  "acs": ["AC13", "AC14"]
}

CONVERSACIÓN:
---
${conversacionTexto}
---
`.trim();

    const promptRetry = `
DEVUELVE SOLO UN OBJETO JSON VÁLIDO. SIN TEXTO ADICIONAL. SIN MARKDOWN.
${promptBase}
`.trim();

    let analisisIA = null;
    let consejoIA = null;
    let errores = [];
    let classifierStatus = "skipped"; // ok | fail_timeout | fail_invalid_json | skipped

    const model = process.env.OLLAMA_CLASSIFIER_MODEL || process.env.OLLAMA_MODEL;

    try {
      const content1 = await callClassifier({ model, prompt: promptBase });
      let parsed = extractJsonObject(content1);

      if (!parsed) {
        const content2 = await callClassifier({ model, prompt: promptRetry });
        parsed = extractJsonObject(content2);
      }

      if (!parsed) {
        classifierStatus = "fail_invalid_json";
        throw new Error("Clasificador devolvió contenido no-JSON o JSON inválido.");
      }

      classifierStatus = "ok";

      if (typeof parsed.analisis === "string" && parsed.analisis.trim()) {
        analisisIA = parsed.analisis.trim();
      }
      if (typeof parsed.consejo === "string" && parsed.consejo.trim()) {
        consejoIA = parsed.consejo.trim();
      }

      const acs = Array.isArray(parsed.acs) ? parsed.acs : [];
      const acsFiltrados = acs
        .filter((id) => typeof id === "string")
        .map((id) => id.trim())
        .filter((id) => ALLOWED_AC_IDS.includes(id))
        .slice(0, 3);

      errores = acsFiltrados.map((id) => ({
        etiqueta: id,
        texto: AC_MAP[id]?.name || id,
      }));
    } catch (e) {
      const msg = String(e?.message || e);
      const isTimeout = msg.toLowerCase().includes("timeout") || e?.code === "ECONNABORTED";
      classifierStatus = isTimeout ? "fail_timeout" : classifierStatus;

      console.error("[RESULTADOS] Clasificador AC falló:", msg);

      if (numMensajes > 0) {
        errores = [
          {
            etiqueta: "AC_UNK",
            texto: isTimeout
              ? "No se pudo clasificar (timeout)"
              : "No se pudo clasificar (formato inválido)",
          },
        ];
      }
    }

    const nuevoResultado = new Resultado({
      usuario_id: userId,
      ejercicio_id: exerciseId,
      interaccion_id: interaccionId,
      resueltoALaPrimera,
      numMensajes,
      analisisIA,
      consejoIA,
      errores,
    });

    await nuevoResultado.save();

    return res.status(200).json({
      message: "Resultado guardado con éxito.",
      classifierStatus,
      saved: {
        numMensajes,
        analisisIA: Boolean(analisisIA),
        consejoIA: Boolean(consejoIA),
        errores: (errores || []).map((x) => x.etiqueta),
      },
    });
  } catch (error) {
    console.error("Error al finalizar resultado:", error);
    return res.status(500).json({ message: "Error del servidor al finalizar resultado." });
  }
});

module.exports = router;
