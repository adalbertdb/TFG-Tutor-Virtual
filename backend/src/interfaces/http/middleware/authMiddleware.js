"use strict";

const { isPublicRoute } = require("./publicRoutes");
const { hasMinRole } = require("../../../infrastructure/auth/roles");

/**
 * Global authentication middleware.
 * Applied to ALL /api/* routes BEFORE any route handlers.
 *
 * - Whitelisted public routes pass through without a session.
 * - All other routes require a valid session.
 * - On success, sets req.userId and req.userRole for downstream handlers.
 */
function globalAuth(req, res, next) {
  // Check if this route is in the public whitelist
  if (isPublicRoute(req.method, req.path)) {
    return next();
  }

  // Require valid session
  if (!req.session?.user?.id) {
    return res.status(401).json({ error: "No autenticado" });
  }

  // Set convenience properties derived from session (NEVER from client)
  req.userId = req.session.user.id;
  req.userRole = req.session.user.rol || "alumno";

  next();
}

/**
 * Role-based access control middleware factory.
 * Restricts access to users with one of the specified roles.
 *
 * Usage: router.delete("/:id", requireRole("profesor", "admin"), handler)
 *
 * @param {...string} roles - Allowed roles
 */
function requireRole(...roles) {
  return function (req, res, next) {
    const userRole = req.userRole || req.session?.user?.rol || "alumno";
    if (!roles.includes(userRole)) {
      return res
        .status(403)
        .json({ error: "No tienes permisos para esta acción" });
    }
    next();
  };
}

/**
 * Ownership check: verify the authenticated user owns the resource,
 * OR has a role that allows viewing other users' data (profesor, admin).
 *
 * @param {string} resourceUserId - The userId that owns the resource
 * @param {object} req - Express request (with req.userId and req.userRole)
 * @returns {boolean}
 */
function canAccessUserData(resourceUserId, req) {
  if (String(resourceUserId) === String(req.userId)) return true;
  return hasMinRole(req.userRole, "profesor");
}

module.exports = { globalAuth, requireRole, canAccessUserData };
