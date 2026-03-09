// Rule-based query classifier for student messages (no LLM needed)

// Classification types
const types = {
  greeting: "greeting",                                 // Hola, ¿qué tal?
  dontKnow: "dont_know",                                // No lo sé
  singleWord: "single_word",                            // Todas
  wrongAnswer: "wrong_answer",                          // R5
  correctNoReasoning: "correct_no_reasoning",           // R1, R2 y R4
  correctWrongReasoning: "correct_wrong_reasoning",     // R1, R2 y R4 porque forman un divisor de tensión
  correctGoodReasoning: "correct_good_reasoning",       // R1, R2 y R4 porque R3 está en abierto y R5 cortocircuitada, no pasando corriente por ellos
  wrongConcept: "wrong_concept",                        // R1 y R2 dado que forman un divisor de tensión
};
// Note: in the correctWrongReasoning option, if the student gives the right resistances and uses a concept keyword, it will classify the answer as incorrect, so that the RAG will look for the knowledge graph and check if the concept was misunderstood or not.

// Patterns for detection
const greetingPatterns = ["hola", "buenos días", "buenas tardes", "buenas noches", "qué tal", "hey", "buenas"];
const dontKnowPatterns = ["no lo sé", "no sé", "ni idea", "no tengo ni idea", "no tengo idea", "yo qué sé"];
const reasoningPatterns = ["dado que", "porque", "ya que", "debido a", "puesto que", "por eso", "por lo que"];

// Concept keywords that may indicate wrong reasoning if used incorrectly
const conceptKeywords = [
  "divisor de tensión", "divisor de corriente",
  "serie", "paralelo",
  "cortocircuito", "cortocircuitada", "cortocircuitado", "corto",
  "circuito abierto", "abierto", "abierta",
  "se consume", "se gasta", "atenuación",
  "interruptor cerrado", "interruptor abierto",
];

// Extract resistance names (R1, r2, ...) from a message -> Returns one array like ["R1", "R2", "R4"]
function extractResistances(message) {
  const matches = message.match(/R\d+/gi); 
  // this regex looks for:
  // - "R"
  // - One or more digits (0-9)
  // - All coincidences, not only the first one
  // - Doesn't matter if they are in uppercase or lowercase - (r1, R1)

  if (matches == null) {
    return [];
  }

  // Uppercase and remove duplicates
  const unique = [];
  const seen = {};
  for (let i = 0; i < matches.length; i++) {
    const r = matches[i].toUpperCase();
    if (seen[r] == null) {
      seen[r] = true;
      unique.push(r);
    }
  }
  return unique;
}

// Check if two arrays of resistances contain the same elements (order doesn't matter)
function sameSet(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  const sorted1 = a.slice().sort();
  const sorted2 = b.slice().sort();
  for (let i = 0; i < sorted1.length; i++) {
    if (sorted1[i] !== sorted2[i]) {
      return false;
    }
  }
  return true;
}

// Check if the message contains reasoning keywords
function hasReasoning(message) {
  const lower = message.toLowerCase();
  for (let i = 0; i < reasoningPatterns.length; i++) {
    if (lower.includes(reasoningPatterns[i])) {
      return true;
    }
  }
  return false;
}

// Find which concept keywords appear in the message
function findConcepts(message) {
  const lower = message.toLowerCase();
  const found = [];
  for (let i = 0; i < conceptKeywords.length; i++) {
    if (lower.includes(conceptKeywords[i])) {
      found.push(conceptKeywords[i]);
    }
  }
  return found;
}

// Check if the message is a greeting
function isGreeting(message) {
  const lower = message.toLowerCase().trim();
  for (let i = 0; i < greetingPatterns.length; i++) {
    if (lower.startsWith(greetingPatterns[i])) {
      return true;
    }
  }
  return false;
}

// Check if the message expresses "I don't know"
function isDontKnow(message) {
  const lower = message.toLowerCase();
  for (let i = 0; i < dontKnowPatterns.length; i++) {
    if (lower.includes(dontKnowPatterns[i])) {
      return true;
    }
  }
  return false;
}

/*------------------------------------------------------
  Classify a student message based on:
    - correctAnswer: array of correct resistances ["R1", "R2", "R4"]
  Returns: { type, resistances, hasReasoning, concepts }
--------------------------------------------------------*/
function classifyQuery(userMessage, correctAnswer) {
  const resistances = extractResistances(userMessage);
  const reasoning = hasReasoning(userMessage);
  const concepts = findConcepts(userMessage);

  // 1. Greeting
  if (isGreeting(userMessage)) {
    return { type: types.greeting, resistances: resistances, hasReasoning: reasoning, concepts: concepts };
  }

  // 2. Don't know
  if (isDontKnow(userMessage)) {
    return { type: types.dontKnow, resistances: resistances, hasReasoning: reasoning, concepts: concepts };
  }

  // 3. Single word / short answer without resistances
  if (userMessage.trim().length < 15 && resistances.length === 0) {
    return { type: types.singleWord, resistances: resistances, hasReasoning: reasoning, concepts: concepts };
  }

  // 4. Has correct resistances
  if (sameSet(resistances, correctAnswer)) {
    // Correct answer but no reasoning
    if (!reasoning) {
      return { type: types.correctNoReasoning, resistances: resistances, hasReasoning: reasoning, concepts: concepts };
    }
    // Correct answer with wrong concepts (uses "divisor de tensión" incorrectly for instance)
    if (concepts.length > 0) {
      return { type: types.correctWrongReasoning, resistances: resistances, hasReasoning: reasoning, concepts: concepts };
    }
    // Correct answer with good reasoning
    return { type: types.correctGoodReasoning, resistances: resistances, hasReasoning: reasoning, concepts: concepts };
  }

  // 5. Wrong resistances with concept keywords -> wrong concept
  if (concepts.length > 0) {
    return { type: types.wrongConcept, resistances: resistances, hasReasoning: reasoning, concepts: concepts };
  }

  // 6. Wrong answer
  return { type: types.wrongAnswer, resistances: resistances, hasReasoning: reasoning, concepts: concepts };
}

module.exports = { classifyQuery, extractResistances, types };
