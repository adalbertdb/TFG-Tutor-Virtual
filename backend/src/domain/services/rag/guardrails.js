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
} = require("../languageManager");

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

// Extract mentions of any evaluable element in a text.
// Works for any element identifier (R1, C2, L3, D1, V1, I2, etc.) as long as
// it's passed in `evaluableElements`. Uses word-boundary matching.
function extractElementMentions(text, evaluableElements) {
  if (!Array.isArray(evaluableElements) || evaluableElements.length === 0) {
    return [];
  }
  const found = [];
  const seen = {};
  const lower = text.toLowerCase();
  for (let i = 0; i < evaluableElements.length; i++) {
    const elem = evaluableElements[i];
    const lowerElem = String(elem).toLowerCase();
    const re = new RegExp(
      "(^|[^a-z0-9_])" + lowerElem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z0-9_]|$)",
      "i"
    );
    if (re.test(lower) && !seen[lowerElem]) {
      seen[lowerElem] = true;
      found.push(elem);
    }
  }
  return found;
}

// Check if the response reveals the internal state / topological property of
// a specific evaluable element (cortocircuitada, en abierto, en serie, en
// paralelo, misma potencial, etc.). Generic: works with any element type
// (resistencias, condensadores, inductores, diodos...). Does NOT allow
// rhetorical questions: "¿recuerdas que R5 está cortocircuitada?" is still a
// leak because it tells the student the state.
//
// @param {string} response
// @param {string[]} [evaluableElements] - list of element ids from the exercise
// @param {string[]} [extraPatterns] - additional reveal patterns (e.g. loaded from KG)
function checkStateReveal(response, evaluableElements, extraPatterns) {
  // Backward compatible: if no evaluableElements passed, fall back to Rn regex
  const elems = Array.isArray(evaluableElements) && evaluableElements.length > 0
    ? evaluableElements
    : null;

  const mentioned = elems
    ? extractElementMentions(response, elems)
    : extractResistances(response);

  if (mentioned.length === 0) {
    return { revealed: false, details: "" };
  }

  const allPatterns = Array.isArray(extraPatterns) && extraPatterns.length > 0
    ? stateRevealPatterns.concat(extraPatterns)
    : stateRevealPatterns;

  const sentences = response.split(/[.!?\n]/);
  for (let i = 0; i < sentences.length; i++) {
    const sent = sentences[i];
    const sentLower = sent.toLowerCase();
    const sentMentioned = elems
      ? extractElementMentions(sent, elems)
      : extractResistances(sent);
    if (sentMentioned.length === 0) continue;

    for (let j = 0; j < allPatterns.length; j++) {
      if (sentLower.includes(allPatterns[j])) {
        return {
          revealed: true,
          element: sentMentioned[0],
          pattern: allPatterns[j],
          details: "Response reveals state of " + sentMentioned.join(", ") + " with: '" + allPatterns[j] + "'",
        };
      }
    }
  }

  return { revealed: false, details: "" };
}

// Extract additional concept patterns from the knowledge graph so the state
// reveal check stays aligned with new concepts without editing hardcoded lists.
// Reads Node1/Node2/"AC name" fields and derives simple lowercase forms.
//
// @param {object[]} kg - parsed knowledge graph JSON
// @returns {string[]} additional phrases that, if asserted alongside an
//                     evaluable element, imply state reveal.
function loadConceptPatternsFromKG(kg) {
  if (!Array.isArray(kg)) return [];
  const set = {};
  const push = function (s) {
    if (typeof s !== "string") return;
    const t = s.trim().toLowerCase();
    if (t && t.length >= 4 && t.length <= 60) set[t] = true;
  };
  for (let i = 0; i < kg.length; i++) {
    const entry = kg[i] || {};
    push(entry.Node1);
    push(entry.Node2);
    push(entry["AC name"]);
    push(entry["AC name.1"]);
  }
  return Object.keys(set);
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

// Surgical redaction: locate the sentence that reveals element state and
// replace the element mention + the state/concept pattern with a generic
// placeholder, keeping the rest of the response intact. Used as the last
// resort when the LLM retries couldn't clean a state-reveal.
function redactStateRevealSentence(response, evaluableElements, pattern, lang) {
  if (!pattern || !Array.isArray(evaluableElements) || evaluableElements.length === 0) {
    return { text: response, redacted: false };
  }
  var placeholders = {
    es: "ese elemento tiene una propiedad relevante que debes identificar",
    val: "eixe element té una propietat rellevant que has d'identificar",
    en: "that element has a relevant property you should identify",
  };
  var placeholder = placeholders[lang] || placeholders.es;

  var sentences = response.split(/(?<=[.!?\n])\s*/);
  var redacted = false;
  for (var i = 0; i < sentences.length; i++) {
    var sent = sentences[i];
    var lowerSent = sent.toLowerCase();
    if (!lowerSent.includes(pattern.toLowerCase())) continue;

    var mentions = extractElementMentions(sent, evaluableElements);
    if (mentions.length === 0) continue;

    sentences[i] = placeholder + (sent.endsWith(" ") ? " " : "");
    redacted = true;
  }
  return { text: sentences.join(""), redacted: redacted };
}

// Deterministic last-resort redaction: if after retries the response still
// names correct elements in questions/directives, rewrite those mentions to a
// generic placeholder. Prefers a clunky-but-safe message over a leak.
function redactElementMentions(response, correctAnswer, lang) {
  if (!Array.isArray(correctAnswer) || correctAnswer.length === 0) {
    return { text: response, redacted: false };
  }

  var placeholders = {
    es: "ese conjunto de elementos",
    val: "eixe conjunt d'elements",
    en: "that set of elements",
  };
  var placeholder = placeholders[lang] || placeholders.es;

  var text = response;
  var changed = false;

  // 1) Replace comma-separated lists like "(R1, R2, R4)" / "R1, R2 y R4" / "R1, R2 and R4"
  var joined = correctAnswer.slice().map(function (r) {
    return r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  var listPattern = new RegExp(
    "\\(?\\s*" + joined.join("\\s*[,;y]\\s*|\\s*(?:y|i|and)\\s*") + "\\s*\\)?",
    "gi"
  );
  // simpler & more tolerant pattern: "R1, R2 y R4" (es) / "i" (val) / "and" (en) / commas
  var tolerantPattern = new RegExp(
    "\\(?\\s*" + joined[0] +
      joined.slice(1).map(function (r) {
        return "\\s*(?:,|;|y|i|and)\\s*" + r;
      }).join("") +
      "\\s*\\)?",
    "gi"
  );
  if (tolerantPattern.test(text)) {
    text = text.replace(tolerantPattern, placeholder);
    changed = true;
  }

  // 2) Replace any remaining individual mention of a correct element inside
  //    a question or directive sentence.
  var sentences = text.split(/(?<=[.!?\n])\s*/);
  for (var i = 0; i < sentences.length; i++) {
    var sent = sentences[i];
    var isQuestion = sent.includes("?") || sent.includes("¿");
    var isDirective = false;
    for (var d = 0; d < directivePatterns.length; d++) {
      if (directivePatterns[d].test(sent)) { isDirective = true; break; }
    }
    if (!isQuestion && !isDirective) continue;

    var newSent = sent;
    for (var j = 0; j < correctAnswer.length; j++) {
      var elem = correctAnswer[j];
      var safe = elem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      var re = new RegExp("\\b" + safe + "\\b", "gi");
      if (re.test(newSent)) {
        newSent = newSent.replace(re, placeholder);
        changed = true;
      }
    }
    sentences[i] = newSent;
  }
  text = sentences.join("");

  return { text: text, redacted: changed };
}

// Last-mile formatter: the dataset style is concise prose with a single final
// question. When the LLM ignores the prompt and returns bullets / bold /
// headings / numbered lists, we strip them deterministically. Non-destructive:
// keeps the original if it already looks clean.
function enforceDatasetStyle(response) {
  if (typeof response !== "string") return response;
  var text = response;
  var changed = false;

  // Strip markdown headings "# ...", "## ...", "### ..."
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, function () { changed = true; return ""; });

  // Strip **bold** and __bold__ markers (keep the inner text)
  text = text.replace(/\*\*(.+?)\*\*/g, function (_, inner) { changed = true; return inner; });
  text = text.replace(/__(.+?)__/g, function (_, inner) { changed = true; return inner; });

  // Strip single-asterisk emphasis *word* but NOT wildcards (keep inner)
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, function (_, pre, inner) { changed = true; return pre + inner; });

  // Remove bullet markers at the start of lines ("- ", "* ", "• ")
  text = text.replace(/^\s*[-*•]\s+/gm, function () { changed = true; return ""; });

  // Remove numbered-list markers at the start of lines ("1. ", "2) ", ...)
  text = text.replace(/^\s*\d+[.)]\s+/gm, function () { changed = true; return ""; });

  // Collapse multiple blank lines
  text = text.replace(/\n{3,}/g, "\n\n");

  // Trim edges
  text = text.trim();

  return { text: text, changed: changed };
}

module.exports = {
  checkSolutionLeak, getStrongerInstruction,
  checkFalseConfirmation, getFalseConfirmationInstruction,
  checkPrematureConfirmation, getPartialConfirmationInstruction,
  checkStateReveal, getStateRevealInstruction,
  checkElementNaming, removeOpeningConfirmation,
  redactElementMentions,
  redactStateRevealSentence,
  extractElementMentions,
  loadConceptPatternsFromKG,
  enforceDatasetStyle,
};
