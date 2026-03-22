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
const { checkSolutionLeak, getStrongerInstruction, checkFalseConfirmation, getFalseConfirmationInstruction, checkStateReveal, getStateRevealInstruction } = require("./guardrails");
const { loadKG } = require("./knowledgeGraph");
const { loadIndex } = require("./bm25");
const { logInteraction } = require("./logger");
const { setRequestId, emitEvent } = require("./ragEventBus");
const { buildTutorSystemPrompt, getLanguageInstruction } = require("../utils/promptBuilder");
const Ejercicio = require("../models/ejercicio");
const Interaccion = require("../models/interaccion");

// Append language instruction to the last user message in the array.
// This is more effective than a separate system message because the LLM
// pays more attention to user-role content right before generation.
function injectLangIntoLastUserMsg(msgs, langInstr) {
  if (!langInstr) return;
  for (var j = msgs.length - 1; j >= 0; j--) {
    if (msgs[j].role === "user") {
      msgs[j] = { role: "user", content: msgs[j].content + "\n" + langInstr.trim() };
      return;
    }
  }
}

let requestCounter = 0;

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
    systemPrompt = "You are a Socratic tutor. Respond in the same language as the student. Do not give the solution: guide with concrete questions.";
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
  requestCounter++;
  setRequestId("req_" + requestCounter + "_" + Date.now());

  try {
    // 1. Extract and validate inputs
    var userId = req.body.userId;
    var exerciseId = req.body.exerciseId;
    var userMessage = req.body.userMessage;
    var interaccionId = req.body.interaccionId;

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) return next();
    if (!exerciseId || !mongoose.Types.ObjectId.isValid(exerciseId)) return next();
    if (typeof userMessage !== "string" || userMessage.trim() === "") return next();

    emitEvent("request_start", "start", { userId: userId, exerciseId: exerciseId, userMessage: userMessage, interaccionId: interaccionId });

    // 2. Load exercise from MongoDB
    var ejercicio = await Ejercicio.findById(exerciseId).lean();
    if (ejercicio == null) return next();

    var exerciseNum = getExerciseNum(ejercicio);
    if (exerciseNum == null) return next();

    var correctAnswer = getCorrectAnswer(ejercicio);
    if (correctAnswer.length === 0) return next();

    emitEvent("exercise_loaded", "end", { exerciseNum: exerciseNum, titulo: ejercicio.titulo, correctAnswer: correctAnswer, canonicalExercise: canonicalExercise[exerciseNum] || exerciseNum, datasetFile: config.EXERCISE_DATASET_MAP[exerciseNum] || "unknown" });

    // Use canonical exercise number for retrieval (exercise 2 → 1 in ChromaDB)
    var searchNum = canonicalExercise[exerciseNum] || exerciseNum;

    // 3. Run RAG pipeline
    emitEvent("pipeline_start", "start", { userMessage: userMessage.trim(), exerciseNum: searchNum, correctAnswer: correctAnswer, userId: userId });
    var pipelineStart = Date.now();
    var ragResult = await runFullPipeline(userMessage.trim(), searchNum, correctAnswer, userId);
    var pipelineTime = Date.now() - pipelineStart;
    emitEvent("pipeline_end", "end", { decision: ragResult.decision, classification: ragResult.classification, augmentationLength: (ragResult.augmentation || "").length, sourcesCount: (ragResult.sources || []).length, pipelineTimeMs: pipelineTime });

    // If no RAG needed (greeting, etc.), fall through to original handler
    if (ragResult.decision === "no_rag") {
      emitEvent("no_rag", "end", { reason: "greeting or non-RAG classification" });
      emitEvent("request_end", "end", { totalTimeMs: Date.now() - startTime });
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
      var langInstruction = getLanguageInstruction(text);
      await Interaccion.updateOne(
        { _id: iid },
        { $push: { conversacion: { role: "user", content: text } }, $set: { fin: new Date() } }
      );

      // 7. Deterministic finish: correct answer → check if we can finish directly
      var isCorrect = ragResult.classification === "correct_good_reasoning"
        || ragResult.classification === "correct_no_reasoning"
        || ragResult.classification === "correct_wrong_reasoning";

      if (isCorrect) {
        // Load history to check if the student has already been reasoning
        var prevHistory = await loadHistory(iid);
        var hasConversation = prevHistory.length >= 2; // At least 1 exchange before this

        if (ragResult.classification === "correct_good_reasoning"
          || (ragResult.classification === "correct_no_reasoning" && hasConversation)) {
          // Student gave correct answer and has been reasoning (or gave reasoning now) → finish
          emitEvent("deterministic_finish", "end", { classification: ragResult.classification, historyLength: prevHistory.length, finished: true });

          // Generate finish message via LLM so it matches the student's language
          var finishSystemPrompt = buildSystemPrompt(ejercicio) + getLanguageInstruction(text);
          var finishMessages = [{ role: "system", content: finishSystemPrompt }];
          for (let i = 0; i < prevHistory.length; i++) {
            finishMessages.push(prevHistory[i]);
          }
          finishMessages.push({
            role: "user",
            content: "INTERNAL INSTRUCTION (not a student message): The student just gave the correct answer with good reasoning. " +
              "Generate a short congratulatory message confirming they identified the resistors correctly, and ask if they have any remaining questions about the exercise. " +
              "Respond in the SAME LANGUAGE the student has been using in the conversation. End your message with the exact token " + FIN_TOKEN
          });
          injectLangIntoLastUserMsg(finishMessages, langInstruction);
          var finishMsg;
          try {
            finishMsg = await callOllama(finishMessages);
            if (!finishMsg.includes(FIN_TOKEN)) {
              finishMsg = finishMsg + FIN_TOKEN;
            }
          } catch (e) {
            finishMsg = "Correct! You have correctly identified the resistors. Do you have any remaining questions about the exercise?" + FIN_TOKEN;
          }
          sseSend(res, { chunk: finishMsg });

          await Interaccion.updateOne(
            { _id: iid },
            { $push: { conversacion: { role: "assistant", content: finishMsg } }, $set: { fin: new Date() } }
          );

          emitEvent("mongodb_save", "end", { interaccionId: iid, messagesAdded: 2 });
          endSSE(res, hb);

          logInteraction({
            exerciseNum: exerciseNum, userId: userId,
            correctAnswer: correctAnswer,
            classification: ragResult.classification, decision: "deterministic_finish",
            query: text, response: finishMsg,
            timing: { total: Date.now() - startTime },
          });
          emitEvent("log_written", "end", { logPath: "logs/rag/" });
          emitEvent("response_sent", "end", { responseLength: finishMsg.length, containsFIN: true });
          emitEvent("request_end", "end", { totalTimeMs: Date.now() - startTime });
          return;
        }
        // correct_no_reasoning without history → fall through to LLM to ask for reasoning
        // correct_wrong_reasoning → fall through to LLM to correct the concept
        emitEvent("deterministic_finish", "skip", { classification: ragResult.classification, historyLength: prevHistory.length, finished: false });
      }

      // 8. Build augmented system prompt (base prompt + RAG context)
      var basePrompt = buildSystemPrompt(ejercicio);
      var augmentedPrompt = basePrompt + "\n\n" + ragResult.augmentation + langInstruction;
      emitEvent("prompt_built", "end", { systemPromptLength: basePrompt.length, ragAugmentationLength: ragResult.augmentation.length, totalPromptLength: augmentedPrompt.length, augmentationPreview: ragResult.augmentation });

      // 9. Load conversation history (last N messages)
      var history = await loadHistory(iid);
      emitEvent("history_loaded", "end", { interaccionId: iid, messageCount: history.length, maxMessages: config.HISTORY_MAX_MESSAGES, messages: history.map(function (m) { return { role: m.role, content: m.content || "" }; }) });

      var messages = [{ role: "system", content: augmentedPrompt }];
      for (let i = 0; i < history.length; i++) {
        messages.push(history[i]);
      }
      injectLangIntoLastUserMsg(messages, langInstruction);

      // 10. Call Ollama (non-streaming so we can check guardrails before sending to client)
      emitEvent("ollama_call_start", "start", { model: config.OLLAMA_MODEL, temperature: config.OLLAMA_TEMPERATURE, num_ctx: config.OLLAMA_NUM_CTX, num_predict: config.OLLAMA_NUM_PREDICT, keep_alive: config.OLLAMA_KEEP_ALIVE, messageCount: messages.length, ollamaUrl: config.OLLAMA_CHAT_URL });
      var ollamaStart = Date.now();
      var fullResponse = await callOllama(messages);
      emitEvent("ollama_call_end", "end", { responseLength: fullResponse.length, responsePreview: fullResponse, durationMs: Date.now() - ollamaStart, reason: "non-streaming (guardrail check)" });

      // 11. Guardrail checks: solution leak + false confirmation
      var guardrailTriggered = false;

      // 11a. Check if the LLM revealed the solution
      var leakCheck = checkSolutionLeak(fullResponse, correctAnswer);
      emitEvent("guardrail_leak", "end", { responsePreview: fullResponse, correctAnswer: correctAnswer, result: leakCheck, passed: !leakCheck.leaked, check: "Checks if LLM response reveals the correct answer resistances" });
      if (leakCheck.leaked) {
        guardrailTriggered = true;
        console.log("[RAG] Guardrail triggered (leak): " + leakCheck.details);
        emitEvent("ollama_retry", "start", { reason: "solution_leak", retryCount: 1 });

        var strongerPrompt = augmentedPrompt + getStrongerInstruction() + langInstruction;
        var retryMessages = [{ role: "system", content: strongerPrompt }];
        for (let i = 0; i < history.length; i++) {
          retryMessages.push(history[i]);
        }
        injectLangIntoLastUserMsg(retryMessages, langInstruction);
        fullResponse = await callOllama(retryMessages);
        emitEvent("ollama_retry", "end", { reason: "solution_leak", responseLength: fullResponse.length });
      }

      // 11b. Check if the LLM confirmed a wrong answer as correct
      var confirmCheck = checkFalseConfirmation(fullResponse, ragResult.classification);
      emitEvent("guardrail_false_confirm", "end", { responsePreview: fullResponse, classification: ragResult.classification, result: confirmCheck, passed: !confirmCheck.confirmed, check: "Checks if LLM falsely confirms a wrong answer as correct" });
      if (confirmCheck.confirmed) {
        guardrailTriggered = true;
        console.log("[RAG] Guardrail triggered (false confirm): " + confirmCheck.details);
        emitEvent("ollama_retry", "start", { reason: "false_confirmation", retryCount: 1 });

        var confirmPrompt = augmentedPrompt + getFalseConfirmationInstruction() + langInstruction;
        var confirmRetry = [{ role: "system", content: confirmPrompt }];
        for (let i = 0; i < history.length; i++) {
          confirmRetry.push(history[i]);
        }
        injectLangIntoLastUserMsg(confirmRetry, langInstruction);
        fullResponse = await callOllama(confirmRetry);
        emitEvent("ollama_retry", "end", { reason: "false_confirmation", responseLength: fullResponse.length });
      }

      // 11c. Check if the LLM reveals the state of a resistance (internal topology info)
      var stateCheck = checkStateReveal(fullResponse);
      emitEvent("guardrail_state_reveal", "end", { responsePreview: fullResponse, result: stateCheck, passed: !stateCheck.revealed, check: "Checks if LLM reveals internal resistance states (open/short/topology)" });
      if (stateCheck.revealed) {
        guardrailTriggered = true;
        console.log("[RAG] Guardrail triggered (state reveal): " + stateCheck.details);
        emitEvent("ollama_retry", "start", { reason: "state_reveal", retryCount: 1 });

        var statePrompt = augmentedPrompt + getStateRevealInstruction() + langInstruction;
        var stateRetry = [{ role: "system", content: statePrompt }];
        for (let i = 0; i < history.length; i++) {
          stateRetry.push(history[i]);
        }
        injectLangIntoLastUserMsg(stateRetry, langInstruction);
        fullResponse = await callOllama(stateRetry);
        emitEvent("ollama_retry", "end", { reason: "state_reveal", responseLength: fullResponse.length });
      }

      // 12. Send response to client as SSE
      sseSend(res, { chunk: fullResponse });
      emitEvent("response_sent", "end", { responseLength: fullResponse.length, responsePreview: fullResponse, containsFIN: fullResponse.includes(FIN_TOKEN), guardrailTriggered: guardrailTriggered });

      // 13. Save assistant response to MongoDB
      await Interaccion.updateOne(
        { _id: iid },
        { $push: { conversacion: { role: "assistant", content: fullResponse } }, $set: { fin: new Date() } }
      );
      emitEvent("mongodb_save", "end", { interaccionId: iid, messagesAdded: 2 });

      // 14. Close SSE connection
      endSSE(res, hb);

      // 15. Log for evaluation
      logInteraction({
        exerciseNum: exerciseNum, userId: userId,
        correctAnswer: correctAnswer,
        classification: ragResult.classification, decision: ragResult.decision,
        query: text, retrievedDocs: ragResult.sources,
        augmentation: ragResult.augmentation, response: fullResponse,
        guardrailTriggered: guardrailTriggered,
        timing: { pipeline: pipelineTime, total: Date.now() - startTime },
      });
      emitEvent("log_written", "end", { logPath: config.LOG_DIR, fields: ["exerciseNum", "userId", "correctAnswer", "classification", "decision", "query", "retrievedDocs", "augmentation", "response", "guardrailTriggered", "timing"] });
      emitEvent("request_end", "end", { totalTimeMs: Date.now() - startTime, guardrailTriggered: guardrailTriggered, pipelineTimeMs: pipelineTime, llmDurationMs: Date.now() - ollamaStart });
    } catch (innerErr) {
      // Error after SSE headers were sent → send error event and close
      clearInterval(hb);
      console.error("[RAG] Error:", innerErr.message);
      emitEvent("request_error", "end", { error: innerErr.message });
      sseSend(res, { error: "Error en el sistema RAG." });
      res.write("data: [DONE]\n\n");
      if (typeof res.flush === "function") res.flush();
      res.end();
    }
  } catch (err) {
    // Error before SSE headers → fall through to original handler
    console.error("[RAG] Fallback to original handler:", err.message);
    emitEvent("request_error", "end", { error: err.message });
    return next();
  }
});

module.exports = router;
