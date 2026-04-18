"use strict";

class ErrorEntry {
  /**
   * Value object for an Alternative Conception (AC) error detected in a student's interaction.
   * Replaces the embedded errores[] array in MongoDB's Resultado.
   *
   * @param {object} props
   * @param {string} [props.id]
   * @param {string}  props.etiqueta  - AC identifier (e.g. "AC13", "AC_UNK")
   * @param {string}  props.texto     - Human-readable error description
   */
  constructor(props) {
    this.id = props.id || null;
    this.etiqueta = props.etiqueta;
    this.texto = props.texto;
  }
}

module.exports = ErrorEntry;
