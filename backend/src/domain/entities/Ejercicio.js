"use strict";

const TutorContext = require("./TutorContext");

class Ejercicio {
  /**
   * @param {object} props
   * @param {string}  props.id
   * @param {string}  props.titulo
   * @param {string}  props.enunciado
   * @param {string} [props.imagen]
   * @param {string}  props.asignatura
   * @param {string}  props.concepto
   * @param {number}  props.nivel
   * @param {string} [props.ca]
   * @param {object} [props.tutorContext]
   * @param {Date}   [props.createdAt]
   * @param {Date}   [props.updatedAt]
   */
  constructor(props) {
    this.id = props.id;
    this.titulo = props.titulo;
    this.enunciado = props.enunciado;
    this.imagen = props.imagen || "";
    this.asignatura = props.asignatura;
    this.concepto = props.concepto;
    this.nivel = props.nivel;
    this.ca = props.ca || "";
    this.tutorContext = props.tutorContext
      ? new TutorContext(props.tutorContext)
      : null;
    this.createdAt = props.createdAt || new Date();
    this.updatedAt = props.updatedAt || new Date();
  }

  getCorrectAnswer() {
    return this.tutorContext?.respuestaCorrecta || [];
  }

  getEvaluableElements() {
    return this.tutorContext?.elementosEvaluables || [];
  }

  getExerciseNumber() {
    const match = this.titulo?.match(/\d+/);
    return match ? parseInt(match[0], 10) : null;
  }

  hasValidTutorContext() {
    return (
      this.tutorContext !== null && this.getCorrectAnswer().length > 0
    );
  }

  /**
   * JSON shape compatible with the legacy Mongo API consumed by the frontend.
   * Emits `_id`, and keeps `tutorContext` in camelCase (matches frontend usage).
   */
  toJSON() {
    return {
      _id: this.id,
      id: this.id,
      titulo: this.titulo,
      enunciado: this.enunciado,
      imagen: this.imagen,
      asignatura: this.asignatura,
      concepto: this.concepto,
      nivel: this.nivel,
      CA: this.ca,
      tutorContext: this.tutorContext,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

module.exports = Ejercicio;
