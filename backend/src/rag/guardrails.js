// Checks if the LLM response reveals the correct answer

const {
  getAllPatterns,
  revealPhrases: revealDict,
  confirmPhrases: confirmDict,
  stateRevealPatterns: stateRevealDict,
  getStrongerInstruction: getLangStrongerInstruction,
  getFalseConfirmationInstruction: getLangFalseConfirmationInstruction,
  getPartialConfirmationInstruction: getLangPartialConfirmationInstruction,
  getStateRevealInstruction: getLangStateRevealInstruction,
} = require("../utils/languageManager");

// Phrases that indicate the tutor is revealing the solution directly (multi-language)
const revealPhrases = getAllPatterns(revealDict);

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

// Normalize accented characters for accent-insensitive matching
function stripAccents(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Affirmative phrases that indicate the tutor is confirming a student's statement (multi-language)
const confirmPhrases = getAllPatterns(confirmDict);

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

  const lower = stripAccents(response.toLowerCase().trim());

  // Check if response starts with or contains a confirmation phrase in the first 60 chars
  const firstPart = lower.substring(0, 60);
  for (let i = 0; i < confirmPhrases.length; i++) {
    if (firstPart.includes(stripAccents(confirmPhrases[i]))) {
      return {
        confirmed: true,
        details: "Response confirms wrong answer with: '" + confirmPhrases[i] + "'",
      };
    }
  }

  return { confirmed: false, details: "" };
}

// Instruction to append when a false confirmation is detected
function getFalseConfirmationInstruction(lang) {
  return getLangFalseConfirmationInstruction(lang);
}

// Check if the tutor prematurely confirms a partially correct answer
// (correct resistances but missing or wrong reasoning)
function checkPrematureConfirmation(response, classification) {
  var partialTypes = ["correct_no_reasoning", "correct_wrong_reasoning", "partial_correct"];
  var isPartial = false;
  for (var i = 0; i < partialTypes.length; i++) {
    if (classification === partialTypes[i]) {
      isPartial = true;
      break;
    }
  }
  if (!isPartial) {
    return { premature: false, details: "" };
  }

  var lower = stripAccents(response.toLowerCase().trim());
  var firstPart = lower.substring(0, 60);

  for (var i = 0; i < confirmPhrases.length; i++) {
    if (firstPart.includes(stripAccents(confirmPhrases[i]))) {
      return {
        premature: true,
        classificationType: classification,
        details: "Response prematurely confirms with: '" + confirmPhrases[i] + "' (classification: " + classification + ")",
      };
    }
  }

  return { premature: false, details: "" };
}

// Instruction to append when a premature confirmation is detected
function getPartialConfirmationInstruction(lang, classificationType) {
  return getLangPartialConfirmationInstruction(lang, classificationType);
}

// Phrases that reveal the state of a specific resistance (internal topology info, multi-language)
const stateRevealPatterns = getAllPatterns(stateRevealDict);

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
function getStateRevealInstruction(lang) {
  return getLangStateRevealInstruction(lang);
}

// Instruction to append to the prompt when a leak is detected, so the LLM regenerates without revealing
function getStrongerInstruction(lang) {
  return getLangStrongerInstruction(lang);
}

// =====================
// Guardrail 5: Element Naming in Questions (generic)
// =====================

// Directive verbs that indicate the tutor is pointing the student to a specific element
var directivePatterns = [
  /\b(analiza|observa|mira|fíjate en|considera|piensa en|revisa|examina|estudia)\b/i,
  /\b(look at|consider|analyze|think about|observe|examine|study|check)\b/i,
  /\b(analitza|observa|fixa't en|considera|pensa en|revisa|examina)\b/i,
];

// Check if the tutor names a specific evaluable element in a question or directive
function checkElementNaming(response, evaluableElements) {
  if (!Array.isArray(evaluableElements) || evaluableElements.length === 0) {
    return { named: false, details: "" };
  }

  // Split into sentences
  var sentences = response.split(/(?<=[.!?\n])\s*/);
  for (var i = 0; i < sentences.length; i++) {
    var sent = sentences[i];
    var sentLower = sent.toLowerCase();

    // Check if this sentence is a question or a directive
    var isQuestion = sent.includes("?") || sent.includes("¿");
    var isDirective = false;
    for (var d = 0; d < directivePatterns.length; d++) {
      if (directivePatterns[d].test(sent)) {
        isDirective = true;
        break;
      }
    }

    if (!isQuestion && !isDirective) {
      continue;
    }

    // Check if any evaluable element is named in this sentence
    for (var j = 0; j < evaluableElements.length; j++) {
      var elem = evaluableElements[j];
      var elemLower = elem.toLowerCase();
      var idx = sentLower.indexOf(elemLower);
      if (idx >= 0) {
        // Word boundary check
        var charBefore = idx > 0 ? sentLower[idx - 1] : " ";
        var charAfter = idx + elemLower.length < sentLower.length ? sentLower[idx + elemLower.length] : " ";
        var validBefore = /[\s,;:(¿¡"'\-]/.test(charBefore) || idx === 0;
        var validAfter = /[\s,;:).?!"'\-]/.test(charAfter) || idx + elemLower.length === sentLower.length;

        if (validBefore && validAfter) {
          return {
            named: true,
            element: elem,
            details: "Response names '" + elem + "' in a " + (isQuestion ? "question" : "directive"),
          };
        }
      }
    }
  }

  return { named: false, details: "" };
}

// Utility: remove opening confirmation phrases from a response
// Used when the guardrail retry still produces a confirmation — we strip it and prepend a deterministic prefix
// Iteratively strips all confirmation phrases from the start to avoid contradictions like:
// "Hmm, no estoy seguro. Exacto, en un cortocircuito..." → "Hmm, no estoy seguro. En un cortocircuito..."
function removeOpeningConfirmation(response, lang) {
  var result = response.trim();
  var changed = true;

  // Iteratively strip confirmation phrases from the beginning
  while (changed) {
    changed = false;
    // Strip leading punctuation (¡, ¿, !, spaces) before matching
    var stripped = result.replace(/^[¡¿!\s]+/, "");
    var lowerResult = stripAccents(stripped.toLowerCase());

    for (var i = 0; i < confirmPhrases.length; i++) {
      var phraseLower = stripAccents(confirmPhrases[i]);
      if (lowerResult.startsWith(phraseLower)) {
        // Strip the phrase and any following punctuation/whitespace
        var afterPhrase = stripped.substring(confirmPhrases[i].length).replace(/^[,;:!.\s¡¿]+/, "");
        result = afterPhrase;
        changed = true;
        break;
      }
    }
  }

  // If we stripped something, capitalize the first letter of remaining text
  if (result !== response.trim() && result.length > 0) {
    result = result.charAt(0).toUpperCase() + result.substring(1);
  }

  return result || response;
}

module.exports = {
  checkSolutionLeak, getStrongerInstruction,
  checkFalseConfirmation, getFalseConfirmationInstruction,
  checkPrematureConfirmation, getPartialConfirmationInstruction,
  checkStateReveal, getStateRevealInstruction,
  checkElementNaming, removeOpeningConfirmation,
};
