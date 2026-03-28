// backend/src/utils/languageManager.js
// Central module for multilingual support (Spanish, Valencian, English)

const SUPPORTED_LANGS = ["es", "val", "en"];
const DEFAULT_LANG = "es";

// =====================
// Language switch detection
// =====================

const switchPatterns = {
  es: [
    "habla en español", "responde en español", "en castellano",
    "cambia a español", "puedes hablar en español", "habla español",
    "en español por favor", "vuelve al español",
  ],
  val: [
    "parla en valencià", "en valencià", "respon en valencià",
    "parla'm en valencià", "pots parlar en valencià", "cambia a valencià",
    "podem parlar en valencià", "podem en valencià", "en valencià per favor",
    "parla valencià",
  ],
  en: [
    "speak in english", "respond in english", "switch to english",
    "in english please", "can you speak english", "talk in english",
    "let's speak english", "english please",
  ],
};

// Check if a user message requests a language switch
// Returns "es", "val", "en", or null
function detectLanguageSwitch(message) {
  if (typeof message !== "string") return null;
  const lower = message.toLowerCase().trim();

  for (const lang of SUPPORTED_LANGS) {
    for (const pattern of switchPatterns[lang]) {
      if (lower.includes(pattern)) return lang;
    }
  }
  return null;
}

// Scan conversation history (most recent first) to find the active language
// Returns the last explicitly requested language, or "es" by default
function resolveLanguage(conversationHistory) {
  if (!Array.isArray(conversationHistory)) return DEFAULT_LANG;

  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const msg = conversationHistory[i];
    if (msg.role !== "user") continue;
    const detected = detectLanguageSwitch(msg.content);
    if (detected) return detected;
  }
  return DEFAULT_LANG;
}

// =====================
// System prompt language rules
// =====================

function getLanguageRules(lang) {
  if (lang === "val") {
    return `- Respon SEMPRE en valencià (varietat formal/estàndard).
- GRAMÀTICA VALENCIANA OBLIGATÒRIA:
  - El verb "fluir" es conjuga: "flueix" (NO "fluxiga", NO "fluïx").
  - "circuit" s'escriu sense accent (NO "cìrcuit", NO "circùit").
  - Usa "de la font" (femení) (NO "des del font", NO "del font").
  - Preposicions: "per la resistència" (NO "per el resistència").
  - Articles: "el circuit", "la resistència", "el corrent", "la font de tensió", "el nus".
  - Demostratius: "aquest circuit", "aquesta resistència" (registre formal).
  - Verb "ser/estar": "està curtcircuitada" (NO "es curtcircuitada").
  - Plurals: "les resistències", "els circuits", "els nusos".
  - Contraccions: "al circuit" (a + el), "del circuit" (de + el), "pel circuit" (per + el).
- TERMINOLOGIA TÈCNICA EN VALENCIÀ (usa SEMPRE estos termes):
  - terra (NO sòl)
  - nus (plural: nusos) (NO node)
  - condensador (NO capacitor)
  - font de tensió
  - resistència
  - corrent
  - curtcircuit / curtcircuitada
  - circuit obert
  - divisor de tensió
  - interruptor tancat / interruptor obert
- Mantén un to clar, pacient i tècnic.`;
  }

  if (lang === "en") {
    return `- ALWAYS respond in English.
- Use correct technical terminology: ground (not floor), node, capacitor, voltage source, resistance, current, short circuit, open circuit, voltage divider.
- Maintain a clear, patient, and technical tone.`;
  }

  // Default: Spanish (current behavior)
  return `- Responde SIEMPRE en español.
- Usa terminología correcta en español: di "tierra" (no "suelo"), "nudo" (no "nodo"), "condensador" (no "capacitor").
- Mantén un tono claro, paciente y técnico.`;
}

// =====================
// Deterministic finish messages
// =====================

const finishMessages = {
  es: {
    exactAnswer: "Correcto. Has dado la respuesta exacta.",
    identifiedResistances: "¡Correcto! Has identificado bien las resistencias. ¿Te ha quedado alguna duda sobre el ejercicio?",
  },
  val: {
    exactAnswer: "Correcte. Has donat la resposta exacta.",
    identifiedResistances: "Correcte! Has identificat bé les resistències. T'ha quedat algun dubte sobre l'exercici?",
  },
  en: {
    exactAnswer: "Correct. You gave the exact answer.",
    identifiedResistances: "Correct! You identified the resistances correctly. Do you have any remaining questions about the exercise?",
  },
};

function getFinishMessages(lang) {
  return finishMessages[lang] || finishMessages.es;
}

// =====================
// Multi-language pattern dictionaries
// =====================

const greetingPatterns = {
  es: ["hola", "buenos días", "buenas tardes", "buenas noches", "qué tal", "hey", "buenas"],
  val: ["hola", "bon dia", "bona vesprada", "bona nit", "què tal", "hey", "bones"],
  en: ["hello", "hi", "good morning", "good afternoon", "good evening", "hey", "howdy"],
};

const dontKnowPatterns = {
  es: ["no lo sé", "no sé", "ni idea", "no tengo ni idea", "no tengo idea", "yo qué sé"],
  val: ["no ho sé", "no sé", "ni idea", "no tinc ni idea", "no tinc idea"],
  en: ["i don't know", "no idea", "i have no idea", "no clue", "beats me"],
};

const reasoningPatterns = {
  es: ["dado que", "porque", "ya que", "debido a", "puesto que", "por eso", "por lo que"],
  val: ["perquè", "ja que", "atés que", "degut a", "per això", "pel que"],
  en: ["because", "since", "due to", "given that", "therefore", "that's why"],
};

const conceptKeywords = {
  es: [
    "divisor de tensión", "divisor de corriente",
    "serie", "paralelo",
    "cortocircuito", "cortocircuitada", "cortocircuitado", "corto",
    "circuito abierto", "abierto", "abierta",
    "se consume", "se gasta", "atenuación",
    "interruptor cerrado", "interruptor abierto",
  ],
  val: [
    "divisor de tensió", "divisor de corrent",
    "sèrie", "paral·lel",
    "curtcircuit", "curtcircuitada", "curtcircuitat", "curt",
    "circuit obert", "obert", "oberta",
    "es consumeix", "es gasta", "atenuació",
    "interruptor tancat", "interruptor obert",
  ],
  en: [
    "voltage divider", "current divider",
    "series", "parallel",
    "short circuit", "shorted", "short",
    "open circuit", "open",
    "consumed", "used up", "attenuation",
    "switch closed", "switch open",
  ],
};

// =====================
// Multi-language guardrail patterns
// =====================

const revealPhrases = {
  es: [
    "la respuesta es", "la respuesta correcta es", "las resistencias son",
    "las resistencias correctas son", "la solución es",
    "deberías responder", "la respuesta sería",
    "las resistencias por las que circula corriente son",
    "las resistencias por las que no circula corriente son",
    "la respuesta final es", "la solución correcta es",
    "son precisamente", "son exactamente",
    "las que contribuyen son", "las que influyen son",
    "depende de", "dependen de",
    "las resistencias que contribuyen", "las resistencias relevantes son",
    "las resistencias que afectan", "las resistencias correctas son",
    "la respuesta correcta sería",
  ],
  val: [
    "la resposta és", "la resposta correcta és", "les resistències són",
    "les resistències correctes són", "la solució és",
    "hauries de respondre", "la resposta seria",
    "les resistències per les quals circula corrent són",
    "les resistències per les quals no circula corrent són",
    "la resposta final és", "la solució correcta és",
    "són precisament", "són exactament",
    "les que contribueixen són", "les que influeixen són",
    "depén de", "depenen de",
    "les resistències que contribueixen", "les resistències rellevants són",
    "les resistències que afecten",
  ],
  en: [
    "the answer is", "the correct answer is", "the resistances are",
    "the correct resistances are", "the solution is",
    "you should answer", "the answer would be",
    "the resistances through which current flows are",
    "the resistances through which no current flows are",
    "the final answer is", "the correct solution is",
    "are precisely", "are exactly",
    "the ones that contribute are", "the relevant resistances are",
    "the resistances that affect", "the resistances that contribute",
  ],
};

const confirmPhrases = {
  es: [
    "perfecto", "correcto", "exacto", "exactamente", "muy bien",
    "eso es", "así es", "bien hecho", "en efecto", "efectivamente",
    "has identificado correctamente", "estás en lo correcto",
    "buena observación", "buen trabajo",
    // Soft confirmations that also validate wrong answers
    "interesante", "buena idea", "buen punto", "buen razonamiento",
    "tiene sentido", "tienes razón", "claro que sí", "por supuesto",
    "desde luego", "vas bien", "vas por buen camino", "bien pensado",
    "gran observación",
    // Phrases detected in real tutor responses
    "estás en el camino correcto", "en el camino correcto",
    "eso es correcto", "bien razonado", "buen análisis",
    "justo", "lo has entendido", "has comprendido",
  ],
  val: [
    "perfecte", "correcte", "exacte", "exactament", "molt bé",
    "això és", "així és", "ben fet", "en efecte", "efectivament",
    "has identificat correctament", "estàs en el correcte",
    "bona observació", "bon treball",
    "interessant", "bona idea", "bon punt", "bon raonament",
    "té sentit", "tens raó", "clar que sí", "per descomptat",
    "vas bé", "vas per bon camí", "ben pensat", "gran observació",
    "estàs en el camí correcte", "en el camí correcte",
    "això és correcte", "ben raonat", "bona anàlisi",
    "ho has entés", "has comprés",
  ],
  en: [
    "perfect", "correct", "exactly", "very good", "well done",
    "that's right", "that is right", "indeed", "good observation",
    "good job", "you correctly identified", "you are correct",
    "interesting", "good idea", "good point", "good thinking",
    "makes sense", "you're right", "of course", "nice thinking",
    "great observation", "great",
    "you're on the right track", "on the right track", "right track",
    "that is correct", "well reasoned", "good analysis",
    "you've got it", "you understand",
  ],
};

const stateRevealPatterns = {
  es: [
    "está cortocircuitad", "está en cortocircuito",
    "está en circuito abierto", "está en abierto",
    "está en serie", "está en paralelo",
    "no circula corriente por", "no pasa corriente por",
    "circula corriente por", "pasa corriente por",
    "tiene corriente cero", "tiene tensión cero",
    "tiene diferencia de potencial cero",
    "no tiene caída de tensión",
    "ambos terminales", "mismo nudo", "mismo punto",
  ],
  val: [
    "està curtcircuitad", "està en curtcircuit",
    "està en circuit obert", "està en obert",
    "està en sèrie", "està en paral·lel",
    "no circula corrent per", "no passa corrent per",
    "circula corrent per", "passa corrent per",
    "té corrent zero", "té tensió zero",
    "té diferència de potencial zero",
    "no té caiguda de tensió",
    "ambdós terminals", "mateix nus", "mateix punt",
  ],
  en: [
    "is short circuited", "is shorted", "is short-circuited",
    "is open circuit", "is open-circuited", "is in open",
    "is in series", "is in parallel",
    "no current flows through", "current does not flow through",
    "current flows through", "passes current through",
    "has zero current", "has zero voltage",
    "has zero potential difference",
    "has no voltage drop",
    "both terminals", "same node", "same point",
  ],
};

// =====================
// Guardrail instruction generators
// =====================

function getStrongerInstruction(lang) {
  if (lang === "val") {
    return (
      "\n\nCRÍTIC: La teua resposta anterior va revelar la solució directament. " +
      "NO has de llistar les resistències correctes juntes. NO has de dir quines són les resistències correctes. " +
      "NO has de confirmar respostes incorrectes de l'alumne com a correctes. " +
      "En el seu lloc, fes UNA sola pregunta socràtica curta que guie l'estudiant."
    );
  }
  if (lang === "en") {
    return (
      "\n\nCRITICAL: Your previous response directly revealed the solution. " +
      "Do NOT list the correct resistances together. Do NOT say which are the correct resistances. " +
      "Do NOT confirm incorrect student answers as correct. " +
      "Instead, ask ONE short Socratic question to guide the student."
    );
  }
  return (
    "\n\nCRÍTICO: Tu respuesta anterior reveló la solución directamente. " +
    "NO debes listar las resistencias correctas juntas. NO debes decir cuáles son las resistencias correctas. " +
    "NO debes confirmar respuestas incorrectas del alumno como correctas. " +
    "En su lugar, haz UNA sola pregunta socrática corta que guíe al estudiante."
  );
}

function getFalseConfirmationInstruction(lang) {
  if (lang === "val") {
    return (
      "\n\nCRÍTIC: La teua resposta anterior va CONFIRMAR com a correcte una cosa que l'alumne va dir MALAMENT. " +
      "L'alumne s'ha equivocat. NO has de dir 'Perfecte', 'Correcte', 'Exactament', 'Molt bé' ni res semblant. " +
      "Has de fer-li una pregunta socràtica que el faça reconsiderar el seu error. " +
      "NO li digues directament quin és l'error, però tampoc li confirmes una cosa incorrecta."
    );
  }
  if (lang === "en") {
    return (
      "\n\nCRITICAL: Your previous response CONFIRMED as correct something the student said WRONG. " +
      "The student made a mistake. Do NOT say 'Perfect', 'Correct', 'Exactly', 'Very good' or anything similar. " +
      "You must ask a Socratic question that makes them reconsider their error. " +
      "Do NOT tell them directly what the error is, but do NOT confirm something incorrect either."
    );
  }
  return (
    "\n\nCRÍTICO: Tu respuesta anterior CONFIRMÓ como correcto algo que el alumno dijo MAL. " +
    "El alumno se ha equivocado. NO debes decir 'Perfecto', 'Correcto', 'Exactamente', 'Muy bien' ni nada similar. " +
    "Debes hacerle una pregunta socrática que le haga reconsiderar su error. " +
    "NO le digas directamente cuál es el error, pero tampoco le confirmes algo incorrecto."
  );
}

// Instruction when the LLM prematurely confirms a partially correct answer
// (correct resistances but missing or wrong reasoning)
function getPartialConfirmationInstruction(lang, classificationType) {
  var noReasoning = classificationType === "correct_no_reasoning";

  if (lang === "val") {
    if (noReasoning) {
      return (
        "\n\nCRÍTIC: La teua resposta anterior va donar per bona la resposta de l'alumne SENSE que haja justificat el seu raonament. " +
        "L'alumne ha donat les resistències correctes, PERÒ encara no ha explicat PER QUÈ. " +
        "NO has de dir 'Perfecte', 'Correcte', 'Molt bé', 'Exacte' ni res que confirme que ha acabat. " +
        "Reconeix que va per bon camí i demana-li que explique el seu raonament amb conceptes de circuits."
      );
    }
    return (
      "\n\nCRÍTIC: La teua resposta anterior va confirmar com a correcte un raonament ERRONI de l'alumne. " +
      "L'alumne ha donat les resistències correctes, PERÒ el seu raonament conté una concepció alternativa. " +
      "NO has de dir 'Perfecte', 'Correcte', 'Molt bé' ni res que valide el seu raonament. " +
      "Reconeix que va encaminat però qüestiona el concepte erroni amb una pregunta socràtica."
    );
  }

  if (lang === "en") {
    if (noReasoning) {
      return (
        "\n\nCRITICAL: Your previous response confirmed the student's answer as correct WITHOUT them justifying their reasoning. " +
        "The student gave the correct resistances BUT has not explained WHY. " +
        "Do NOT say 'Perfect', 'Correct', 'Very good', 'Exactly' or anything that confirms completion. " +
        "Acknowledge they are on the right track and ask them to explain their reasoning using circuit concepts."
      );
    }
    return (
      "\n\nCRITICAL: Your previous response confirmed as correct something the student reasoned WRONGLY. " +
      "The student gave the correct resistances BUT their reasoning contains a misconception. " +
      "Do NOT say 'Perfect', 'Correct', 'Very good' or anything that validates their reasoning. " +
      "Acknowledge they are on the right track but challenge the incorrect concept with a Socratic question."
    );
  }

  // Default: Spanish
  if (noReasoning) {
    return (
      "\n\nCRÍTICO: Tu respuesta anterior dio por buena la respuesta del alumno SIN que haya justificado su razonamiento. " +
      "El alumno ha dado las resistencias correctas, PERO aún no ha explicado POR QUÉ. " +
      "NO debes decir 'Perfecto', 'Correcto', 'Muy bien', 'Exacto' ni nada que confirme que ha terminado. " +
      "Reconoce que va por buen camino y pídele que explique su razonamiento con conceptos de circuitos."
    );
  }
  return (
    "\n\nCRÍTICO: Tu respuesta anterior confirmó como correcto un razonamiento ERRÓNEO del alumno. " +
    "El alumno ha dado las resistencias correctas, PERO su razonamiento contiene una concepción alternativa. " +
    "NO debes decir 'Perfecto', 'Correcto', 'Muy bien' ni nada que valide su razonamiento. " +
    "Reconoce que va encaminado pero cuestiona el concepto erróneo con una pregunta socrática."
  );
}

function getStateRevealInstruction(lang) {
  if (lang === "val") {
    return (
      "\n\nCRÍTIC: La teua resposta anterior va REVELAR l'estat d'una resistència directament (curtcircuitada, obert, etc.). " +
      "Eixa informació és INTERNA i l'alumne ha de descobrir-la per si mateix. " +
      "NO digues l'estat de cap resistència. En el seu lloc, fes una pregunta socràtica que guie l'alumne " +
      "a analitzar el circuit i descobrir l'estat per si mateix. " +
      "Per exemple: 'Què observes en els nusos on està connectada eixa resistència?'"
    );
  }
  if (lang === "en") {
    return (
      "\n\nCRITICAL: Your previous response REVEALED the state of a resistance directly (short-circuited, open, etc.). " +
      "That information is INTERNAL and the student must discover it on their own. " +
      "Do NOT state the condition of any resistance. Instead, ask a Socratic question that guides the student " +
      "to analyze the circuit and discover the state themselves. " +
      "For example: 'What do you notice about the nodes where that resistance is connected?'"
    );
  }
  return (
    "\n\nCRÍTICO: Tu respuesta anterior REVELÓ el estado de una resistencia directamente (cortocircuitada, abierto, etc.). " +
    "Esa información es INTERNA y el alumno debe descubrirla por sí mismo. " +
    "NO digas el estado de ninguna resistencia. En su lugar, haz una pregunta socrática que guíe al alumno " +
    "a analizar el circuito y descubrir el estado por sí mismo. " +
    "Por ejemplo: '¿Qué observas en los nudos donde está conectada esa resistencia?'"
  );
}

// =====================
// Intermediate feedback phrases (hybrid: deterministic prefix + LLM continuation)
// =====================

const intermediateFeedback = {
  wrong: {
    es: [
      "No del todo. Vamos a pensarlo de otra manera.",
      "Hay conceptos que debemos revisar.",
      "No es del todo correcto. Pensemos en esto desde otra perspectiva.",
      "No es exactamente así. Vamos a repasar algo importante.",
      "Cuidado, hay un error en ese razonamiento.",
      "No acaba de ser correcto. Vamos a verlo de otra forma.",
      "Hay algo que no encaja. Vamos a revisarlo juntos.",
      "Eso no es del todo preciso. Pensemos un momento.",
    ],
    val: [
      "No del tot. Pensem-ho d'una altra manera.",
      "Hi ha conceptes que hem de revisar.",
      "No és del tot correcte. Pensem en això des d'una altra perspectiva.",
      "No és exactament així. Repassem una cosa important.",
      "Compte, hi ha un error en eixe raonament.",
      "No acaba de ser correcte. Vegem-ho d'una altra forma.",
      "Hi ha alguna cosa que no encaixa. Revisem-ho junts.",
      "Això no és del tot precís. Pensem un moment.",
    ],
    en: [
      "Not quite. Let's think about this differently.",
      "There are some concepts we need to review.",
      "That's not entirely correct. Let's look at this from another angle.",
      "That's not exactly right. Let's go over something important.",
      "Careful, there's an error in that reasoning.",
      "That doesn't quite work. Let's look at it another way.",
      "Something doesn't add up. Let's review it together.",
      "That's not entirely accurate. Let's think for a moment.",
    ],
  },
  partial: {
    es: [
      "Vas por buen camino, pero hay que pulir algunos conceptos.",
      "Casi. Hay algo que debemos revisar antes de continuar.",
      "Estás avanzando, pero falta justificar tu razonamiento.",
      "Bien encaminado, aunque falta completar la respuesta.",
      "Estás cerca. Piensa en qué más podría influir.",
      "Buen comienzo, pero necesitamos ir un poco más allá.",
      "Parte de tu respuesta es correcta, pero falta algo.",
    ],
    val: [
      "Vas per bon camí, però cal polir alguns conceptes.",
      "Quasi. Hi ha alguna cosa que hem de revisar abans de continuar.",
      "Estàs avançant, però falta justificar el teu raonament.",
      "Ben encaminat, encara que falta completar la resposta.",
      "Estàs a prop. Pensa en què més podria influir.",
      "Bon començament, però necessitem anar un poc més enllà.",
      "Part de la teua resposta és correcta, però falta alguna cosa.",
    ],
    en: [
      "You're on the right track, but we need to refine some concepts.",
      "Almost. There's something we need to review before continuing.",
      "You're making progress, but you need to justify your reasoning.",
      "Good start, but the answer isn't complete yet.",
      "You're close. Think about what else might play a role.",
      "Nice beginning, but we need to go a bit further.",
      "Part of your answer is correct, but something is missing.",
    ],
  },
};

function getIntermediateFeedback(type, lang) {
  lang = lang || "es";
  var phrases = intermediateFeedback[type];
  if (!phrases) return [];
  return phrases[lang] || phrases.es || [];
}

function getRandomIntermediatePhrase(type, lang) {
  var phrases = getIntermediateFeedback(type, lang);
  if (phrases.length === 0) return "";
  return phrases[Math.floor(Math.random() * phrases.length)];
}

// =====================
// Element naming guardrail instruction (generic, not resistance-specific)
// =====================

function getElementNamingInstruction(lang) {
  if (lang === "val") {
    return (
      "\n\nCRÍTIC: La teua resposta anterior NOMENA un element concret en una pregunta o directiva. " +
      "MAI has de senyalar un element específic perquè l'alumne l'analitze (ex: '¿Què passa amb R5?', 'Observa R3'). " +
      "En el seu lloc, fes preguntes sobre CONCEPTES generals: el recorregut del corrent, " +
      "quines condicions es necessiten perquè circule corrent per una branca, etc."
    );
  }
  if (lang === "en") {
    return (
      "\n\nCRITICAL: Your previous response NAMES a specific element in a question or directive. " +
      "NEVER point to a specific element for the student to analyze (e.g., 'What about R5?', 'Look at R3'). " +
      "Instead, ask questions about general CONCEPTS: the path of current, " +
      "what conditions are needed for current to flow through a branch, etc."
    );
  }
  return (
    "\n\nCRÍTICO: Tu respuesta anterior NOMBRA un elemento concreto en una pregunta o directiva. " +
    "NUNCA debes señalar un elemento específico para que el alumno lo analice (ej: '¿Qué pasa con R5?', 'Observa R3'). " +
    "En su lugar, haz preguntas sobre CONCEPTOS generales: el recorrido de la corriente, " +
    "qué condiciones se necesitan para que circule corriente por una rama, etc."
  );
}

// =====================
// Term normalization for retrieval
// =====================

const termToSpanish = {
  // Valencian → Spanish
  "curtcircuit": "cortocircuito",
  "curtcircuitada": "cortocircuitada",
  "curtcircuitat": "cortocircuitado",
  "circuit obert": "circuito abierto",
  "divisor de tensió": "divisor de tensión",
  "divisor de corrent": "divisor de corriente",
  "sèrie": "serie",
  "paral·lel": "paralelo",
  "corrent": "corriente",
  "tensió": "tensión",
  "resistència": "resistencia",
  "interruptor tancat": "interruptor cerrado",
  "interruptor obert": "interruptor abierto",
  // English → Spanish
  "short circuit": "cortocircuito",
  "shorted": "cortocircuitada",
  "open circuit": "circuito abierto",
  "voltage divider": "divisor de tensión",
  "current divider": "divisor de corriente",
  "series": "serie",
  "parallel": "paralelo",
  "current": "corriente",
  "voltage": "tensión",
  "resistance": "resistencia",
  "switch closed": "interruptor cerrado",
  "switch open": "interruptor abierto",
};

// Normalize non-Spanish technical terms to Spanish for dataset retrieval
function normalizeToSpanish(query) {
  if (typeof query !== "string") return query;
  let result = query.toLowerCase();

  // Sort keys by length (longest first) to avoid partial replacements
  const keys = Object.keys(termToSpanish).sort(function (a, b) {
    return b.length - a.length;
  });

  for (let i = 0; i < keys.length; i++) {
    if (result.includes(keys[i])) {
      result = result.replace(new RegExp(keys[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), termToSpanish[keys[i]]);
    }
  }
  return result;
}

// =====================
// Utility: flatten all language arrays into one
// =====================

function getAllPatterns(dict) {
  const result = [];
  for (const lang of SUPPORTED_LANGS) {
    if (Array.isArray(dict[lang])) {
      for (let i = 0; i < dict[lang].length; i++) {
        result.push(dict[lang][i]);
      }
    }
  }
  // Deduplicate
  const seen = {};
  const unique = [];
  for (let i = 0; i < result.length; i++) {
    if (!seen[result[i]]) {
      seen[result[i]] = true;
      unique.push(result[i]);
    }
  }
  return unique;
}

module.exports = {
  SUPPORTED_LANGS,
  DEFAULT_LANG,
  detectLanguageSwitch,
  resolveLanguage,
  getLanguageRules,
  getFinishMessages,
  getStrongerInstruction,
  getFalseConfirmationInstruction,
  getPartialConfirmationInstruction,
  getStateRevealInstruction,
  getElementNamingInstruction,
  getIntermediateFeedback,
  getRandomIntermediatePhrase,
  normalizeToSpanish,
  getAllPatterns,
  greetingPatterns,
  dontKnowPatterns,
  reasoningPatterns,
  conceptKeywords,
  revealPhrases,
  confirmPhrases,
  stateRevealPatterns,
};
