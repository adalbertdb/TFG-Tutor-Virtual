const fs = require("fs");
const config = require("../llm/config");

let kgEntries = []; // In-memory knowledge graph (loaded once at startup)

// Load the knowledge graph JSON file into memory
function loadKG() {
  var raw = fs.readFileSync(config.KG_PATH, "utf-8").trim();

  // Handle files that contain comma-separated objects without enclosing []
  if (raw.charAt(0) !== "[") {
    raw = "[" + raw + "]";
  }

  // Remove trailing comma before closing bracket if present
  raw = raw.replace(/,\s*\]$/, "]");

  kgEntries = JSON.parse(raw);
  console.log("Knowledge graph loaded: " + kgEntries.length + " entries");
}

// Search KG entries by concept keywords -> Returns entries where Node1, Node2 or Relation match
function searchKG(concepts) {
  if (concepts.length === 0) {
    return [];
  }

  const results = [];
  for (let i = 0; i < kgEntries.length; i++) {
    const entry = kgEntries[i];
    const text = (entry.Node1 + " " + entry.Relation + " " + entry.Node2).toLowerCase();

    for (let j = 0; j < concepts.length; j++) {
      if (text.includes(concepts[j].toLowerCase())) {
        results.push({
          enlace: entry.Enlace,
          node1: entry.Node1,
          relation: entry.Relation,
          node2: entry.Node2,
          expertReasoning: entry["Expert reasoning"],
          ac: entry.AC || "",
          acName: entry["AC name"] || "",
          acDescription: entry.Description || "",
          socraticQuestions: entry["Socratic Tutoring "] || "",
        });
        break; // avoids duplicates if entry matches multiple concepts
      }
    }
  }
  return results;
}

// Get all KG entries (for ingestion into ChromaDB)
function getAllEntries() {
  return kgEntries;
}

module.exports = { loadKG, searchKG, getAllEntries };
