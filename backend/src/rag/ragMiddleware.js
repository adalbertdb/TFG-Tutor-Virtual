// Express middleware that intercepts POST /chat/stream to add RAG augmentation
// If RAG handles the request, it responds directly. If not, it calls next() and the original handler takes over.

const express = require("express");
const axios = require("axios");
const https = require("https");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const { runFullPipeline } = require("./ragPipeline");
const { checkSolutionLeak, getStrongerInstruction } = require("./guardrails");
const { loadKG } = require("./knowledgeGraph");
const { loadIndex } = require("./bm25");
const { logInteraction } = require("./logger");
const { buildTutorSystemPrompt } = require("../utils/promptBuilder");
const Ejercicio = require("../models/ejercicio");
const Interaccion = require("../models/interaccion");

const router = express.Router();
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const FIN_TOKEN = "<FIN_EJERCICIO>";

// Canonical exercise number mapping (exercise 2 → 1 because they share the same dataset in ChromaDB)
const canonicalExercise = {};

// RAG initialization: load KG + BM25 at the start
let ragReady = false;

function initRAG() {
  try {
    // Load knowledge graph into memory
    loadKG();

    // Build canonical mapping and load BM25 for all exercises
    const fileToFirst = {};
    const exerciseNums = Object.keys(config.EXERCISE_DATASET_MAP);

    for (let i = 0; i < exerciseNums.length; i++) {
      const num = Number(exerciseNums[i]);
      const fileName = config.EXERCISE_DATASET_MAP[num];

      // Track first exercise number for each dataset file (for ChromaDB collection lookup)
      if (fileToFirst[fileName] == null) {
        fileToFirst[fileName] = num;
      }
      canonicalExercise[num] = fileToFirst[fileName];

      // Load BM25 index for this exercise
      const filePath = path.join(config.DATASETS_DIR, fileName);
      const raw = fs.readFileSync(filePath, "utf-8");
      const pairs = JSON.parse(raw);
      loadIndex(num, pairs);
    }

    ragReady = true;
    console.log("[RAG] Ready");
  } catch (err) {
    console.error("[RAG] Init failed:", err.message);
  }
}

initRAG();

// Extract exercise number from title ("Ejercicio 1" → 1)
function getExerciseNum(ejercicio) {
  const match = (ejercicio.titulo || "").match(/(\d+)/);
  if (match != null) {
    return Number(match[1]);
  }
  return null;
}

// Get correct answer as normalized array ["R1", "R2", "R4"]
function getCorrectAnswer(ejercicio) {
  const answer = ejercicio.tutorContext && ejercicio.tutorContext.respuestaCorrecta;
  if (!Array.isArray(answer)) {
    return [];
  }
  const result = [];
  for (let i = 0; i < answer.length; i++) {
    result.push(String(answer[i]).toUpperCase().trim());
  }
  return result;
}

// Send SSE event to client (same format as the existing handler)
function sseSend(res, payload) {
  res.write("data: " + JSON.stringify(payload) + "\n\n");
  if (typeof res.flush === "function") res.flush();
}

// Axios config for HTTPS connections
function axiosOpts() {
  if (config.OLLAMA_CHAT_URL.startsWith("https://")) {
    return { httpsAgent: httpsAgent };
  }
  return {};
}

// Build system prompt with fallback (same as existing handler)
function buildSystemPrompt(ejercicio) {
  var systemPrompt = buildTutorSystemPrompt(ejercicio);
  if (typeof systemPrompt !== "string" || systemPrompt.trim() === "") {
    systemPrompt = "Eres un tutor socrático. Responde en español. No des la solución: guía con preguntas concretas.";
  }
  return systemPrompt;
}

// Call Ollama and get the full response (non-streaming, so we can check guardrails before sending to client)
async function callOllama(messages) {
  const response = await axios.post(
    config.OLLAMA_CHAT_URL + "/api/chat",
    {
      model: config.OLLAMA_MODEL,
      stream: false,
      keep_alive: config.OLLAMA_KEEP_ALIVE,
      messages: messages,
      options: {
        num_predict: config.OLLAMA_NUM_PREDICT,
        num_ctx: config.OLLAMA_NUM_CTX,
        temperature: config.OLLAMA_TEMPERATURE,
      },
    },
    { timeout: 180000, ...axiosOpts() }
  );
  return (response.data.message && response.data.message.content) || "";
}

// Load last N messages from conversation history
async function loadHistory(interaccionId) {
  const doc = await Interaccion.findById(interaccionId)
    .select({ conversacion: 1 })
    .slice("conversacion", -config.HISTORY_MAX_MESSAGES)
    .lean();

  if (doc == null || !Array.isArray(doc.conversacion)) {
    return [];
  }

  const messages = [];
  for (let i = 0; i < doc.conversacion.length; i++) {
    messages.push({ role: doc.conversacion[i].role, content: doc.conversacion[i].content });
  }
  return messages;
}

// End SSE connection cleanly
function endSSE(res, hb) {
  clearInterval(hb);
  res.write("data: [DONE]\n\n");
  if (typeof res.flush === "function") res.flush();
  res.end();
}

// Middleware: intercepts POST /chat/stream
router.post("/chat/stream", async function (req, res, next) {
  // Skip if RAG is disabled or not initialized
  if (!config.RAG_ENABLED || !ragReady) {
    return next();
  }

  const startTime = Date.now();

  try {
    // 1. Extract and validate inputs
    var userId = req.body.userId;
    var exerciseId = req.body.exerciseId;
    var userMessage = req.body.userMessage;
    var interaccionId = req.body.interaccionId;

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) return next();
    if (!exerciseId || !mongoose.Types.ObjectId.isValid(exerciseId)) return next();
    if (typeof userMessage !== "string" || userMessage.trim() === "") return next();

    // 2. Load exercise from MongoDB
    var ejercicio = await Ejercicio.findById(exerciseId).lean();
    if (ejercicio == null) return next();

    var exerciseNum = getExerciseNum(ejercicio);
    if (exerciseNum == null) return next();

    var correctAnswer = getCorrectAnswer(ejercicio);
    if (correctAnswer.length === 0) return next();

    // Use canonical exercise number for retrieval (exercise 2 → 1 in ChromaDB)
    var searchNum = canonicalExercise[exerciseNum] || exerciseNum;

    // 3. Run RAG pipeline
    var pipelineStart = Date.now();
    var ragResult = await runFullPipeline(userMessage.trim(), searchNum, correctAnswer, userId);
    var pipelineTime = Date.now() - pipelineStart;

    // If no RAG needed (greeting, etc.), fall through to original handler
    if (ragResult.decision === "no_rag") {
      return next();
    }

    // --- From here, RAG handles the full request ---

    // 4. Set up SSE (same headers as existing handler)
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    res.write(": ok\n\n");
    if (typeof res.flush === "function") res.flush();

    // Heartbeat every 15 seconds
    var hb = setInterval(function () {
      res.write(": ping\n\n");
      if (typeof res.flush === "function") res.flush();
    }, 15000);

    try {
      // 5. Load or create Interaccion
      var iid = interaccionId || null;
      if (iid) {
        var exists = await Interaccion.exists({ _id: iid });
        if (!exists) iid = null;
      }
      if (iid == null) {
        var created = await Interaccion.create({
          usuario_id: userId,
          ejercicio_id: exerciseId,
          inicio: new Date(),
          fin: new Date(),
          conversacion: [],
        });
        iid = created._id.toString();
        sseSend(res, { interaccionId: iid });
      }

      // 6. Save user message
      var text = userMessage.trim();
      await Interaccion.updateOne(
        { _id: iid },
        { $push: { conversacion: { role: "user", content: text } }, $set: { fin: new Date() } }
      );

      // 7. Deterministic finish: correct answer with good reasoning → no LLM needed
      if (ragResult.classification === "correct_good_reasoning") {
        var finishMsg = "Correcto. Has dado la respuesta exacta." + FIN_TOKEN;
        sseSend(res, { chunk: finishMsg });

        await Interaccion.updateOne(
          { _id: iid },
          { $push: { conversacion: { role: "assistant", content: finishMsg } }, $set: { fin: new Date() } }
        );

        endSSE(res, hb);

        logInteraction({
          exerciseNum: exerciseNum, userId: userId,
          classification: ragResult.classification, decision: "deterministic_finish",
          query: text, response: finishMsg,
          timing: { total: Date.now() - startTime },
        });
        return;
      }

      // 8. Build augmented system prompt (base prompt + RAG context)
      var basePrompt = buildSystemPrompt(ejercicio);
      var augmentedPrompt = basePrompt + "\n\n" + ragResult.augmentation;

      // 9. Load conversation history (last N messages)
      var history = await loadHistory(iid);

      var messages = [{ role: "system", content: augmentedPrompt }];
      for (let i = 0; i < history.length; i++) {
        messages.push(history[i]);
      }

      // 10. Call Ollama (non-streaming so we can check guardrails before sending to client)
      var fullResponse = await callOllama(messages);

      // 11. Guardrail check: if the LLM revealed the solution, regenerate
      var guardrailTriggered = false;
      var leakCheck = checkSolutionLeak(fullResponse, correctAnswer);
      if (leakCheck.leaked) {
        guardrailTriggered = true;
        console.log("[RAG] Guardrail triggered: " + leakCheck.details);

        // Regenerate with stronger instruction
        var strongerPrompt = augmentedPrompt + getStrongerInstruction();
        var retryMessages = [{ role: "system", content: strongerPrompt }];
        for (let i = 0; i < history.length; i++) {
          retryMessages.push(history[i]);
        }
        fullResponse = await callOllama(retryMessages);
      }

      // 12. Send response to client as SSE
      sseSend(res, { chunk: fullResponse });

      // 13. Save assistant response to MongoDB
      await Interaccion.updateOne(
        { _id: iid },
        { $push: { conversacion: { role: "assistant", content: fullResponse } }, $set: { fin: new Date() } }
      );

      // 14. Close SSE connection
      endSSE(res, hb);

      // 15. Log for evaluation
      logInteraction({
        exerciseNum: exerciseNum, userId: userId,
        classification: ragResult.classification, decision: ragResult.decision,
        query: text, retrievedDocs: ragResult.sources,
        augmentation: ragResult.augmentation, response: fullResponse,
        guardrailTriggered: guardrailTriggered,
        timing: { pipeline: pipelineTime, total: Date.now() - startTime },
      });
    } catch (innerErr) {
      // Error after SSE headers were sent → send error event and close
      clearInterval(hb);
      console.error("[RAG] Error:", innerErr.message);
      sseSend(res, { error: "Error en el sistema RAG." });
      res.write("data: [DONE]\n\n");
      if (typeof res.flush === "function") res.flush();
      res.end();
    }
  } catch (err) {
    // Error before SSE headers → fall through to original handler
    console.error("[RAG] Fallback to original handler:", err.message);
    return next();
  }
});

module.exports = router;
