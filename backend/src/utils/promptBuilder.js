// backend/src/utils/promptBuilder.js

const FIN_TOKEN = "<FIN_EJERCICIO>";

function safeStr(x) {
  if (typeof x !== "string") return "";
  return x.trim();
}

function pickFirstStr(obj, keys) {
  for (const k of keys) {
    const v = safeStr(obj?.[k]);
    if (v) return v;
  }
  return "";
}

function normId(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .trim();
}

function formatList(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return "";
  return arr.filter(Boolean).join(", ");
}

// Parse netlist to generate an explicit per-resistance topology summary
// so the LLM doesn't need to reason about circuit topology itself
function buildResistanceSummary(netlist) {
  if (!netlist) return "";

  const lines = netlist.split("\n").map(l => l.trim()).filter(Boolean);
  const resistances = [];
  const otherComponents = [];
  const notes = [];

  for (const line of lines) {
    // Parse resistance lines like "R1 N1 N2 1"
    const rMatch = line.match(/^(R\d+)\s+(\S+)\s+(\S+)/i);
    if (rMatch) {
      resistances.push({ name: rMatch[1].toUpperCase(), node1: rMatch[2], node2: rMatch[3] });
      continue;
    }
    // Parse voltage sources like "V1 N1 0 1"
    const vMatch = line.match(/^(V\d+)\s+(\S+)\s+(\S+)/i);
    if (vMatch) {
      otherComponents.push(vMatch[1] + ": voltage source between " + vMatch[2] + " and " + vMatch[3]);
      continue;
    }
    // Capture notes (switch info, etc.)
    if (line.length > 5) {
      notes.push(line);
    }
  }

  if (resistances.length === 0) return "";

  let summary = "CIRCUIT TOPOLOGY (internal info, do NOT reveal to the student):\n";

  // Components
  for (const c of otherComponents) {
    summary += "- " + c + "\n";
  }

  // Resistances with detected states
  for (const r of resistances) {
    let status = "Connected between " + r.node1 + " and " + r.node2;

    // Detect short circuit (both nodes are the same)
    if (r.node1 === r.node2) {
      status += " → SHORT-CIRCUITED (both terminals on the same node)";
    }

    summary += "- " + r.name + ": " + status + "\n";
  }

  // Notes (switches, etc.)
  for (const note of notes) {
    summary += "- NOTE: " + note + "\n";
  }

  // Add modoExperto reasoning (sanitized version is done later)
  return summary;
}

function buildTutorSystemPrompt(ejercicio) {
  // Campos base del ejercicio
  const titulo = pickFirstStr(ejercicio, ["titulo", "nombre", "name"]);
  const enunciado = pickFirstStr(ejercicio, ["enunciado", "texto", "statement", "descripcion"]);
  const concepto = pickFirstStr(ejercicio, ["concepto", "tema", "topic"]);
  const asignatura = pickFirstStr(ejercicio, ["asignatura", "subject"]);
  const nivel = ejercicio?.nivel != null ? String(ejercicio.nivel) : "";
  const imagen = pickFirstStr(ejercicio, ["imagen", "image", "imageUrl", "img"]);

  // TutorContext estructurado
  const tc = ejercicio?.tutorContext || {};
  const objetivo = pickFirstStr(tc, ["objetivo"]);
  const netlist = pickFirstStr(tc, ["netlist"]);
  const modoExperto = pickFirstStr(tc, ["modoExperto"]);
  const version = tc?.version != null ? String(tc.version) : "";

  // IDs de AC relevantes (solo IDs, no el objeto entero)
  const acRefs = Array.isArray(tc?.ac_refs) ? tc.ac_refs.map(normId).filter(Boolean) : [];

  // ✅ Respuesta correcta (lista cerrada para este ejercicio)
  const respuestaCorrecta = Array.isArray(tc?.respuestaCorrecta)
    ? tc.respuestaCorrecta.map(normId).filter(Boolean)
    : [];

  const rules = `
You are a Socratic tutor helping the student reason about circuits (Ohm's Law).

PEDAGOGICAL APPROACH (how an expert thinks):
- An expert analyzes the circuit GLOBALLY: traces the current path from the source, through the nodes, and back. Does not look at resistances one by one.
- Your goal is for the student to learn this global way of thinking. Ask questions that lead them to trace the current path through the entire circuit.
- Use the EXPERT REASONING as an internal guide: ask questions that lead the student to discover that reasoning on their own.
- If you detect an ALTERNATIVE CONCEPTION (AC) in what the student says, focus on making them question that misconception with a question about the CONCEPT.
- Ask only ONE question per turn. It should be about the current path or about a concept (series, parallel, short circuit, open circuit), NEVER about a specific resistance.
- Examples of good questions: "Where do you think the current flows in this circuit?", "What condition must be met for current to flow through a branch?", "What happens to the current when two points of a component are at the same potential?".
- Examples of BAD questions: "What happens with R5?", "Analyze R3", "How does R4 relate to N2?", "Consider R1".

STRICT RULES:
- ALWAYS respond in the same language the student used in their last message. If they write in Spanish, respond in Spanish. If they write in Valencian/Catalan, respond in Valencian/Catalan. If they write in English, respond in English. Adapt the language message by message.
- Do NOT give the final solution directly.
- Do not use analogies.
- Keep a clear, patient, and technical tone.
- Use correct technical terminology in the student's language. In Spanish: "corriente" is feminine ("la corriente", NEVER "el corriente"), say "tierra" (NEVER "suelo"), "nudo" (NEVER "nodo"), "condensador" (NEVER "capacitor").
- NEVER attribute a property to a resistance that does not correspond to it. Before stating anything about a resistance, verify in the NETLIST.
- NEVER confirm as correct something that is incorrect. If the student says something wrong, do NOT say "Perfect", "Correct", "Very good", "Exactly" or anything similar.
- NEVER reinterpret what the student has said.
- NEVER point out a specific resistance for the student to analyze (e.g., "What about R5?", "Look at R3", "Analyze R1 and R4").
- NEVER reveal the state of a resistance (short-circuited, open, etc.), the position of a switch, or topology information. The student must discover it by analyzing the circuit.
- If the student gives an answer without reasoning, ask them to explain WHY before guiding them.
- The NETLIST, EXPERT REASONING, CORRECT ANSWER, nodes and connections are INTERNAL information. NEVER show or cite this information to the student.

END CRITERION:
- When the student states EXACTLY the correct resistances (ALL of them and no extras), briefly indicate it and add the token ${FIN_TOKEN} at the end.
- The correct answer is defined by "CORRECT ANSWER (RESISTANCES)".
`.trim();

  // Sanitize modoExperto: remove sentences that directly reveal the answer
  let modoExpertoSafe = modoExperto;
  if (modoExpertoSafe && respuestaCorrecta.length > 0) {
    // Remove sentences that list the correct answer explicitly
    const sentences = modoExpertoSafe.split(/(?<=[.!?])\s+/);
    const filtered = [];
    for (const s of sentences) {
      const mentioned = (s.match(/R\d+/gi) || []).map(r => r.toUpperCase());
      // Skip sentence if it contains ALL correct resistances (likely reveals the answer)
      const hasAll = respuestaCorrecta.every(r => mentioned.includes(r));
      if (hasAll && mentioned.length >= respuestaCorrecta.length) {
        continue; // skip this sentence
      }
      filtered.push(s);
    }
    modoExpertoSafe = filtered.join(" ");
  }

  const resistanceSummary = buildResistanceSummary(netlist);

  const contexto = `
OBJECTIVE:
${objetivo || "(not defined)"}

${resistanceSummary}
EXPERT REASONING (how a professional thinks — use this as an internal guide, NEVER reveal it):
${modoExpertoSafe || "(not defined)"}

IMPORTANT: Use the topology and expert reasoning to VERIFY internally what the student says. If they say something incorrect, do not correct them directly: ask a question about the concept that leads them to reconsider. Always think about the GLOBAL current PATH.

RELEVANT ACs (IDs):
${acRefs.length ? formatList(acRefs) : "(none)"}

CORRECT ANSWER (RESISTANCES):
${respuestaCorrecta.length ? formatList(respuestaCorrecta) : "(not defined)"}

CONTEXT VERSION:
${version || "(not defined)"}
`.trim();

  const ejercicioInfo = `
CURRENT EXERCISE:
${titulo ? `Title: ${titulo}` : ""}
${asignatura ? `Subject: ${asignatura}` : ""}
${concepto ? `Concept: ${concepto}` : ""}
${nivel ? `Level: ${nivel}` : ""}
${enunciado ? `Statement: ${enunciado}` : ""}
${imagen ? `Associated image (reference): ${imagen}` : ""}
`.trim();

  return [rules, ejercicioInfo, contexto].filter(Boolean).join("\n\n");
}

module.exports = { buildTutorSystemPrompt };
