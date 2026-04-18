"use strict";

class TutorContext {
  /**
   * Value object representing the pedagogical context of an exercise.
   * @param {object} props
   * @param {string}   [props.objetivo]
   * @param {string}   [props.netlist]
   * @param {string}   [props.modoExperto]
   * @param {string[]} [props.ac_refs]
   * @param {string[]} [props.respuestaCorrecta]
   * @param {string[]} [props.elementosEvaluables]
   * @param {number}   [props.version]
   */
  constructor(props) {
    this.objetivo = props.objetivo || "";
    this.netlist = props.netlist || "";
    this.modoExperto = props.modoExperto || "";
    this.ac_refs = props.ac_refs || [];
    this.respuestaCorrecta = props.respuestaCorrecta || [];
    this.elementosEvaluables = props.elementosEvaluables || [];
    this.version = props.version || 1;
  }
}

module.exports = TutorContext;
