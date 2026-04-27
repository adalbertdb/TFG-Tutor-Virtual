"use strict";

// Thin HTTP adapter that dispatches POST /chat/stream through the orchestrator.
// Replaces ragMiddleware when USE_ORCHESTRATOR=1.
//
// Preserves the EXACT frontend SSE contract:
//   data: { interaccionId: "..." }        (sent once when a new interaccion is created)
//   data: { chunk: "tutor response..." }  (the full response as a single chunk)
//   data: [DONE]                          (terminator)
//
// Preserves MongoDB metadata: Interaccion.conversacion entries keep classification,
// guardrails.*, timing.*, sourcesCount, isCorrectAnswer, decision.

const express = require("express");
// ID validator accepting ObjectId (legacy) or UUID (new).
function _isValidId(v) {
  if (typeof v !== "string") return false;
  return /^[a-f0-9]{24}$/i.test(v) || /^[0-9a-f-]{36}$/i.test(v);
}
const container = require("../../../container");
const trace = require("../../../infrastructure/events/pipelineDebugLogger");

const router = express.Router();
const FIN_TOKEN = "<FIN_EJERCICIO>";

function sseSend(res, payload) {
  res.write("data: " + JSON.stringify(payload) + "\n\n");
  if (typeof res.flush === "function") res.flush();
}

function endSSE(res, hb) {
  if (hb) clearInterval(hb);
  res.write("data: [DONE]\n\n");
  if (typeof res.flush === "function") res.flush();
  res.end();
}

const ENABLED = process.env.USE_ORCHESTRATOR === "1";

router.post("/chat/stream", async function (req, res, next) {
  if (!ENABLED) return next();
  if (!container._initialized) {
    // Container not ready — fall through to legacy
    trace.traceRouteHandler && trace.traceRouteHandler("", "orchestrator_container_not_ready", {});
    return next();
  }

  const userId = req.userId;
  const { exerciseId, interaccionId, userMessage } = req.body || {};

  // Quick validation (matches ragMiddleware pre-checks)
  if (!userId || !_isValidId(userId)) return next();
  if (!exerciseId || !_isValidId(exerciseId)) return next();
  if (typeof userMessage !== "string" || userMessage.trim() === "") return next();
  if (interaccionId && !_isValidId(interaccionId)) return next();

  // Pre-check: for greetings and off_topic the orchestrator will set
  // fallthrough=true; defer to the legacy handler BEFORE opening SSE so we
  // can still call next(). classifyQuery is pure/sync and <1ms.
  try {
    const { classifyQuery } = require("../../../domain/services/rag/queryClassifier");
    const pre = classifyQuery(userMessage.trim(), [], []);
    if (pre && (pre.type === "greeting" || pre.type === "off_topic")) {
      trace.traceRouteHandler("", "orchestrator_pre_defer_to_fallback", { classification: pre.type });
      return next();
    }
  } catch (e) {
    // If the pre-check itself fails, keep going — the orchestrator still runs.
  }

  const reqId = trace.traceRequestStart("orchestrator", {
    userId: userId, exerciseId: exerciseId, interaccionId: interaccionId, userMessage: userMessage,
  });
  // Default 30s. Lower than the previous 45s so we fail fast when Ollama is
  // slow under load — better UX to show a fallback than to keep the user
  // staring at a spinner that ultimately times out at the SSE layer too.
  const budgetMs = Number(process.env.ORCHESTRATOR_BUDGET_MS || 30000);
  trace.traceBudgetSet(reqId, budgetMs);

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  res.write(": ok\n\n");

  const hb = setInterval(function () {
    res.write(": ping\n\n");
    if (typeof res.flush === "function") res.flush();
  }, 15000);

  try {
    // Pre-create Interaccion if needed so we can emit interaccionId early
    let iid = interaccionId || null;
    if (iid) {
      const exists = await container.interaccionRepo.existsForUser(iid, userId);
      if (!exists) iid = null;
    }
    if (!iid) {
      const created = await container.interaccionRepo.create({ usuarioId: userId, ejercicioId: exerciseId });
      iid = created.id;
      sseSend(res, { interaccionId: iid });
    }

    // Process through orchestrator
    const ctx = await container.orchestrator.process({
      userId: userId,
      exerciseId: exerciseId,
      userMessage: userMessage.trim(),
      interaccionId: iid,
      budgetMs: budgetMs,
      reqId: reqId,
    });

    // Attach the KG patterns and budget the orchestrator's agents need
    // (we do this INSIDE container initialization; here we're just reading results)

    // Handle fallthrough (greeting / off_topic / pipeline error without finalResponse)
    if (ctx.fallthrough && !ctx.finalResponse) {
      // Let the legacy handler take over
      trace.traceRagGate(reqId, "orchestrator_fallthrough", { reason: "fallthrough flag set" });
      clearInterval(hb);
      // NOTE: headers already sent, so we can't call next(). Send a minimal "try again" chunk.
      // In practice fallthrough should happen BEFORE SSE headers are sent.
      // For greetings we still want to stream — defer to ragMiddleware by ending here.
      sseSend(res, { error: "Orchestrator deferred to fallback. Please retry." });
      endSSE(res);
      return;
    }

    // Send response as a single chunk (same as ragMiddleware).
    // Belt-and-suspenders: orchestrator's catch already fills finalResponse on
    // error, but if anything still slips through with an empty payload, send a
    // localized fallback so the chat never goes silent on the user.
    let responseText = ctx.finalResponse || ctx.llmResponse || "";
    if (!responseText) {
      const lang = ctx.lang || "es";
      const fallbacks = {
        es: "Disculpa, el tutor está tardando demasiado en responder ahora mismo. ¿Puedes reformular tu mensaje o intentarlo de nuevo en un momento?",
        val: "Disculpa, el tutor està tardant massa a respondre ara mateix. Pots reformular el teu missatge o tornar-ho a provar d'ací a un moment?",
        en: "Sorry, the tutor is taking too long to respond right now. Could you rephrase your message or try again in a moment?",
      };
      responseText = fallbacks[lang] || fallbacks.es;
    }
    sseSend(res, { chunk: responseText });
    trace.traceResponse(reqId, {
      len: responseText.length,
      containsFIN: responseText.includes(FIN_TOKEN),
      response: responseText,
    });

    endSSE(res, hb);

    trace.traceRequestEnd(reqId, {
      outcome: "orchestrator_ok",
      totalMs: Date.now() - (ctx.timing.pipelineStartMs || Date.now()),
      responseLen: responseText.length,
      classification: ctx.classification && ctx.classification.type,
      decision: ctx.ragResult && ctx.ragResult.decision,
      guardrailTriggered: Object.values(ctx.guardrailsTriggered || {}).some(Boolean),
    });
  } catch (err) {
    clearInterval(hb);
    trace.traceError(reqId, "orchestrator", err);
    console.error("[Orchestrator HTTP] Error:", err && err.message);
    try {
      sseSend(res, { error: "Error en el sistema RAG." });
      endSSE(res);
    } catch (_) { /* headers may be in bad state */ }
  }
});

module.exports = router;
