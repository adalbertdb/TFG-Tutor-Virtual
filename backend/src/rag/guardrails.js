// Checks if the LLM response reveals the correct answer

// Phrases that indicate the tutor is revealing the solution directly
const revealPhrases = [
  "la respuesta es", "la respuesta correcta es", "las resistencias son", "las resistencias correctas son",  "la solución es",
  "deberías responder", "la respuesta sería", "la respuesta es", "las resistencias por las que circula corriente son",
  "las resistencias por las que no circula corriente son", "la respuesta final es",  "la solución correcta es"
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

// Check if the response reveals the correct answer
function checkSolutionLeak(response, correctAnswer) {
  const lower = response.toLowerCase();
  const mentioned = extractResistances(response);

  // If the response doesn't mention all correct resistances, no leak possible
  if (!sameSet(mentioned, correctAnswer)) {
    return { 
      leaked: false, 
      details: "" 
    };
  }

  // Check if the response also uses a reveal phrase
  for (let i = 0; i < revealPhrases.length; i++) {
    if (lower.includes(revealPhrases[i])) {
      return {
        leaked: true,
        details: "Response contains reveal phrase: '" + revealPhrases[i] + "' with all correct resistances",
      };
    }
  }

  return { leaked: false, details: "" };
}

// Instruction to append to the prompt when a leak is detected, so the LLM regenerates without revealing
function getStrongerInstruction() {
  return (
    "\n\nCRÍTICO: Tu respuesta anterior reveló la solución directamente. " +
    "NO debes listar las resistencias correctas. " +
    "En su lugar, haz una pregunta socrática que guíe al estudiante a descubrir la respuesta por sí mismo."
  );
}

module.exports = { checkSolutionLeak, getStrongerInstruction };
