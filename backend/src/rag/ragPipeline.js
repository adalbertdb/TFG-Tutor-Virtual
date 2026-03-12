// Main agentic RAG pipeline: classifier -> retrieval -> CRAG -> augmentation

const config = require("./config");
const { classifyQuery, extractResistances, types } = require("./queryClassifier");
const { hybridSearch } = require("./hybridSearch");
const { searchKG } = require("./knowledgeGraph");
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

// Format classification hint for the LLM
function formatClassificationHint(classification) {
  const hints = {
    dont_know: "El estudiante dice que no sabe la respuesta. Guíale desde los conceptos básicos.",
    single_word: "El estudiante ha dado una respuesta muy corta sin razonamiento. Pídele que razone su respuesta.",
    wrong_answer: "El estudiante ha dado resistencias incorrectas. Guíale con preguntas socráticas.",
    correct_no_reasoning: "El estudiante ha dado las resistencias correctas pero no ha explicado por qué. Pídele que razone.",
    correct_wrong_reasoning: "El estudiante ha dado las resistencias correctas pero ha usado un concepto erróneo. Corrige el concepto.",
    correct_good_reasoning: "El estudiante ha dado las resistencias correctas con buen razonamiento. Aprueba y profundiza.",
    wrong_concept: "El estudiante ha usado un concepto erróneo. Corrige la confusión con preguntas socráticas.",
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
  const classification = classifyQuery(userMessage, correctAnswer);

  const result = {
    augmentation: "",
    decision: "no_rag",
    sources: [],
    classification: classification.type,
  };

  // Step B: Route to appropriate retrieval strategy
  if (classification.type === types.greeting) {
    return result;
  }

  if (classification.type === types.dontKnow) {
    const kgResults = searchKG(["corriente", "tensión", "circuito", "resistencia"]);
    result.augmentation = formatClassificationHint(classification) + formatKGContext(kgResults);
    result.decision = "scaffold";
    result.sources = kgResults;
    return result;
  }

  if (classification.type === types.singleWord) {
    result.augmentation = formatClassificationHint(classification);
    result.decision = "demand_reasoning";
    return result;
  }

  if (classification.type === types.wrongAnswer) {
    let datasetResults = await hybridSearch(userMessage, exerciseNum);

    // CRAG: if top score is too low, reformulate and retry
    if (datasetResults.length === 0 || datasetResults[0].score < config.MED_THRESHOLD) {
      const reformulated = extractKeyEntities(userMessage);
      datasetResults = await hybridSearch(reformulated, exerciseNum);
    }

    result.augmentation = formatClassificationHint(classification) + formatExamples(datasetResults);
    result.decision = "rag_examples";
    result.sources = datasetResults;
    return result;
  }

  if (classification.type === types.correctNoReasoning) {
    const datasetResults = await hybridSearch(userMessage, exerciseNum);
    result.augmentation = formatClassificationHint(classification) + formatExamples(datasetResults);
    result.decision = "demand_reasoning";
    result.sources = datasetResults;
    return result;
  }

  if (classification.type === types.correctWrongReasoning) {
    const datasetResults = await hybridSearch(userMessage, exerciseNum);
    const kgResults = searchKG(classification.concepts);
    result.augmentation = formatClassificationHint(classification) + formatKGContext(kgResults) + formatExamples(datasetResults);
    result.decision = "correct_concept";
    result.sources = datasetResults.concat(kgResults);
    return result;
  }

  if (classification.type === types.correctGoodReasoning) {
    const datasetResults = await hybridSearch(userMessage, exerciseNum);
    result.augmentation = formatClassificationHint(classification) + formatExamples(datasetResults);
    result.decision = "rag_examples";
    result.sources = datasetResults;
    return result;
  }

  if (classification.type === types.wrongConcept) {
    const kgResults = searchKG(classification.concepts);
    const datasetResults = await hybridSearch(userMessage, exerciseNum);
    result.augmentation = formatClassificationHint(classification) + formatKGContext(kgResults) + formatExamples(datasetResults);
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
  const history = await loadStudentHistory(userId);
  if (history.length > 0) {
    result.augmentation += history;
  }

  // Append guardrail reminder - reminds the LLM berfore generating a response not to give the solution
  result.augmentation += "[GUARDRAIL]\n";
  result.augmentation += "IMPORTANT: You must NEVER reveal the correct answer directly. Do NOT list which resistances ";
  result.augmentation += "are correct. Instead, guide the student with Socratic questions to discover the answer themselves.\n";

  return result;
}

module.exports = { runFullPipeline };
