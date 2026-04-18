"use strict";

class Usuario {
  /**
   * @param {object} props
   * @param {string}   props.id
   * @param {string}   props.upvLogin
   * @param {string}  [props.email]
   * @param {string}  [props.nombre]
   * @param {string}  [props.apellidos]
   * @param {string}  [props.dni]
   * @param {string[]} [props.grupos]
   * @param {string}  [props.rol]
   * @param {Date}    [props.lastLoginAt]
   * @param {Date}    [props.createdAt]
   * @param {Date}    [props.updatedAt]
   */
  constructor(props) {
    this.id = props.id;
    this.upvLogin = props.upvLogin;
    this.email = props.email || "";
    this.nombre = props.nombre || "";
    this.apellidos = props.apellidos || "";
    this.dni = props.dni || "";
    this.grupos = props.grupos || [];
    this.rol = props.rol || "alumno";
    this.lastLoginAt = props.lastLoginAt || null;
    this.createdAt = props.createdAt || new Date();
    this.updatedAt = props.updatedAt || new Date();
  }

  isAlumno() {
    return this.rol === "alumno";
  }

  isProfesor() {
    return this.rol === "profesor";
  }

  isAdmin() {
    return this.rol === "admin";
  }

  hasRole(role) {
    return this.rol === role;
  }
}

module.exports = Usuario;
