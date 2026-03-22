// Test: language detection with tinyld + SHORT_LANG_MAP + getLanguageInstruction
const { detect } = require("tinyld");
const { getLanguageInstruction } = require("../src/utils/promptBuilder");

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log("  PASS: " + label);
    passed++;
  } else {
    console.log("  FAIL: " + label);
    failed++;
  }
}

function expectLang(text, expectedLang) {
  const instr = getLanguageInstruction(text);
  const match = instr.match(/writing in (\w+)/);
  const detected = match ? match[1] : "(none)";
  assert(JSON.stringify(text) + " -> " + detected, detected === expectedLang);
}

// ========================================
// Phase 1: Short texts (where tinyld alone fails)
// ========================================
console.log("\n=== Phase 1: Short text detection (curated map) ===\n");

// These are the EXACT inputs that tinyld gets wrong:
expectLang("Hello", "English");     // tinyld says "it" → WRONG
expectLang("Hi", "English");        // tinyld returns "" → WRONG
expectLang("Hey", "English");
expectLang("Yes", "English");       // tinyld says "ber" → WRONG
expectLang("Of course", "English");
expectLang("Ok", "English");        // tinyld returns "" → WRONG
expectLang("Okay", "English");
expectLang("Sure", "English");
expectLang("I think", "English");
expectLang("I don't know", "English");

expectLang("Bonjour", "French");
expectLang("Salut", "French");      // tinyld returns "" → WRONG
expectLang("Oui", "French");        // tinyld says "pt" → WRONG
expectLang("Merci", "French");
expectLang("D'accord", "French");

expectLang("Hola", "Spanish");      // tinyld returns "" → WRONG
expectLang("Sí", "Spanish");
expectLang("Gracias", "Spanish");
expectLang("Vale", "Spanish");
expectLang("Bueno", "Spanish");

expectLang("Hallo", "German");
expectLang("Guten Tag", "German");  // tinyld says "rn" → WRONG
expectLang("Ja", "German");
expectLang("Danke", "German");

expectLang("Ciao", "Italian");      // tinyld returns "" → WRONG
expectLang("Grazie", "Italian");
expectLang("Buongiorno", "Italian");

expectLang("Olá", "Portuguese");    // tinyld says "tr" → WRONG
expectLang("Obrigado", "Portuguese");
expectLang("Bom dia", "Portuguese");

expectLang("Bon dia", "Catalan");
expectLang("Gràcies", "Catalan");

// ========================================
// Phase 2: Typos and missing accents/apostrophes
// ========================================
console.log("\n=== Phase 2: Typo resilience (normalized map) ===\n");

expectLang("i dont know", "English");   // no apostrophe
expectLang("dont know", "English");
expectLang("no idea", "English");       // tinyld returns "" for this
expectLang("ola", "Portuguese");        // no accent on "olá"
expectLang("daccord", "French");        // no apostrophe on "d'accord"
expectLang("tres bien", "French");      // no accent on "très"
expectLang("naturlich", "German");      // no umlaut on "natürlich"
expectLang("perche", "Italian");        // no accent on "perché"
expectLang("como", "Spanish");          // no accent on "cómo"
expectLang("gracies", "Catalan");       // no accent on "gràcies"

// ========================================
// Phase 3: Longer texts (tinyld works fine)
// ========================================
console.log("\n=== Phase 2: Longer text detection (tinyld) ===\n");

expectLang("I want to start the exercise. Can you guide me step by step?", "English");
expectLang("Je voudrais commencer l'exercice. Pouvez-vous m'expliquer?", "French");
expectLang("Quiero empezar el ejercicio. Guíame paso a paso.", "Spanish");
expectLang("Ich möchte die Übung beginnen. Können Sie mir helfen?", "German");
expectLang("Voglio iniziare l'esercizio. Puoi guidarmi passo dopo passo?", "Italian");
expectLang("Quero começar o exercício. Pode me guiar passo a passo?", "Portuguese");

// ========================================
// Phase 3: Edge cases
// ========================================
console.log("\n=== Phase 4: Edge cases ===\n");

assert("Empty string -> empty", getLanguageInstruction("") === "");
assert("null -> empty", getLanguageInstruction(null) === "");
assert("Single char -> empty", getLanguageInstruction("a") === "");
assert("Format contains [LANGUAGE INSTRUCTION]", getLanguageInstruction("Bonjour").includes("[LANGUAGE INSTRUCTION]"));
assert("Format contains MUST respond ONLY", getLanguageInstruction("Bonjour").includes("MUST respond ONLY"));

// ========================================
// Summary
// ========================================
console.log("\n=== Results ===");
console.log("Passed: " + passed + "/" + (passed + failed));
console.log("Failed: " + failed);

if (failed > 0) {
  process.exit(1);
}
