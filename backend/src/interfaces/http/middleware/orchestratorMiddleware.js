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
const mongoose = require("mongoose");
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
  if (!userId || !mongoose.Types.ObjectId.isValid(userId)) return next();
  if (!exerciseId || !mongoose.Types.ObjectId.isValid(exerciseId)) return next();
  if (typeof userMessage !== "string" || userMessage.trim() === "") return next();
  if (interaccionId && !mongoose.Types.ObjectId.isValid(interaccionId)) return next();

  const reqId = trace.traceRequestStart("orchestrator", {
    userId: userId, exerciseId: exerciseId, interaccionId: interaccionId, userMessage: userMessage,
  });
  const budgetMs = Number(process.env.ORCHESTRATOR_BUDGET_MS || 45000);
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

    // Send response as a single chunk (same as ragMiddleware)
    const responseText = ctx.finalResponse || ctx.llmResponse || "";
    if (responseText) {
      sseSend(res, { chunk: responseText });
      trace.traceResponse(reqId, {
        len: responseText.length,
        containsFIN: responseText.includes(FIN_TOKEN),
        response: responseText,
      });
    }

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
