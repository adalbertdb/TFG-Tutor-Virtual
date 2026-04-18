// Express middleware that intercepts POST /chat/stream to add RAG augmentation
// If RAG handles the request, it responds directly. If not, it calls next() and the original handler takes over.

const express = require("express");
const axios = require("axios");
const https = require("https");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const config = require("../../../infrastructure/llm/config");
const { runFullPipeline } = require("../../../domain/services/rag/ragPipeline");
const { checkSolutionLeak, getStrongerInstruction, checkFalseConfirmation, getFalseConfirmationInstruction, checkPrematureConfirmation, getPartialConfirmationInstruction, checkStateReveal, getStateRevealInstruction, checkElementNaming, removeOpeningConfirmation, redactElementMentions, redactStateRevealSentence, loadConceptPatternsFromKG, enforceDatasetStyle, checkDidacticExplanation, getScaffoldInstruction } = require("../../../domain/services/rag/guardrails");
const { loadKG, getAllEntries } = require("../../../infrastructure/search/knowledgeGraph");
const { loadIndex } = require("../../../infrastructure/search/bm25");
const { logInteraction } = require("../../../infrastructure/llm/logger");
const { setRequestId, emitEvent } = require("../../../infrastructure/events/ragEventBus");
const { buildTutorSystemPrompt } = require("../../../domain/services/promptBuilder");
const { resolveLanguage, getFinishMessages, getElementNamingInstruction, getRandomIntermediatePhrase, getAllPatterns, frustrationPatterns: frustrationDict } = require("../../../domain/services/languageManager");
const Ejercicio = require("../../../infrastructure/persistence/mongodb/models/ejercicio");
const Interaccion = require("../../../infrastructure/persistence/mongodb/models/interaccion");
const HeuristicSecurityAdapter = require("../../../infrastructure/security/HeuristicSecurityAdapter");

const securityService = new HeuristicSecurityAdapter({
  logger: function (event, payload) {
    emitEvent(event, "end", payload);
  },
});

let requestCounter = 0;

const router = express.Router();
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const FIN_TOKEN = "<FIN_EJERCICIO>";

// Canonical exercise number mapping (exercise 2 → 1 because they share the same dataset in ChromaDB)
const canonicalExercise = {};

// RAG initialization: load KG + BM25 at the start
let ragReady = false;
let kgConceptPatterns = [];

function initRAG() {
  try {
    // Load knowledge graph into memory
    loadKG();
    try {
      kgConceptPatterns = loadConceptPatternsFromKG(getAllEntries());
      console.log("[RAG] Loaded " + kgConceptPatterns.length + " KG concept patterns for state-reveal guardrail");
    } catch (kgErr) {
      console.warn("[RAG] Could not derive concept patterns from KG:", kgErr.message);
    }

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

// Get all evaluable elements for generic extraction (correct + incorrect)
// 1. Explicit field in tutorContext (for non-electronics subjects)
// 2. Extract from netlist (backwards compatibility for circuits)
// 3. Fallback: only the correct answer
function getEvaluableElements(ejercicio) {
  var tc = ejercicio.tutorContext || {};

  // 1. Explicit field
  if (Array.isArray(tc.elementosEvaluables) && tc.elementosEvaluables.length > 0) {
    return tc.elementosEvaluables.map(function (e) { return String(e).toUpperCase().trim(); });
  }

  // 2. Extract from netlist (only passive/active components that can be answers: R, C, L, D, I)
  //    Excludes node identifiers (N*) and voltage sources (V*) which are structural,
  //    not answer elements. Students mentioning nodes in reasoning (e.g. "from N1 to N2")
  //    should NOT be treated as proposing wrong answer elements.
  if (tc.netlist) {
    var matches = tc.netlist.match(/[RCLDI]\d+/gi);
    if (matches) {
      var seen = {};
      var unique = [];
      for (var i = 0; i < matches.length; i++) {
        var m = matches[i].toUpperCase();
        if (!seen[m]) {
          seen[m] = true;
          unique.push(m);
        }
      }
      return unique;
    }
  }

  // 3. Fallback: only the correct answer
  return (tc.respuestaCorrecta || []).map(function (e) { return String(e).toUpperCase().trim(); });
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
function buildSystemPrompt(ejercicio, lang) {
  var systemPrompt = buildTutorSystemPrompt(ejercicio, lang);
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

// Count how many previous turns had a "correct" classification (for loop detection)
// Prevents the tutor from endlessly asking for better reasoning when the student has the right answer
async function countPreviousCorrectTurns(interaccionId) {
  var doc = await Interaccion.findById(interaccionId).select({ conversacion: 1 }).lean();
  if (!doc || !Array.isArray(doc.conversacion)) return 0;
  var count = 0;
  var correctTypes = ["correct_no_reasoning", "correct_wrong_reasoning", "correct_good_reasoning", "partial_correct"];
  for (var i = 0; i < doc.conversacion.length; i++) {
    var msg = doc.conversacion[i];
    if (msg.role === "assistant" && msg.metadata && msg.metadata.classification) {
      for (var j = 0; j < correctTypes.length; j++) {
        if (msg.metadata.classification === correctTypes[j]) {
          count++;
          break;
        }
      }
    }
  }
  return count;
}

// Count total assistant turns in the conversation
async function countTotalAssistantTurns(interaccionId) {
  var doc = await Interaccion.findById(interaccionId).select({ conversacion: 1 }).lean();
  if (!doc || !Array.isArray(doc.conversacion)) return 0;
  var count = 0;
  for (var i = 0; i < doc.conversacion.length; i++) {
    if (doc.conversacion[i].role === "assistant") count++;
  }
  return count;
}

// Count consecutive wrong classifications from the end of conversation
// Returns how many assistant messages in a row have wrong_answer, wrong_concept, or single_word
async function countConsecutiveWrongTurns(interaccionId) {
  var doc = await Interaccion.findById(interaccionId).select({ conversacion: 1 }).lean();
  if (!doc || !Array.isArray(doc.conversacion)) return 0;
  var wrongTypes = ["wrong_answer", "wrong_concept", "single_word"];
  var count = 0;
  for (var i = doc.conversacion.length - 1; i >= 0; i--) {
    var msg = doc.conversacion[i];
    if (msg.role !== "assistant") continue;
    if (!msg.metadata || !msg.metadata.classification) break;
    var isWrong = false;
    for (var j = 0; j < wrongTypes.length; j++) {
      if (msg.metadata.classification === wrongTypes[j]) {
        isWrong = true;
        break;
      }
    }
    if (!isWrong) break;
    count++;
  }
  return count;
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

// Build a short hint reminding the LLM what its last question was,
// so it can evaluate the student's response in context and avoid re-asking.
function buildConversationProgressHint(history) {
  if (!Array.isArray(history) || history.length < 2) return "";

  var lastAssistant = null;
  for (var i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") {
      lastAssistant = history[i].content;
      break;
    }
  }
  if (!lastAssistant) return "";

  var questions = lastAssistant.match(/[^.!?]*\?/g);
  var lastQuestion = questions && questions.length > 0
    ? questions[questions.length - 1].trim()
    : null;
  if (!lastQuestion) return "";

  return "[CONVERSATION CONTEXT]\n"
    + "Your last question to the student was: \"" + lastQuestion + "\"\n"
    + "Evaluate the student's current response as an answer to THIS question.\n"
    + "If they answered it correctly, acknowledge and advance. Do NOT re-ask.\n\n";
}

// Detect if the tutor has been asking the same question repeatedly.
// Uses a sliding window: compares ALL pairs among the last 4 assistant questions.
// This catches alternating patterns (A-B-A-B) that a 2-message comparison would miss.
async function detectTutorRepetition(interaccionId) {
  var doc = await Interaccion.findById(interaccionId)
    .select({ conversacion: { $slice: -12 } })
    .lean();
  if (!doc || !Array.isArray(doc.conversacion)) return { repeating: false };

  // Collect the last 4 assistant messages
  var assistantMessages = [];
  for (var i = doc.conversacion.length - 1; i >= 0 && assistantMessages.length < 4; i--) {
    if (doc.conversacion[i].role === "assistant") {
      assistantMessages.push(doc.conversacion[i].content || "");
    }
  }
  if (assistantMessages.length < 2) return { repeating: false };

  // Extract the last question from each assistant message
  function extractLastQuestion(text) {
    var qs = text.match(/[^.!?]*\?/g);
    return qs && qs.length > 0 ? qs[qs.length - 1].toLowerCase().trim() : "";
  }

  // Compute word overlap between two questions (words > 3 chars)
  function questionSimilarity(qa, qb) {
    var wordsA = qa.split(/\s+/).filter(function(w) { return w.length > 3; });
    var wordsB = qb.split(/\s+/).filter(function(w) { return w.length > 3; });
    if (wordsA.length === 0) return 0;
    var overlap = 0;
    for (var w = 0; w < wordsA.length; w++) {
      if (wordsB.indexOf(wordsA[w]) >= 0) overlap++;
    }
    return overlap / wordsA.length;
  }

  // Extract questions from all collected messages
  var questions = [];
  for (var m = 0; m < assistantMessages.length; m++) {
    var q = extractLastQuestion(assistantMessages[m]);
    if (q) questions.push(q);
  }
  if (questions.length < 2) return { repeating: false };

  // Compare all pairs: if ANY pair has > 50% overlap, repetition detected
  for (var a = 0; a < questions.length; a++) {
    for (var b = a + 1; b < questions.length; b++) {
      var sim = questionSimilarity(questions[a], questions[b]);
      if (sim > 0.5) {
        return { repeating: true, lastQuestion: questions[0] };
      }
    }
  }
  return { repeating: false };
}

// Detect if the student is expressing frustration (repeating themselves, "I already told you", etc.)
var frustrationPatternsAll = getAllPatterns(frustrationDict);
function detectFrustration(message) {
  var lower = message.toLowerCase();
  for (var i = 0; i < frustrationPatternsAll.length; i++) {
    if (lower.includes(frustrationPatternsAll[i])) {
      return true;
    }
  }
  return false;
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
    var userId = req.userId; // From session via globalAuth (NEVER from client)
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

    // Get all evaluable elements for generic extraction (correct + incorrect)
    var evaluableElements = getEvaluableElements(ejercicio);

    // Resolve language early (needed for intermediate feedback phrases in pipeline)
    var earlyLang = "es";
    if (interaccionId && mongoose.Types.ObjectId.isValid(interaccionId)) {
      var earlyHistory = await loadHistory(interaccionId);
      earlyLang = resolveLanguage(earlyHistory);
    }

    // 2b. Input guardrail: block prompt injection / off-topic BEFORE the LLM
    var securityResult = securityService.analyzeInput(userMessage.trim(), {
      lang: earlyLang,
      ejercicio: ejercicio,
      evaluableElements: evaluableElements,
    });
    if (!securityResult.safe) {
      emitEvent("security_block", "end", {
        category: securityResult.category,
        matchedPattern: securityResult.matchedPattern,
        userMessage: userMessage.trim(),
      });

      // Open SSE and answer with the redirect, persisting both user + assistant msgs
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      if (typeof res.flushHeaders === "function") res.flushHeaders();
      res.write(": ok\n\n");

      var hbBlock = setInterval(function () {
        res.write(": ping\n\n");
        if (typeof res.flush === "function") res.flush();
      }, 15000);

      try {
        var iidBlock = interaccionId || null;
        if (iidBlock) {
          var existsB = await Interaccion.exists({ _id: iidBlock, usuario_id: userId });
          if (!existsB) iidBlock = null;
        }
        if (iidBlock == null) {
          var createdB = await Interaccion.create({
            usuario_id: userId,
            ejercicio_id: exerciseId,
            inicio: new Date(),
            fin: new Date(),
            conversacion: [],
          });
          iidBlock = createdB._id.toString();
          sseSend(res, { interaccionId: iidBlock });
        }

        await Interaccion.updateOne(
          { _id: iidBlock },
          {
            $push: {
              conversacion: {
                $each: [
                  { role: "user", content: userMessage.trim() },
                  {
                    role: "assistant",
                    content: securityResult.redirectMessage,
                    metadata: {
                      blockedByInputGuardrail: true,
                      category: securityResult.category,
                      matchedPattern: securityResult.matchedPattern,
                    },
                  },
                ],
              },
              $set: { fin: new Date() },
            }
          }
        );

        sseSend(res, { chunk: securityResult.redirectMessage });
        endSSE(res, hbBlock);

        emitEvent("request_end", "end", {
          totalTimeMs: Date.now() - startTime,
          blockedByInputGuardrail: true,
          category: securityResult.category,
        });
      } catch (blockErr) {
        clearInterval(hbBlock);
        console.error("[RAG] Input guardrail error:", blockErr.message);
        sseSend(res, { error: "Error en el sistema RAG." });
        res.write("data: [DONE]\n\n");
        if (typeof res.flush === "function") res.flush();
        res.end();
      }
      return;
    }

    // 3. Run RAG pipeline (with generic evaluable elements and language)
    emitEvent("pipeline_start", "start", { userMessage: userMessage.trim(), exerciseNum: searchNum, correctAnswer: correctAnswer, userId: userId, evaluableElements: evaluableElements });
    var pipelineStart = Date.now();
    var ragResult = await runFullPipeline(userMessage.trim(), searchNum, correctAnswer, userId, evaluableElements, earlyLang);
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
        // Verify the interaccion exists AND belongs to the authenticated user
        var exists = await Interaccion.exists({ _id: iid, usuario_id: userId });
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

      // 6. Save user message (with student response time if there is a previous assistant message)
      var text = userMessage.trim();
      var studentResponseMs = null;
      var lastDoc = await Interaccion.findById(iid).select({ conversacion: { $slice: -1 } }).lean();
      if (lastDoc && lastDoc.conversacion && lastDoc.conversacion.length > 0) {
        var lastMsg = lastDoc.conversacion[lastDoc.conversacion.length - 1];
        if (lastMsg.role === "assistant" && lastMsg.timestamp) {
          studentResponseMs = Date.now() - new Date(lastMsg.timestamp).getTime();
        }
      }
      var userMetadata = studentResponseMs != null ? { metadata: { studentResponseMs: studentResponseMs } } : {};
      await Interaccion.updateOne(
        { _id: iid },
        { $push: { conversacion: Object.assign({ role: "user", content: text }, userMetadata) }, $set: { fin: new Date() } }
      );

      // 7. Deterministic finish: correct answer → check if we can finish directly
      var isCorrect = ragResult.classification === "correct_good_reasoning"
        || ragResult.classification === "correct_no_reasoning"
        || ragResult.classification === "correct_wrong_reasoning";

      // 7a. Pedagogical rule: we NEVER close an exercise without real justification.
      // If the student keeps giving the right elements but no reasoning, we do NOT
      // override the classification. Instead, we raise a flag that will inject a
      // strong instruction into the tutor prompt (see section 8 below) demanding
      // that the student explicitly justify WHY, using concepts from the KG
      // (cortocircuito, circuito abierto, divisor de tension, etc.).
      var repetitionInfo = await detectTutorRepetition(iid);
      var demandJustification = false;
      var prevCorrectCount = 0;
      if (isCorrect && ragResult.classification !== "correct_good_reasoning") {
        prevCorrectCount = await countPreviousCorrectTurns(iid);
        if (prevCorrectCount >= 1) {
          demandJustification = true;
          console.log("[RAG] Student has given correct answer " + prevCorrectCount + " times without reasoning; demanding justification");
        }
      }

      // 7b. Global loop-breaking: independent of classification
      // Counts consecutive wrong turns and total turns to prevent infinite loops
      var wrongStreak = await countConsecutiveWrongTurns(iid);
      var totalTurns = await countTotalAssistantTurns(iid);
      var stuckHint = "";

      if (wrongStreak >= config.MAX_WRONG_STREAK || totalTurns >= config.MAX_TOTAL_TURNS) {
        console.log("[RAG] Global loop-break: wrongStreak=" + wrongStreak + " totalTurns=" + totalTurns);
        stuckHint = "[STUDENT IS STUCK]\n"
          + "CRITICAL: The student has been struggling for many turns (" + totalTurns + " total, " + wrongStreak + " wrong in a row).\n"
          + "CHANGE YOUR STRATEGY COMPLETELY. Do NOT repeat any previous question.\n"
          + "Instead:\n"
          + "1. Briefly summarize what the student has gotten right so far.\n"
          + "2. Give a CONCRETE HINT: describe a property of the circuit that helps narrow down the answer (e.g., 'In this circuit, there is a component whose two terminals are connected to the same node — what does that imply?').\n"
          + "3. Ask a very specific, NEW question that directly advances toward the answer.\n"
          + "Keep your response short and focused.\n\n";
      }

      if (isCorrect) {
        // Load history to check if the student has already been reasoning
        var prevHistory = await loadHistory(iid);
        var hasConversation = prevHistory.length >= 2; // At least 1 exchange before this
        var lang = resolveLanguage(prevHistory);

        if (ragResult.classification === "correct_good_reasoning") {
          // Student gave correct answer and has been reasoning (or gave reasoning now) → finish
          emitEvent("deterministic_finish", "end", { classification: ragResult.classification, historyLength: prevHistory.length, finished: true });
          var finishMsg = getFinishMessages(lang).identifiedResistances + FIN_TOKEN;
          sseSend(res, { chunk: finishMsg });

          await Interaccion.updateOne(
            { _id: iid },
            { $push: { conversacion: { role: "assistant", content: finishMsg, metadata: {
              classification: ragResult.classification,
              decision: "deterministic_finish",
              isCorrectAnswer: true,
              timing: { pipelineMs: pipelineTime, totalMs: Date.now() - startTime },
            } } }, $set: { fin: new Date() } }
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
      var history = await loadHistory(iid);
      var lang = resolveLanguage(history);
      var basePrompt = buildSystemPrompt(ejercicio, lang);
      var progressHint = buildConversationProgressHint(history);
      // If tutor repetition detected, inject a strong instruction to move forward
      var repetitionHint = "";
      if (repetitionInfo.repeating) {
        console.log("[RAG] Tutor repetition detected, injecting move-forward instruction");
        repetitionHint = "[ANTI-LOOP]\n"
          + "CRITICAL: You have been asking similar questions repeatedly and the student is stuck.\n"
          + "DO NOT ask any question you have asked before. Instead:\n"
          + "1. Briefly acknowledge what the student has said correctly so far.\n"
          + "2. Give a CONCRETE HINT about the circuit (without revealing the answer).\n"
          + "3. Ask a NEW, DIFFERENT question that the student has NOT been asked before.\n\n";
      }
      // If the student is frustrated, inject an empathetic instruction
      var frustrationHint = "";
      if (detectFrustration(text)) {
        console.log("[RAG] Student frustration detected");
        frustrationHint = "[STUDENT FRUSTRATED]\n"
          + "The student is expressing frustration because they feel they already answered your question.\n"
          + "DO NOT repeat any previous question. Instead:\n"
          + "1. Acknowledge their effort and validate what they said correctly.\n"
          + "2. If they have already provided correct reasoning, ACCEPT IT and move forward.\n"
          + "3. If something is still missing, give a more concrete hint before asking.\n"
          + "Be empathetic and brief.\n\n";
      }
      // Scaffold hint: when the student says "I don't know" / "no lo sé",
      // the tutor MUST NOT explain the concept. It must lower the scaffold
      // and ask a SIMPLER, more CONCRETE question about a visible feature of
      // the circuit so the student can reason themselves.
      var scaffoldHint = "";
      if (ragResult.classification === "dont_know") {
        scaffoldHint = "[STUDENT DOESN'T KNOW]\n"
          + "CRITICAL: The student just said they don't know. You MUST:\n"
          + "- NOT explain concepts. NOT give definitions. NOT say 'this means that...' or 'when a resistor is X, then Y'.\n"
          + "- NOT reveal internal states (short-circuited, open, same potential, etc.).\n"
          + "- Lower the scaffolding: ask ONE simpler, more concrete question about a VISIBLE feature of the circuit (e.g. 'Look at where the two terminals of one of the elements are connected. Do you notice anything?').\n"
          + "- Keep the response to a SINGLE question, no preamble, no explanation.\n\n";
      }

      // Demand justification hint: when the student has given correct elements
      // multiple times but never justified, force the tutor to ask explicitly.
      var justificationHint = "";
      if (demandJustification) {
        justificationHint = "[DEMAND JUSTIFICATION]\n"
          + "CRITICAL: The student has given the CORRECT answer " + prevCorrectCount + " time(s) WITHOUT any justification, or with INCORRECT reasoning.\n"
          + "You MUST NOT accept the answer as final. You MUST NOT emit <FIN_EJERCICIO>.\n"
          + "Your ONLY task this turn is:\n"
          + "1. Briefly acknowledge that they have the right elements.\n"
          + "2. Ask DIRECTLY and CLEARLY: 'Explica por que' / 'Explain why' / 'Explica per que', requiring them to use a concept such as cortocircuito, circuito abierto, divisor de tension, ley de Ohm, Kirchhoff, etc.\n"
          + "3. Do NOT name the correct elements in your question. Use generic wording like 'esos elementos' / 'those elements'.\n"
          + "4. Do NOT provide the reasoning yourself. The student must produce it.\n\n";
      }

      var augmentedPrompt = basePrompt + "\n\n" + progressHint + repetitionHint + frustrationHint + stuckHint + scaffoldHint + justificationHint + ragResult.augmentation;
      emitEvent("prompt_built", "end", { systemPromptLength: basePrompt.length, ragAugmentationLength: ragResult.augmentation.length, totalPromptLength: augmentedPrompt.length, augmentationPreview: ragResult.augmentation });

      // 9. Load conversation history (last N messages)
      emitEvent("history_loaded", "end", { interaccionId: iid, messageCount: history.length, maxMessages: config.HISTORY_MAX_MESSAGES, messages: history.map(function (m) { return { role: m.role, content: m.content || "" }; }) });

      var messages = [{ role: "system", content: augmentedPrompt }];
      for (let i = 0; i < history.length; i++) {
        messages.push(history[i]);
      }

      // 10. Call Ollama (non-streaming so we can check guardrails before sending to client)
      emitEvent("ollama_call_start", "start", { model: config.OLLAMA_MODEL, temperature: config.OLLAMA_TEMPERATURE, num_ctx: config.OLLAMA_NUM_CTX, num_predict: config.OLLAMA_NUM_PREDICT, keep_alive: config.OLLAMA_KEEP_ALIVE, messageCount: messages.length, ollamaUrl: config.OLLAMA_CHAT_URL });
      var ollamaStart = Date.now();
      var fullResponse = await callOllama(messages);
      emitEvent("ollama_call_end", "end", { responseLength: fullResponse.length, responsePreview: fullResponse, durationMs: Date.now() - ollamaStart, reason: "non-streaming (guardrail check)" });

      // 11. Guardrail checks: solution leak + false confirmation
      var guardrailTriggered = false;

      // 11a. Check if the LLM revealed the solution (iterative: up to 2 retries)
      var leakCheck = checkSolutionLeak(fullResponse, correctAnswer);
      emitEvent("guardrail_leak", "end", { responsePreview: fullResponse, correctAnswer: correctAnswer, result: leakCheck, passed: !leakCheck.leaked, check: "Checks if LLM response reveals the correct answer resistances" });
      for (var leakAttempt = 1; leakAttempt <= 2 && leakCheck.leaked; leakAttempt++) {
        guardrailTriggered = true;
        console.log("[RAG] Guardrail triggered (leak) attempt " + leakAttempt + ": " + leakCheck.details);
        emitEvent("ollama_retry", "start", { reason: "solution_leak", retryCount: leakAttempt });

        var strongerPrompt = augmentedPrompt + getStrongerInstruction(lang);
        var retryMessages = [{ role: "system", content: strongerPrompt }];
        for (let i = 0; i < history.length; i++) {
          retryMessages.push(history[i]);
        }
        fullResponse = await callOllama(retryMessages);
        emitEvent("ollama_retry", "end", { reason: "solution_leak", responseLength: fullResponse.length });
        leakCheck = checkSolutionLeak(fullResponse, correctAnswer);
      }

      // 11b. Check if the LLM confirmed a wrong answer as correct
      var confirmCheck = checkFalseConfirmation(fullResponse, ragResult.classification);
      emitEvent("guardrail_false_confirm", "end", { responsePreview: fullResponse, classification: ragResult.classification, result: confirmCheck, passed: !confirmCheck.confirmed, check: "Checks if LLM falsely confirms a wrong answer as correct" });
      if (confirmCheck.confirmed) {
        guardrailTriggered = true;
        console.log("[RAG] Guardrail triggered (false confirm): " + confirmCheck.details);
        emitEvent("ollama_retry", "start", { reason: "false_confirmation", retryCount: 1 });

        var confirmPrompt = augmentedPrompt + getFalseConfirmationInstruction(lang);
        var confirmRetry = [{ role: "system", content: confirmPrompt }];
        for (let i = 0; i < history.length; i++) {
          confirmRetry.push(history[i]);
        }
        fullResponse = await callOllama(confirmRetry);
        emitEvent("ollama_retry", "end", { reason: "false_confirmation", responseLength: fullResponse.length });
      }

      // 11b2. Check if the LLM prematurely confirms a partially correct answer
      var prematureCheck = checkPrematureConfirmation(fullResponse, ragResult.classification);
      emitEvent("guardrail_premature_confirm", "end", { responsePreview: fullResponse, classification: ragResult.classification, result: prematureCheck, passed: !prematureCheck.premature, check: "Checks if LLM prematurely confirms correct answer without reasoning" });
      if (prematureCheck.premature) {
        guardrailTriggered = true;
        console.log("[RAG] Guardrail triggered (premature confirm): " + prematureCheck.details);
        emitEvent("ollama_retry", "start", { reason: "premature_confirmation", retryCount: 1 });

        var partialPrompt = augmentedPrompt + getPartialConfirmationInstruction(lang, ragResult.classification);
        var partialRetry = [{ role: "system", content: partialPrompt }];
        for (let i = 0; i < history.length; i++) {
          partialRetry.push(history[i]);
        }
        fullResponse = await callOllama(partialRetry);
        emitEvent("ollama_retry", "end", { reason: "premature_confirmation", responseLength: fullResponse.length });
      }

      // 11c. Check if the LLM reveals the state/topology/concept bound to a
      // specific evaluable element. Generic: any element type + any concept
      // name loaded from the knowledge graph. Iterative (up to 2 retries)
      // plus deterministic redaction fallback — the student must discover
      // states themselves, so we prefer a clunky placeholder to a leak.
      var stateCheck = checkStateReveal(fullResponse, evaluableElements, kgConceptPatterns);
      emitEvent("guardrail_state_reveal", "end", { responsePreview: fullResponse, result: stateCheck, passed: !stateCheck.revealed, check: "Checks if LLM reveals internal element states or KG concepts bound to a specific element" });
      for (var stateAttempt = 1; stateAttempt <= 2 && stateCheck.revealed; stateAttempt++) {
        guardrailTriggered = true;
        console.log("[RAG] Guardrail triggered (state reveal) attempt " + stateAttempt + ": " + stateCheck.details);
        emitEvent("ollama_retry", "start", { reason: "state_reveal", retryCount: stateAttempt });

        var statePrompt = augmentedPrompt + getStateRevealInstruction(lang);
        var stateRetry = [{ role: "system", content: statePrompt }];
        for (let i = 0; i < history.length; i++) {
          stateRetry.push(history[i]);
        }
        fullResponse = await callOllama(stateRetry);
        emitEvent("ollama_retry", "end", { reason: "state_reveal", responseLength: fullResponse.length });
        stateCheck = checkStateReveal(fullResponse, evaluableElements, kgConceptPatterns);
      }

      // 11c-bis. Surgical redaction: if the LLM still reveals state, rewrite
      // the offending sentence only, keeping the rest of the response intact.
      if (stateCheck.revealed) {
        var stateRedact = redactStateRevealSentence(fullResponse, evaluableElements, stateCheck.pattern, lang);
        if (stateRedact.redacted) {
          guardrailTriggered = true;
          console.log("[RAG] Deterministic state-reveal redaction applied");
          emitEvent("guardrail_redaction", "end", { reason: "state_reveal_fallback", before: fullResponse, after: stateRedact.text, pattern: stateCheck.pattern });
          fullResponse = stateRedact.text;
        }
      }

      // 11d. Check if the LLM names specific evaluable elements in questions/directives
      // Iterative: up to 2 retries. Final fallback: deterministic redaction.
      var namingCheck = checkElementNaming(fullResponse, evaluableElements);
      emitEvent("guardrail_element_naming", "end", { responsePreview: fullResponse, result: namingCheck, passed: !namingCheck.named, check: "Checks if LLM names specific elements in questions or directives" });
      for (var namingAttempt = 1; namingAttempt <= 2 && namingCheck.named; namingAttempt++) {
        guardrailTriggered = true;
        console.log("[RAG] Guardrail triggered (element naming) attempt " + namingAttempt + ": " + namingCheck.details);
        emitEvent("ollama_retry", "start", { reason: "element_naming", retryCount: namingAttempt });

        var namingPrompt = augmentedPrompt + getElementNamingInstruction(lang);
        var namingRetry = [{ role: "system", content: namingPrompt }];
        for (var ni = 0; ni < history.length; ni++) {
          namingRetry.push(history[ni]);
        }
        fullResponse = await callOllama(namingRetry);
        emitEvent("ollama_retry", "end", { reason: "element_naming", responseLength: fullResponse.length });
        namingCheck = checkElementNaming(fullResponse, evaluableElements);
      }

      // 11d-bis. Deterministic redaction fallback: if after the retries the
      // response STILL names correct elements in questions/directives, rewrite
      // them with a generic placeholder. Prefer clunky-but-safe over leaking.
      if (namingCheck.named) {
        var redactResult = redactElementMentions(fullResponse, correctAnswer, lang);
        if (redactResult.redacted) {
          guardrailTriggered = true;
          console.log("[RAG] Deterministic redaction applied (element naming could not be fixed by LLM)");
          emitEvent("guardrail_redaction", "end", { reason: "element_naming_fallback", before: fullResponse, after: redactResult.text });
          fullResponse = redactResult.text;
        }
      }

      // 11d-ter. Extra safety: if the response still literally contains ALL
      // correct elements together (e.g. "R1, R2, R4") redact them even when
      // they appear outside a question — this catches leaks in statements.
      var finalLeak = checkSolutionLeak(fullResponse, correctAnswer);
      if (finalLeak.leaked) {
        var redactResult2 = redactElementMentions(fullResponse, correctAnswer, lang);
        if (redactResult2.redacted) {
          guardrailTriggered = true;
          console.log("[RAG] Deterministic redaction applied (final leak safeguard)");
          emitEvent("guardrail_redaction", "end", { reason: "final_leak_safeguard", before: fullResponse, after: redactResult2.text });
          fullResponse = redactResult2.text;
        }
      }

      // 11e. Deterministic prefix fallback: if after all retries the response STILL
      // starts with a confirmation phrase for a wrong/partial answer, force a prefix.
      // ONLY apply when the student mentioned specific elements (they're answering the question).
      // When no elements are mentioned, the student is responding to a Socratic question about concepts —
      // the LLM confirming a correct concept is fine and forcing a negative prefix creates contradictions.
      var studentMentionedElements = ragResult.mentionedElements && ragResult.mentionedElements.length > 0;
      if (studentMentionedElements) {
        var finalConfirmCheck = checkFalseConfirmation(fullResponse, ragResult.classification);
        if (finalConfirmCheck.confirmed) {
          var prefix = getRandomIntermediatePhrase("wrong", lang);
          if (prefix) {
            console.log("[RAG] Deterministic prefix forced: " + prefix);
            var cleaned = removeOpeningConfirmation(fullResponse, lang);
            // Double pass: strip confirmations that survived after the first cleanup
            var secondPass = removeOpeningConfirmation(cleaned, lang);
            fullResponse = prefix + " " + secondPass;
            guardrailTriggered = true;
          }
        }
        var finalPrematureCheck = checkPrematureConfirmation(fullResponse, ragResult.classification);
        if (finalPrematureCheck.premature) {
          var partialPrefix = getRandomIntermediatePhrase("partial", lang);
          if (partialPrefix) {
            console.log("[RAG] Deterministic prefix forced (partial): " + partialPrefix);
            var cleaned = removeOpeningConfirmation(fullResponse, lang);
            var secondPass = removeOpeningConfirmation(cleaned, lang);
            fullResponse = partialPrefix + " " + secondPass;
            guardrailTriggered = true;
          }
        }
      }

      // 11d-quater. Didactic explanation check: the tutor must scaffold, not
      // explain. If the response contains definitional/explanatory patterns
      // ("this means that...", "when a resistor is X, then..."), retry up to
      // 2 times asking for a pure scaffolding question instead.
      var didacticCheck = checkDidacticExplanation(fullResponse);
      for (var didacticAttempt = 1; didacticAttempt <= 2 && didacticCheck.explaining; didacticAttempt++) {
        guardrailTriggered = true;
        console.log("[RAG] Guardrail triggered (didactic explanation) attempt " + didacticAttempt + ": " + didacticCheck.details);
        emitEvent("ollama_retry", "start", { reason: "didactic_explanation", retryCount: didacticAttempt });

        var scaffoldPrompt = augmentedPrompt + getScaffoldInstruction(lang);
        var scaffoldRetry = [{ role: "system", content: scaffoldPrompt }];
        for (var si = 0; si < history.length; si++) {
          scaffoldRetry.push(history[si]);
        }
        fullResponse = await callOllama(scaffoldRetry);
        emitEvent("ollama_retry", "end", { reason: "didactic_explanation", responseLength: fullResponse.length });
        didacticCheck = checkDidacticExplanation(fullResponse);
      }

      // 11e-bis. Enforce dataset style: strip markdown (bullets, bold,
      // numbered lists, headings) so the tutor output matches the concise
      // prose + one final question style of the training dataset.
      var styleResult = enforceDatasetStyle(fullResponse);
      if (styleResult && styleResult.changed) {
        console.log("[RAG] Dataset-style filter removed markdown formatting");
        emitEvent("guardrail_style", "end", { before: fullResponse, after: styleResult.text });
        fullResponse = styleResult.text;
        guardrailTriggered = true;
      }

      // 11f. Pedagogical safeguard: never allow <FIN_EJERCICIO> unless the
      // classification is correct_good_reasoning. Strips the token (and any
      // partial prefix) if the LLM tried to close without real justification.
      if (ragResult.classification !== "correct_good_reasoning" && fullResponse.includes(FIN_TOKEN)) {
        console.log("[RAG] Stripping FIN_EJERCICIO token: classification=" + ragResult.classification + " (closure requires correct_good_reasoning)");
        fullResponse = fullResponse.replaceAll(FIN_TOKEN, "").trimEnd();
        guardrailTriggered = true;
        emitEvent("guardrail_fin_stripped", "end", { classification: ragResult.classification });
      }

      // 12. Send response to client as SSE
      sseSend(res, { chunk: fullResponse });
      emitEvent("response_sent", "end", { responseLength: fullResponse.length, responsePreview: fullResponse, containsFIN: fullResponse.includes(FIN_TOKEN), guardrailTriggered: guardrailTriggered });

      // 13. Save assistant response to MongoDB with detailed metadata
      var ollamaMs = Date.now() - ollamaStart;
      var totalMs = Date.now() - startTime;
      var assistantMetadata = {
        classification: ragResult.classification,
        decision: ragResult.decision,
        guardrails: {
          solutionLeak: leakCheck.leaked,
          falseConfirmation: confirmCheck.confirmed,
          prematureConfirmation: prematureCheck.premature,
          stateReveal: stateCheck.revealed,
          elementNaming: namingCheck.named,
        },
        timing: {
          pipelineMs: pipelineTime,
          ollamaMs: ollamaMs,
          totalMs: totalMs,
        },
        sourcesCount: (ragResult.sources || []).length,
        isCorrectAnswer: isCorrect || false,
      };
      await Interaccion.updateOne(
        { _id: iid },
        { $push: { conversacion: { role: "assistant", content: fullResponse, metadata: assistantMetadata } }, $set: { fin: new Date() } }
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
