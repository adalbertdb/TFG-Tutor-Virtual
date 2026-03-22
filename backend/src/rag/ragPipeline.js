// Main agentic RAG pipeline: classifier -> retrieval -> CRAG -> augmentation

const config = require("./config");
const { classifyQuery, extractResistances, types } = require("./queryClassifier");
const { hybridSearch } = require("./hybridSearch");
const { searchKG } = require("./knowledgeGraph");
const { emitEvent } = require("./ragEventBus");
const Resultado = require("../models/resultado");

// Format dataset examples as context for the LLM
function formatExamples(results) {
  if (results.length === 0) {
    return "";
  }

/*-------------------------------------------------------------------------
[REFERENCE EXAMPLES]
The following are examples of how an expert tutor responds...

Example 1:
Student: "R1 y R2 por el divisor de tensión"
Tutor: "En un divisor de tensión todos los componentes están en serie..."

Example 2:
Student: "R5"
Tutor: "¿Por qué piensas que R5 ...?"
-------------------------------------------------------------------------*/

  let text = "[REFERENCE EXAMPLES]\n";
  text = text + "The following are examples of how an expert tutor responds to similar student answers.\n";
  text = text + "Use them as reference for tone and pedagogical approach. Adapt to the specific situation.\n\n";

  for (let i = 0; i < results.length; i++) {
    text = text + "Example " + (i + 1) + ":\n";
    text = text + "Student: \"" + results[i].student + "\"\n";
    text = text + "Tutor: \"" + results[i].tutor + "\"\n\n";
  }
  return text;
}

// Format knowledge graph results as context for the LLM
function formatKGContext(kgResults) {
  if (kgResults.length === 0) {
    return "";
  }

/*-------------------------------------------------------------------------
[DOMAIN KNOWLEDGE]
Concept: "Dispositivos pueden conectarse en serie y en paralelo"
Expert reasoning: "En una conexión en serie, los dispositivos se conectan uno tras otro,
formando un único camino para la corriente..."
Socratic questions: "¿En un divisor de tensión todos los componentes están conectados en serie?"

Concept: "Un cortocircuito tiene diferencia de potencial cero"
Expert reasoning: "Cuando un componente está cortocircuitado, la corriente no pasa por él..."
Socratic questions: "¿Qué ocurre con la corriente cuando un componente está cortocircuitado?"
-------------------------------------------------------------------------*/

  let text = "[DOMAIN KNOWLEDGE]\n";
  for (let i = 0; i < kgResults.length; i++) {
    const entry = kgResults[i];
    text = text + "Concept: \"" + entry.node1 + " " + entry.relation + " " + entry.node2 + "\"\n";
    if (entry.expertReasoning) {
      text = text + "Expert reasoning: \"" + entry.expertReasoning + "\"\n";
    }
    if (entry.socraticQuestions) {
      text = text + "Socratic questions: \"" + entry.socraticQuestions + "\"\n";
    }
    if (entry.acName) {
      text = text + "Alternative conception: \"" + entry.acName + "\"\n";
    }
    if (entry.acDescription) {
      text = text + "AC description: \"" + entry.acDescription + "\"\n";
    }
    text = text + "\n";
  }
  return text;
}

// Analyze each resistance the student mentioned: which are correct, which are wrong
function analyzeStudentResistances(resistances, correctAnswer) {
  if (resistances.length === 0) {
    return "";
  }

  const correctSet = {};
  for (let i = 0; i < correctAnswer.length; i++) {
    correctSet[correctAnswer[i]] = true;
  }

  const correctOnes = [];
  const wrongOnes = [];
  for (let i = 0; i < resistances.length; i++) {
    if (correctSet[resistances[i]]) {
      correctOnes.push(resistances[i]);
    } else {
      wrongOnes.push(resistances[i]);
    }
  }

  // Also find correct resistances the student missed
  const mentionedSet = {};
  for (let i = 0; i < resistances.length; i++) {
    mentionedSet[resistances[i]] = true;
  }
  const missed = [];
  for (let i = 0; i < correctAnswer.length; i++) {
    if (!mentionedSet[correctAnswer[i]]) {
      missed.push(correctAnswer[i]);
    }
  }

  let text = "[PER-RESISTANCE ANALYSIS] (internal, NEVER reveal to student)\n";
  text = text + "The student mentioned: " + resistances.join(", ") + ".\n";

  if (correctOnes.length > 0) {
    text = text + "- CORRECT: " + correctOnes.join(", ") + " ARE in the correct answer.\n";
  }
  if (wrongOnes.length > 0) {
    text = text + "- WRONG: " + wrongOnes.join(", ") + " are NOT in the correct answer.\n";
  }
  if (missed.length > 0) {
    text = text + "- MISSING: The student has not mentioned " + missed.join(", ") + " which ARE in the correct answer.\n";
  }

  text = text + "CRITICAL: Evaluate EACH resistance independently. If the student says multiple resistances, some may be correct and others wrong. ";
  text = text + "Do NOT confirm or deny them as a group. ";
  text = text + "If the student says something correct about one resistance, acknowledge it. ";
  text = text + "If the student says something wrong about another, guide them to reconsider THAT specific one.\n";

  // Add explicit tone guidance based on actual correctness
  if (wrongOnes.length > 0 && correctOnes.length > 0) {
    text = text + "TONE: The answer is PARTIALLY correct. Do NOT use 'Perfect', 'Very good', 'Great'. Say something like 'You are on the right track, but not everything is correct' and guide them to reconsider the wrong parts.\n";
  } else if (wrongOnes.length > 0 && correctOnes.length === 0) {
    text = text + "TONE: The answer is INCORRECT. Do NOT use any positive validation. Say 'That is not quite right' and ask a guiding question.\n";
  } else if (missed.length > 0) {
    text = text + "TONE: The answer is INCOMPLETE (correct so far, but missing resistances). Do NOT use 'Perfect' or 'Very good'. Say something like 'You are on the right track' and guide them to think about what else might be missing.\n";
  }
  text = text + "\n";
  return text;
}

// Format classification hint for the LLM
function formatClassificationHint(classification, correctAnswer) {
  const hints = {
    dont_know: "The student does not know where to start. Ask ONE question about a fundamental concept (e.g., 'What conditions does a resistor need for current to flow through it?'). Do NOT mention specific resistors.",
    single_word: "The student gave an answer without reasoning. Ask them to explain WHY they think that. Do not move forward until they reason.",
    wrong_answer: "The student gave incorrect resistors. Ask them to explain their reasoning. If you detect an alternative conception (AC), focus on questioning THAT concept with a Socratic question. Do NOT mention specific resistors or reveal states.",
    correct_no_reasoning: "The student got the correct answer but did not explain why. Ask them to justify their answer using circuit concepts. Do NOT confirm the answer until they reason.",
    correct_wrong_reasoning: "The student got the correct answer but uses a wrong concept. Focus on correcting the alternative conception with a Socratic question about the concept, NOT about the resistors.",
    correct_good_reasoning: "The student got the correct answer with good reasoning. Confirm briefly and finish.",
    wrong_concept: "The student shows an alternative conception. Focus ONLY on questioning that wrong concept with a Socratic question. Do NOT guide toward specific resistors.",
  };

  const hint = hints[classification.type];
  if (hint == null) {
    return "";
  }

  let text = "[RESPONSE MODE]\n";
  text = text + "The student's message has been classified as: " + classification.type + ".\n";
  text = text + hint + "\n";

  if (classification.concepts.length > 0) {
    text = text + "The student mentions: " + classification.concepts.join(", ") + ".\n";
  }

  text = text + "Follow the reference examples below to guide your response style.\n\n";

  // Add per-resistance analysis when the student mentions specific resistances
  if (classification.resistances.length > 0 && correctAnswer != null) {
    text = text + analyzeStudentResistances(classification.resistances, correctAnswer);
  }

  return text;
}

// Load the student's past AC errors from the Resultado model
async function loadStudentHistory(userId) {
  if (userId == null) {
    return "";
  }

  try {
    const resultados = await Resultado.find({ usuario_id: userId }).select("errores");

    // Count error tags across all exercises
    const errorCounts = {};
    for (let i = 0; i < resultados.length; i++) {
      const errores = resultados[i].errores;
      if (errores == null) {
        continue;
      }
      for (let j = 0; j < errores.length; j++) {
        const tag = errores[j].etiqueta;
        if (tag != null) {
          if (errorCounts[tag] == null) {
            errorCounts[tag] = 1;
          } 
          else {
            errorCounts[tag] = errorCounts[tag] + 1;
          }
        }
      }
    }

    const tags = Object.keys(errorCounts);
    if (tags.length === 0) {
      return "";
    }

    let text = "[STUDENT HISTORY]\n";
    text = text + "This student has previously shown these misconceptions:\n";
    for (let i = 0; i < tags.length; i++) {
      text = text + "- " + tags[i] + " (" + errorCounts[tags[i]] + " times)\n";
    }
    text = text + "Pay special attention to these recurring errors.\n\n";
    return text;
  } catch (err) {
    console.error("Error loading student history:", err.message);
    return "";
  }
}

// CRAG: extract key entities from the user message for query reformulation
function extractKeyEntities(userMessage) {
  const resistances = extractResistances(userMessage);
  const lower = userMessage.toLowerCase();

  // Collect important terms: resistances + concept keywords found
  const parts = [];
  for (let i = 0; i < resistances.length; i++) {
    parts.push(resistances[i]);
  }

  const conceptKeywords = [
    "divisor de tensión", "divisor de corriente",
    "serie", "paralelo",
    "corriente", "tensión", "resistencia",
    "cortocircuito", "cortocircuitada", "cortocircuitado", "corto",
    "circuito abierto", "abierto", "abierta",
    "se consume", "se gasta", "atenuación",
    "interruptor cerrado", "interruptor abierto",
  ];
  for (let i = 0; i < conceptKeywords.length; i++) {
    if (lower.includes(conceptKeywords[i])) {
      parts.push(conceptKeywords[i]);
    }
  }

  if (parts.length === 0) {
    return userMessage;
  }
  return parts.join(" ");
}

// Main pipeline: classifies, retrieves, evaluates quality, and builds augmentation
async function runPipeline(userMessage, exerciseNum, correctAnswer, userId) {
  // Step A: Classify the query
  emitEvent("classify_start", "start", { userMessage: userMessage, correctAnswer: correctAnswer, messageLength: userMessage.length });
  const classification = classifyQuery(userMessage, correctAnswer);
  var isCorrectAnswer = classification.resistances.length > 0 && classification.resistances.slice().sort().join(",") === correctAnswer.slice().sort().join(",");
  emitEvent("classify_end", "end", {
    type: classification.type,
    resistances: classification.resistances,
    hasReasoning: classification.hasReasoning,
    concepts: classification.concepts,
    isCorrectAnswer: isCorrectAnswer,
    resistanceCount: classification.resistances.length,
    conceptCount: classification.concepts.length,
  });

  const result = {
    augmentation: "",
    decision: "no_rag",
    sources: [],
    classification: classification.type,
  };

  // Step B: Route to appropriate retrieval strategy
  if (classification.type === types.greeting) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "no_rag", path: "greeting → no_rag" });
    return result;
  }

  if (classification.type === types.dontKnow) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "scaffold", path: "dont_know → scaffold" });
    // Only fetch the most relevant KG concepts for scaffolding (limit to 3 to avoid context overflow)
    emitEvent("kg_search_start", "start", { concepts: ["serie", "paralelo", "cortocircuito"] });
    const kgResults = searchKG(["serie", "paralelo", "cortocircuito"]);
    const limited = kgResults.slice(0, 3);
    emitEvent("kg_search_end", "end", { resultCount: limited.length, entries: limited.map(function(e) { return { node1: e.node1, relation: e.relation, node2: e.node2, acName: e.acName || null, acDescription: e.acDescription || null, expertReasoning: e.expertReasoning || "", socraticQuestions: e.socraticQuestions || "" }; }) });
    result.augmentation = formatClassificationHint(classification, correctAnswer) + formatKGContext(limited);
    result.decision = "scaffold";
    result.sources = limited;
    return result;
  }

  if (classification.type === types.singleWord) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "demand_reasoning", path: "single_word → demand_reasoning" });
    result.augmentation = formatClassificationHint(classification, correctAnswer);
    result.decision = "demand_reasoning";
    return result;
  }

  if (classification.type === types.wrongAnswer) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "rag_examples", path: "wrong_answer → rag_examples" });
    emitEvent("hybrid_search_start", "start", { query: userMessage, exerciseNum: exerciseNum, topK: config.TOP_K_FINAL });
    let datasetResults = await hybridSearch(userMessage, exerciseNum);
    emitEvent("hybrid_search_end", "end", { resultCount: datasetResults.length, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, results: datasetResults.map(function(r, i) { return { rank: i + 1, index: r.index, score: Math.round(r.score * 10000) / 10000, student: r.student || "", tutor: r.tutor || "" }; }) });

    // CRAG: if top score is too low, reformulate and retry
    if (datasetResults.length === 0 || datasetResults[0].score < config.MED_THRESHOLD) {
      const reformulated = extractKeyEntities(userMessage);
      emitEvent("crag_reformulate", "end", { originalQuery: userMessage, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, threshold: config.MED_THRESHOLD, reformulatedQuery: reformulated, reason: "topScore < MED_THRESHOLD (" + config.MED_THRESHOLD + ")", extractedEntities: reformulated.split(" ") });
      emitEvent("hybrid_search_start", "start", { query: reformulated, exerciseNum: exerciseNum, topK: config.TOP_K_FINAL });
      datasetResults = await hybridSearch(reformulated, exerciseNum);
      emitEvent("hybrid_search_end", "end", { resultCount: datasetResults.length, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, results: datasetResults.map(function(r, i) { return { rank: i + 1, index: r.index, score: Math.round(r.score * 10000) / 10000, student: r.student || "", tutor: r.tutor || "" }; }) });
    }

    result.augmentation = formatClassificationHint(classification, correctAnswer) + formatExamples(datasetResults);
    result.decision = "rag_examples";
    result.sources = datasetResults;
    return result;
  }

  if (classification.type === types.correctNoReasoning) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "demand_reasoning", path: "correct_no_reasoning → demand_reasoning" });
    emitEvent("hybrid_search_start", "start", { query: userMessage, exerciseNum: exerciseNum, topK: config.TOP_K_FINAL });
    const datasetResults = await hybridSearch(userMessage, exerciseNum);
    emitEvent("hybrid_search_end", "end", { resultCount: datasetResults.length, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, results: datasetResults.map(function(r, i) { return { rank: i + 1, index: r.index, score: Math.round(r.score * 10000) / 10000, student: r.student || "", tutor: r.tutor || "" }; }) });
    result.augmentation = formatClassificationHint(classification, correctAnswer) + formatExamples(datasetResults);
    result.decision = "demand_reasoning";
    result.sources = datasetResults;
    return result;
  }

  if (classification.type === types.correctWrongReasoning) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "correct_concept", path: "correct_wrong_reasoning → correct_concept" });
    emitEvent("hybrid_search_start", "start", { query: userMessage, exerciseNum: exerciseNum, topK: config.TOP_K_FINAL });
    const datasetResults = await hybridSearch(userMessage, exerciseNum);
    emitEvent("hybrid_search_end", "end", { resultCount: datasetResults.length, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, results: datasetResults.map(function(r, i) { return { rank: i + 1, index: r.index, score: Math.round(r.score * 10000) / 10000, student: r.student || "", tutor: r.tutor || "" }; }) });
    emitEvent("kg_search_start", "start", { concepts: classification.concepts });
    const kgResults = searchKG(classification.concepts);
    emitEvent("kg_search_end", "end", { resultCount: kgResults.length, entries: kgResults.map(function(e) { return { node1: e.node1, relation: e.relation, node2: e.node2, acName: e.acName || null, acDescription: e.acDescription || null, expertReasoning: e.expertReasoning || "", socraticQuestions: e.socraticQuestions || "" }; }) });
    result.augmentation = formatClassificationHint(classification, correctAnswer) + formatKGContext(kgResults) + formatExamples(datasetResults);
    result.decision = "correct_concept";
    result.sources = datasetResults.concat(kgResults);
    return result;
  }

  if (classification.type === types.correctGoodReasoning) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "rag_examples", path: "correct_good_reasoning → rag_examples" });
    emitEvent("hybrid_search_start", "start", { query: userMessage, exerciseNum: exerciseNum, topK: config.TOP_K_FINAL });
    const datasetResults = await hybridSearch(userMessage, exerciseNum);
    emitEvent("hybrid_search_end", "end", { resultCount: datasetResults.length, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, results: datasetResults.map(function(r, i) { return { rank: i + 1, index: r.index, score: Math.round(r.score * 10000) / 10000, student: r.student || "", tutor: r.tutor || "" }; }) });
    result.augmentation = formatClassificationHint(classification, correctAnswer) + formatExamples(datasetResults);
    result.decision = "rag_examples";
    result.sources = datasetResults;
    return result;
  }

  if (classification.type === types.wrongConcept) {
    emitEvent("routing_decision", "end", { classification: classification.type, decision: "concept_correction", path: "wrong_concept → concept_correction" });
    emitEvent("kg_search_start", "start", { concepts: classification.concepts });
    const kgResults = searchKG(classification.concepts);
    emitEvent("kg_search_end", "end", { resultCount: kgResults.length, entries: kgResults.map(function(e) { return { node1: e.node1, relation: e.relation, node2: e.node2, acName: e.acName || null, acDescription: e.acDescription || null, expertReasoning: e.expertReasoning || "", socraticQuestions: e.socraticQuestions || "" }; }) });
    emitEvent("hybrid_search_start", "start", { query: userMessage, exerciseNum: exerciseNum, topK: config.TOP_K_FINAL });
    const datasetResults = await hybridSearch(userMessage, exerciseNum);
    emitEvent("hybrid_search_end", "end", { resultCount: datasetResults.length, topScore: datasetResults.length > 0 ? Math.round(datasetResults[0].score * 10000) / 10000 : 0, results: datasetResults.map(function(r, i) { return { rank: i + 1, index: r.index, score: Math.round(r.score * 10000) / 10000, student: r.student || "", tutor: r.tutor || "" }; }) });
    result.augmentation = formatClassificationHint(classification, correctAnswer) + formatKGContext(kgResults) + formatExamples(datasetResults);
    result.decision = "concept_correction";
    result.sources = datasetResults.concat(kgResults);
    return result;
  }

  return result;
}

// Full pipeline with student history appended
async function runFullPipeline(userMessage, exerciseNum, correctAnswer, userId) {
  const result = await runPipeline(userMessage, exerciseNum, correctAnswer, userId);

  // If no RAG needed, skip 
  if (result.decision === "no_rag") {
    return result;
  }

  // Load student's past errors and append
  emitEvent("student_history_start", "start", { userId: userId });
  const history = await loadStudentHistory(userId);
  emitEvent("student_history_end", "end", { hasHistory: history.length > 0, historyLength: history.length, historyPreview: history });
  if (history.length > 0) {
    result.augmentation += history;
  }

  // Append guardrail reminder
  result.augmentation += "[GUARDRAIL]\n";
  result.augmentation += "CRITICAL RULES FOR YOUR RESPONSE:\n";
  result.augmentation += "1. Do NOT reveal the correct answer or list correct resistors together.\n";
  result.augmentation += "2. Do NOT confirm incorrect or PARTIALLY correct answers ('Perfect', 'Correct', 'Very good', 'Interesting', 'Good point'). If the answer is partially correct, say 'You are on the right track, but there is something to reconsider'. If incorrect, say 'That is not quite right'. If vague or minimal ('no', 'yes'), do NOT validate — just ask a guiding question.\n";
  result.augmentation += "3. Do NOT name specific resistors for the student to analyze ('What about R5?', 'Look at R3').\n";
  result.augmentation += "4. Do NOT reveal resistor states (short-circuited, open), switch positions, or connections between nodes.\n";
  result.augmentation += "5. Ask ONE single Socratic question about a CONCEPT, not about a component.\n";
  result.augmentation += "6. If the student shows an AC (alternative conception), focus on questioning THAT concept.\n";
  result.augmentation += "7. ALWAYS respond in the same language the student used in their last message.\n";

  emitEvent("augmentation_built", "end", { augmentationLength: result.augmentation.length, decision: result.decision, classification: result.classification, sourcesCount: result.sources.length, sections: ["hint", history.length > 0 ? "history" : null, result.sources.length > 0 ? "examples" : null, "guardrail_reminder"].filter(Boolean), augmentationPreview: result.augmentation });

  return result;
}

module.exports = { runFullPipeline };
