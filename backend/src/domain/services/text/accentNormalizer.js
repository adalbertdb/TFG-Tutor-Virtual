"use strict";

// Accent-insensitive string normalization.
// Used by classifier (match student input without accents) AND by guardrails
// (match LLM output without accents). Single source of truth.

/**
 * Strip diacritical marks from a string using NFD normalization.
 * "tensión" → "tension", "perfécto" → "perfecto"
 *
 * Safe on non-string inputs (returns empty string).
 */
function stripAccents(str) {
  if (typeof str !== "string") return "";
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

module.exports = { stripAccents };
