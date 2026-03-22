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
function checkFalseConfirmation(response, classification) {
  const checkTypes = ["wrong_answer", "wrong_concept", "single_word"];
  var shouldCheck = false;
  for (let i = 0; i < checkTypes.length; i++) {
    if (classification === checkTypes[i]) {
      shouldCheck = true;
      break;
    }
  }
  if (!shouldCheck) {
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
    "\n\nCRÍTICO: Tu respuesta anterior CONFIRMÓ como correcto algo que el alumno dijo MAL. " +
    "El alumno se ha equivocado. NO debes decir 'Perfecto', 'Correcto', 'Exactamente', 'Muy bien' ni nada similar. " +
    "Debes hacerle una pregunta socrática que le haga reconsiderar su error. " +
    "NO le digas directamente cuál es el error, pero tampoco le confirmes algo incorrecto."
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
    "\n\nCRÍTICO: Tu respuesta anterior REVELÓ el estado de una resistencia directamente (cortocircuitada, abierto, etc.). " +
    "Esa información es INTERNA y el alumno debe descubrirla por sí mismo. " +
    "NO digas el estado de ninguna resistencia. En su lugar, haz una pregunta socrática que guíe al alumno " +
    "a analizar el circuito y descubrir el estado por sí mismo. " +
    "Por ejemplo: '¿Qué observas en los nudos donde está conectada esa resistencia?'"
  );
}

// Instruction to append to the prompt when a leak is detected, so the LLM regenerates without revealing
function getStrongerInstruction() {
  return (
    "\n\nCRÍTICO: Tu respuesta anterior reveló la solución directamente. " +
    "NO debes listar las resistencias correctas juntas. NO debes decir cuáles son las resistencias correctas. " +
    "NO debes confirmar respuestas incorrectas del alumno como correctas. " +
    "En su lugar, haz UNA sola pregunta socrática corta que guíe al estudiante."
  );
}

// --- Language mixing guardrail ---

// Unicode script patterns for detecting unexpected characters in responses
var SCRIPT_PATTERNS = {
  cjk: /[\u4E00-\u9FFF\u3400-\u4DBF]/g,
  cyrillic: /[\u0400-\u04FF]/g,
  arabic: /[\u0600-\u06FF\u0750-\u077F]/g,
  thai: /[\u0E00-\u0E7F]/g,
  devanagari: /[\u0900-\u097F]/g,
  hangul: /[\uAC00-\uD7AF\u1100-\u11FF]/g,
  kana: /[\u3040-\u309F\u30A0-\u30FF]/g,
};

// Languages that use Latin script
var LATIN_LANGS = {
  af:1, ca:1, cs:1, cy:1, da:1, de:1, en:1, es:1, et:1, eu:1, fi:1, fr:1,
  ga:1, gl:1, hr:1, hu:1, id:1, is:1, it:1, lt:1, lv:1, ms:1, nl:1, no:1,
  pl:1, pt:1, ro:1, sk:1, sl:1, sq:1, sv:1, tl:1, tr:1, vi:1,
};

function getForbiddenScripts(langCode) {
  if (LATIN_LANGS[langCode]) {
    return ["cjk", "cyrillic", "arabic", "thai", "devanagari", "hangul", "kana"];
  }
  if (langCode === "zh" || langCode === "ja") return ["cyrillic", "arabic", "thai", "devanagari", "hangul"];
  if (langCode === "ko") return ["cyrillic", "arabic", "thai", "devanagari"];
  if (langCode === "ru" || langCode === "uk" || langCode === "bg") return ["cjk", "arabic", "thai", "devanagari", "hangul", "kana"];
  if (langCode === "ar" || langCode === "fa") return ["cjk", "cyrillic", "thai", "devanagari", "hangul", "kana"];
  if (langCode === "th") return ["cjk", "cyrillic", "arabic", "devanagari", "hangul", "kana"];
  if (langCode === "hi" || langCode === "mr") return ["cjk", "cyrillic", "arabic", "thai", "hangul", "kana"];
  return [];
}

// Check if the response contains characters from scripts that don't match the user's language
function checkLanguageMix(response, userLangCode) {
  if (!userLangCode || typeof response !== "string") {
    return { mixed: false, details: "" };
  }

  var forbidden = getForbiddenScripts(userLangCode);
  for (var i = 0; i < forbidden.length; i++) {
    var scriptName = forbidden[i];
    var regex = SCRIPT_PATTERNS[scriptName];
    if (!regex) continue;
    var matches = response.match(regex);
    if (matches && matches.length >= 2) {
      return {
        mixed: true,
        details: "Response contains " + matches.length + " " + scriptName + " characters but user language is " + userLangCode,
        detectedScript: scriptName,
      };
    }
  }

  return { mixed: false, details: "" };
}

// Instruction to append when language mixing is detected
function getLanguageMixInstruction() {
  return (
    "\n\nCRITICAL: Your previous response MIXED LANGUAGES — you switched to a completely different language mid-response. " +
    "This is unacceptable. You MUST write your ENTIRE response in the SAME language as the student's last message. " +
    "Do NOT include any words, phrases, or characters from another language. " +
    "Every single word must be in the student's language."
  );
}

// --- Answer directive guardrail ---
// Detects when the tutor tells/suggests the student to consider, analyze, or look at
// a specific element of the correct answer — this gives away part of the solution.
// Generic: works for any topic (resistances, capacitors, voltages, concepts, etc.)

const directivePhrases = [
  // Spanish — affirmative
  "no olvides", "no te olvides", "recuerda que", "recuerda considerar",
  "considera ", "analiza ", "piensa en ", "ten en cuenta ",
  "fíjate en ", "también deberías", "deberías considerar", "deberías analizar",
  "no dejes de considerar", "hay que tener en cuenta",
  // Spanish — question form (equally bad: directs to specific element)
  "por qué no consideraste", "por qué no has considerado", "por qué no incluyes",
  "por qué no mencionaste", "por qué no has mencionado", "por qué no incluiste",
  "qué pasa con ", "qué ocurre con ", "qué hay de ", "y qué hay de ",
  "has pensado en ", "has considerado ",
  // English — affirmative
  "don't forget", "do not forget", "don\u2019t forget", "consider ",
  "analyze ", "analyse ", "think about ", "look at ",
  "take into account", "remember that ", "you should also",
  "you should consider", "also consider", "keep in mind",
  // English — question form
  "why didn't you consider", "why didn't you include", "why didn't you mention",
  "what about ", "what happens with ", "have you considered ",
  "have you thought about ", "did you consider ",
  // French — affirmative
  "n'oublie pas", "ne oublie pas", "n'oubliez pas", "ne oubliez pas",
  "consid\u00e8re ", "consid\u00e9rer ", "pense \u00e0 ", "pensez \u00e0 ",
  "regarde ", "regardez ", "analyse ", "analysez ",
  "tiens compte", "tenez compte", "tu devrais aussi", "vous devriez aussi",
  "rappele", "rappelle", "il faut aussi", "il faut consid\u00e9rer",
  // French — question form
  "pourquoi tu n'as pas considéré", "pourquoi n'as-tu pas", "qu'en est-il de ",
  "et pour ", "as-tu pensé à ",
  // German
  "vergiss nicht", "denk an ", "denke an ", "betrachte ",
  "analysiere ", "ber\u00fccksichtige ", "du solltest auch",
  "was ist mit ", "hast du an ",
  // Italian
  "non dimenticare", "non dimenticarti", "considera ", "analizza ",
  "pensa a ", "ricorda ", "ricordati di", "tieni conto",
  "che ne dici di ", "hai considerato ",
  // Catalan
  "no oblidis", "considera ", "analitza ", "pensa en ", "recorda ",
  "per què no has considerat", "què passa amb ",
];

// answerElements: array of correct answer items (e.g. ["R1","R2","R4"], ["C1","C3"], etc.)
function checkAnswerDirective(response, answerElements) {
  if (!Array.isArray(answerElements) || answerElements.length === 0) {
    return { directed: false, details: "" };
  }

  var lowerElements = [];
  for (var k = 0; k < answerElements.length; k++) {
    lowerElements.push(String(answerElements[k]).toLowerCase());
  }

  // Split into sentences but preserve the delimiter so we can check question marks
  var sentences = response.split(/[.\n]/);
  for (var i = 0; i < sentences.length; i++) {
    var sentLower = sentences[i].toLowerCase();

    var foundElement = null;
    for (var m = 0; m < lowerElements.length; m++) {
      if (sentLower.includes(lowerElements[m])) {
        foundElement = answerElements[m];
        break;
      }
    }
    if (!foundElement) continue;

    // Check directive phrases — do NOT skip questions, because
    // "¿por qué no consideraste R4?" is just as bad as "no olvides R4"
    for (var j = 0; j < directivePhrases.length; j++) {
      if (sentLower.includes(directivePhrases[j])) {
        return {
          directed: true,
          details: "Response directs student to '" + foundElement + "' with: '" + directivePhrases[j].trim() + "'",
        };
      }
    }
  }

  return { directed: false, details: "" };
}

function getAnswerDirectiveInstruction() {
  return (
    "\n\nCR\u00cdTICO: Tu respuesta anterior LE DIJO al alumno qu\u00e9 elemento considerar o analizar. " +
    "Eso da parte de la respuesta. El alumno debe descubrir los elementos relevantes POR S\u00cd MISMO. " +
    "NUNCA digas 'no olvides X', 'considera Y', 'piensa en Z', 'ten en cuenta W', etc. " +
    "En su lugar, haz una pregunta CONCEPTUAL que le lleve a descubrir el elemento que le falta. " +
    "Por ejemplo: '\u00bfHay otros caminos por los que pueda circular corriente entre esos puntos?' o " +
    "'\u00bfQu\u00e9 otros componentes est\u00e1n conectados entre esos dos puntos del circuito?'"
  );
}

// --- New element introduction guardrail ---
// Detects when the tutor names an answer element that the student has never mentioned.
// studentMentioned: array of elements the student has mentioned across the conversation (e.g. ["R1", "R2"])
// answerElements: the correct answer elements (e.g. ["R1", "R2", "R4"])
function checkNewElementIntroduction(response, studentMentioned, answerElements) {
  if (!Array.isArray(answerElements) || answerElements.length === 0) {
    return { introduced: false, details: "" };
  }

  var mentionedSet = {};
  if (Array.isArray(studentMentioned)) {
    for (var i = 0; i < studentMentioned.length; i++) {
      mentionedSet[String(studentMentioned[i]).toUpperCase().trim()] = true;
    }
  }

  // Check all answer elements: if the tutor names one the student hasn't mentioned, flag it
  var responseLower = response.toLowerCase();
  for (var j = 0; j < answerElements.length; j++) {
    var elem = String(answerElements[j]).toUpperCase().trim();
    if (!mentionedSet[elem] && responseLower.includes(elem.toLowerCase())) {
      return {
        introduced: true,
        details: "Response names '" + elem + "' which the student has never mentioned",
      };
    }
  }

  // Also check non-answer resistances (R\d+) that the student never mentioned
  var responseResistances = extractResistances(response);
  for (var k = 0; k < responseResistances.length; k++) {
    if (!mentionedSet[responseResistances[k]]) {
      return {
        introduced: true,
        details: "Response names '" + responseResistances[k] + "' which the student has never mentioned",
      };
    }
  }

  return { introduced: false, details: "" };
}

function getNewElementIntroductionInstruction() {
  return (
    "\n\nCR\u00cdTICO: Tu respuesta anterior NOMBR\u00d3 una resistencia que el alumno NUNCA ha mencionado. " +
    "NO puedes introducir resistencias nuevas. Solo puedes referirte a resistencias que el alumno ya haya nombrado. " +
    "Si el alumno no ha descubierto todas las resistencias, haz una pregunta CONCEPTUAL que le lleve a descubrirlas: " +
    "'\u00bfHay otros caminos por los que pueda circular corriente?', '\u00bfCrees que todas las resistencias contribuyen?' " +
    "NUNCA nombres una resistencia que el alumno no haya mencionado antes."
  );
}

module.exports = { checkSolutionLeak, getStrongerInstruction, checkFalseConfirmation, getFalseConfirmationInstruction, checkStateReveal, getStateRevealInstruction, checkLanguageMix, getLanguageMixInstruction, checkAnswerDirective, getAnswerDirectiveInstruction, checkNewElementIntroduction, getNewElementIntroductionInstruction };
