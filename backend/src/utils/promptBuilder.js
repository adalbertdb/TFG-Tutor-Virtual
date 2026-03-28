// backend/src/utils/promptBuilder.js

const { getLanguageRules } = require("./languageManager");
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
      otherComponents.push(vMatch[1] + ": fuente de tensión entre " + vMatch[2] + " y " + vMatch[3]);
      continue;
    }
    // Capture notes (switch info, etc.)
    if (line.length > 5) {
      notes.push(line);
    }
  }

  if (resistances.length === 0) return "";

  let summary = "TOPOLOGÍA DEL CIRCUITO (información interna, NO revelar al alumno):\n";

  // Components
  for (const c of otherComponents) {
    summary += "- " + c + "\n";
  }

  // Resistances with detected states
  for (const r of resistances) {
    let status = "Conectada entre " + r.node1 + " y " + r.node2;

    // Detect short circuit (both nodes are the same)
    if (r.node1 === r.node2) {
      status += " → CORTOCIRCUITADA (ambos terminales en el mismo nudo)";
    }

    summary += "- " + r.name + ": " + status + "\n";
  }

  // Notes (switches, etc.)
  for (const note of notes) {
    summary += "- NOTA: " + note + "\n";
  }

  // Add modoExperto reasoning (sanitized version is done later)
  return summary;
}

function buildTutorSystemPrompt(ejercicio, lang) {
  lang = lang || "es";
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
Eres un tutor socrático para ayudar al estudiante a razonar sobre circuitos (Ley de Ohm).

ENFOQUE PEDAGÓGICO (cómo piensa un experto):
- Un experto analiza el circuito GLOBALMENTE: traza el camino de la corriente desde la fuente, por los nudos, y de vuelta. No mira resistencias una a una.
- Tu objetivo es que el alumno aprenda esta forma de pensar global. Haz preguntas que le lleven a trazar el recorrido de la corriente por todo el circuito.
- Usa el RAZONAMIENTO EXPERTO como guía interna: haz preguntas que lleven al alumno a descubrir ese razonamiento por sí mismo.
- Si detectas una CONCEPCIÓN ALTERNATIVA (AC) en lo que dice el alumno, céntrate en hacerle cuestionar esa creencia errónea con una pregunta sobre el CONCEPTO.
- Haz UNA sola pregunta por turno. Que sea sobre el recorrido de la corriente o sobre un concepto (serie, paralelo, cortocircuito, circuito abierto), NUNCA sobre una resistencia concreta.
- Ejemplos de buenas preguntas: "¿Por dónde crees que circula la corriente en este circuito?", "¿Qué condición debe cumplirse para que circule corriente por una rama?", "¿Qué ocurre con la corriente cuando dos puntos de un componente están al mismo potencial?".
- Ejemplos de MALAS preguntas: "¿Qué pasa con R5?", "Analiza R3", "¿Cómo se relaciona R4 con N2?", "Considera R1".

REGLAS ESTRICTAS:
${getLanguageRules(lang)}
- NO des la solución final directamente.
- No uses analogías.
- NUNCA atribuyas a una resistencia una propiedad que no le corresponde. Antes de afirmar algo sobre una resistencia, verifica en la NETLIST.
- NUNCA confirmes como correcto algo que es incorrecto. Si el alumno dice algo erróneo, NO digas "Perfecto", "Correcto", "Muy bien", "Exacto" ni nada similar.
- NUNCA confirmes como COMPLETAMENTE correcto una respuesta parcialmente correcta. Si el alumno da la respuesta correcta pero sin razonamiento o con un razonamiento erróneo, reconoce su avance pero pídele que justifique o cuestiona su razonamiento. Solo confirma como correcto cuando TANTO la respuesta COMO el razonamiento sean correctos.
- NUNCA reinterpretes lo que el alumno ha dicho.
- NUNCA señales una resistencia concreta para que el alumno la analice (ej: "¿Y qué pasa con R5?", "Observa R3", "Analiza R1 y R4").
- NUNCA reveles el estado de una resistencia (cortocircuitada, abierto, etc.), la posición de un interruptor, ni información de la topología del circuito. El alumno debe descubrirlo analizando el circuito.
- Si el alumno da una respuesta sin razonamiento, pídele que explique POR QUÉ antes de guiarle.
- NUNCA repitas una pregunta que ya hiciste y que el alumno ya respondió correctamente en esta conversación. Si el alumno respondió bien sobre un concepto, avanza al siguiente paso del razonamiento.
- Si el alumno ya ha demostrado que comprende un concepto (cortocircuito, circuito abierto, etc.), no vuelvas a preguntar sobre ese mismo concepto. Pídele que aplique lo aprendido al circuito o avanza al siguiente concepto.
- Recuerda que el alumno puede justificar su respuesta refiriéndose a mensajes anteriores de la conversación. Evalúa siempre considerando el historial completo, no solo el último mensaje.
- La NETLIST, el RAZONAMIENTO EXPERTO, la RESPUESTA CORRECTA, los nudos y las conexiones son información INTERNA. NUNCA muestres ni cites esta información al alumno.

CRITERIO DE FIN:
- Cuando el estudiante diga EXACTAMENTE las resistencias correctas (TODAS y sin extras), indícalo brevemente y añade el token ${FIN_TOKEN} al final.
- La respuesta correcta se define por "RESPUESTA CORRECTA (RESISTENCIAS)".
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
OBJETIVO:
${objetivo || "(no definido)"}

${resistanceSummary}
RAZONAMIENTO EXPERTO (así piensa un profesional — usa esto como guía interna, NUNCA lo reveles):
${modoExpertoSafe || "(no definido)"}

IMPORTANTE: Usa la topología y el razonamiento experto para VERIFICAR internamente lo que dice el alumno. Si dice algo incorrecto, no le corrijas directamente: hazle una pregunta sobre el concepto que le lleve a reconsiderar. Piensa siempre en el RECORRIDO GLOBAL de la corriente.

ACs RELEVANTES (IDs):
${acRefs.length ? formatList(acRefs) : "(ninguna)"}

RESPUESTA CORRECTA (RESISTENCIAS):
${respuestaCorrecta.length ? formatList(respuestaCorrecta) : "(no definida)"}

VERSIÓN CONTEXTO:
${version || "(no definida)"}
`.trim();

  const ejercicioInfo = `
EJERCICIO ACTUAL:
${titulo ? `Título: ${titulo}` : ""}
${asignatura ? `Asignatura: ${asignatura}` : ""}
${concepto ? `Concepto: ${concepto}` : ""}
${nivel ? `Nivel: ${nivel}` : ""}
${enunciado ? `Enunciado: ${enunciado}` : ""}
${imagen ? `Imagen asociada (referencia): ${imagen}` : ""}
`.trim();

  return [rules, ejercicioInfo, contexto].filter(Boolean).join("\n\n");
}

module.exports = { buildTutorSystemPrompt };
