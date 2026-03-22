// Checks if the LLM response reveals the correct answer

// Phrases that indicate the tutor is revealing the solution directly
const revealPhrases = [
  "la respuesta es", "la respuesta correcta es", "las resistencias son", "las resistencias correctas son", "la solución es",
  "deberías responder", "la respuesta sería", "las resistencias por las que circula corriente son",
  "las resistencias por las que no circula corriente son", "la respuesta final es", "la solución correcta es",
  "son precisamente", "son exactamente", "las que contribuyen son", "las que influyen son",
  "depende de", "dependen de", "las resistencias que contribuyen", "las resistencias relevantes son",
  "las resistencias que afectan", "las resistencias correctas son", "la respuesta correcta sería",
];

// Extract all resistance mentions (R1, R2, ...) 
function extractResistances(text) {
  const matches = text.match(/R\d+/gi);
  if (matches == null) {
    return [];
  }

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

// Check if two arrays contain the same elements (order doesn't matter)
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

// Check if all elements of subset exist in superset
function containsAll(superset, subset) {
  for (let i = 0; i < subset.length; i++) {
    var found = false;
    for (let j = 0; j < superset.length; j++) {
      if (superset[j] === subset[i]) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

// Check if the response reveals the correct answer
function checkSolutionLeak(response, correctAnswer) {
  const lower = response.toLowerCase();
  const mentioned = extractResistances(response);

  // If the response doesn't mention all correct resistances, no leak possible
  if (!containsAll(mentioned, correctAnswer)) {
    return {
      leaked: false,
      details: ""
    };
  }

  // Check 1: explicit reveal phrase + all correct resistances mentioned
  for (let i = 0; i < revealPhrases.length; i++) {
    if (lower.includes(revealPhrases[i])) {
      return {
        leaked: true,
        details: "Response contains reveal phrase: '" + revealPhrases[i] + "' with all correct resistances",
      };
    }
  }

  // Check 2: all correct resistances listed together in one sentence (e.g. "R1, R2 y R4")
  // Build pattern like "R1,?\s*(R2)?\s*y\s*R4" to catch "R1, R2 y R4" style listings
  if (correctAnswer.length >= 2) {
    const sorted = correctAnswer.slice().sort();
    // Build a regex: R1[,\s]+R2[,\s]+...[\sy]+Rn
    let pattern = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      pattern += "[,\\s]+(y\\s+)?" + sorted[i];
    }
    const regex = new RegExp(pattern, "i");
    if (regex.test(response)) {
      // Only flag if the sentence is affirmative (not a question)
      // Find the sentence containing the match
      const sentences = response.split(/[.!?\n]/);
      for (let i = 0; i < sentences.length; i++) {
        if (regex.test(sentences[i]) && !sentences[i].includes("?")) {
          return {
            leaked: true,
            details: "Response lists all correct resistances together in an affirmative sentence",
          };
        }
      }
    }
  }

  return { leaked: false, details: "" };
}

// Affirmative phrases that indicate the tutor is confirming a student's statement
const confirmPhrases = [
  "perfecto", "correcto", "exacto", "exactamente", "muy bien",
  "eso es", "así es", "bien hecho", "en efecto", "efectivamente",
  "has identificado correctamente", "estás en lo correcto",
  "buena observación", "buen trabajo",
];

// Check if the tutor is incorrectly confirming a wrong answer
// classification must be wrong_answer, wrong_concept, or similar
function checkFalseConfirmation(response, classification) {
  // Only check when the student's answer is wrong
  const wrongTypes = ["wrong_answer", "wrong_concept", "single_word"];
  var isWrong = false;
  for (let i = 0; i < wrongTypes.length; i++) {
    if (classification === wrongTypes[i]) {
      isWrong = true;
      break;
    }
  }
  if (!isWrong) {
    return { confirmed: false, details: "" };
  }

  const lower = response.toLowerCase().trim();

  // Check if response starts with or contains a confirmation phrase in the first 60 chars
  const firstPart = lower.substring(0, 60);
  for (let i = 0; i < confirmPhrases.length; i++) {
    if (firstPart.includes(confirmPhrases[i])) {
      return {
        confirmed: true,
        details: "Response confirms wrong answer with: '" + confirmPhrases[i] + "'",
      };
    }
  }

  return { confirmed: false, details: "" };
}

// Instruction to append when a false confirmation is detected
function getFalseConfirmationInstruction() {
  return (
    "\n\nCRITICAL: Your previous response CONFIRMED as correct something the student got WRONG. " +
    "The student made a mistake. You must NOT say 'Perfect', 'Correct', 'Exactly', 'Very good' or anything similar. " +
    "You must ask a Socratic question that makes them reconsider their error. " +
    "Do NOT tell them directly what the error is, but do NOT confirm something incorrect either. " +
    "ALWAYS respond in the same language the student used in their last message."
  );
}

// Phrases that reveal the state of a specific resistance (internal topology info)
const stateRevealPatterns = [
  "está cortocircuitad",    // cortocircuitada/cortocircuitado
  "está en cortocircuito",
  "está en circuito abierto",
  "está en abierto",
  "está en serie",
  "está en paralelo",
  "no circula corriente por",
  "no pasa corriente por",
  "circula corriente por",
  "pasa corriente por",
  "tiene corriente cero",
  "tiene tensión cero",
  "tiene diferencia de potencial cero",
  "no tiene caída de tensión",
  "ambos terminales",
  "mismo nudo",
  "mismo punto",
];

// Check if the response reveals the internal state of a specific resistance
// e.g. "R5 está cortocircuitada" or "recuerda que R3 está en circuito abierto"
function checkStateReveal(response) {
  const lower = response.toLowerCase();
  const resistances = extractResistances(response);

  if (resistances.length === 0) {
    return { revealed: false, details: "" };
  }

  // Split into sentences
  const sentences = response.split(/[.!?\n]/);
  for (let i = 0; i < sentences.length; i++) {
    const sentLower = sentences[i].toLowerCase();
    // Check if this sentence contains a resistance AND a state reveal phrase
    const sentResistances = extractResistances(sentences[i]);
    if (sentResistances.length === 0) {
      continue;
    }

    for (let j = 0; j < stateRevealPatterns.length; j++) {
      if (sentLower.includes(stateRevealPatterns[j])) {
        // Allow if it's a question (the tutor is asking, not telling)
        if (sentences[i].trim().endsWith("?") || sentLower.includes("¿")) {
          continue;
        }
        return {
          revealed: true,
          details: "Response reveals state of " + sentResistances.join(", ") + " with: '" + stateRevealPatterns[j] + "'",
        };
      }
    }
  }

  return { revealed: false, details: "" };
}

// Instruction to append when the tutor reveals the state of a resistance
function getStateRevealInstruction() {
  return (
    "\n\nCRITICAL: Your previous response REVEALED the state of a resistor directly (short-circuited, open, etc.). " +
    "That information is INTERNAL and the student must discover it on their own. " +
    "Do NOT state the condition of any resistor. Instead, ask a Socratic question that guides the student " +
    "to analyze the circuit and discover the state by themselves. " +
    "For example: 'What do you observe at the nodes where that resistor is connected?' " +
    "ALWAYS respond in the same language the student used in their last message."
  );
}

// Instruction to append to the prompt when a leak is detected, so the LLM regenerates without revealing
function getStrongerInstruction() {
  return (
    "\n\nCRITICAL: Your previous response revealed the solution directly. " +
    "You must NOT list the correct resistors together. You must NOT say which resistors are correct. " +
    "You must NOT confirm incorrect student answers as correct. " +
    "Instead, ask ONE single short Socratic question that guides the student. " +
    "ALWAYS respond in the same language the student used in their last message."
  );
}

module.exports = { checkSolutionLeak, getStrongerInstruction, checkFalseConfirmation, getFalseConfirmationInstruction, checkStateReveal, getStateRevealInstruction };
