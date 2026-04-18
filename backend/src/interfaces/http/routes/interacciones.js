// Interacciones
const express = require("express");
const Interaccion = require("../../../infrastructure/persistence/mongodb/models/interaccion");
const mongoose = require("mongoose");
const { canAccessUserData } = require("../middleware/authMiddleware");

const router = express.Router();

// NOTE: globalAuth is applied at app level in index.js, so all routes
// here already require authentication. req.userId is set by globalAuth.

// 0. Get current user's interacciones (was GET /user/:userId — now uses session)
router.get("/mine", async (req, res) => {
  try {
    const interacciones = await Interaccion.find({ usuario_id: req.userId }).sort({ fin: -1 });
    res.status(200).json(interacciones);
  } catch (error) {
    res.status(500).json({ message: "Error interno del servidor." });
  }
});

// 1. LEGACY: Get interacciones by userId param (profesor/admin only can see other users)
router.get("/user/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "ID de usuario inválido." });
    }

    // Ownership check: only own data or profesor/admin
    if (!canAccessUserData(userId, req)) {
      return res.status(403).json({ message: "No autorizado." });
    }

    const interacciones = await Interaccion.find({ usuario_id: userId }).sort({ fin: -1 });
    res.status(200).json(interacciones);
  } catch (error) {
    res.status(500).json({ message: "Error interno del servidor." });
  }
});

// 2. Get latest interaction for current user + exercise
// Changed: uses req.userId instead of URL param
router.get("/byExercise/:exerciseId", async (req, res) => {
  try {
    const { exerciseId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(exerciseId)) {
      return res.status(400).json({ message: "ID de ejercicio inválido." });
    }

    const interaccion = await Interaccion.findOne({
      ejercicio_id: exerciseId,
      usuario_id: req.userId,
    }).sort({ fin: -1 });

    if (!interaccion) {
      return res.status(200).json(null);
    }

    res.status(200).json(interaccion);
  } catch (error) {
    res.status(500).json({ message: "Error interno del servidor." });
  }
});

// 2b. LEGACY: Keep old URL pattern working during frontend migration
router.get("/byExerciseAndUser/:exerciseId/:userId", async (req, res) => {
  try {
    const { exerciseId, userId } = req.params;

    if (
      !mongoose.Types.ObjectId.isValid(exerciseId) ||
      !mongoose.Types.ObjectId.isValid(userId)
    ) {
      return res.status(400).json({ message: "IDs de ejercicio o usuario inválidos." });
    }

    // Ownership check
    if (!canAccessUserData(userId, req)) {
      return res.status(403).json({ message: "No autorizado." });
    }

    const interaccion = await Interaccion.findOne({
      ejercicio_id: exerciseId,
      usuario_id: userId,
    }).sort({ fin: -1 });

    if (!interaccion) {
      return res.status(200).json(null);
    }

    res.status(200).json(interaccion);
  } catch (error) {
    res.status(500).json({ message: "Error interno del servidor." });
  }
});

// 3. Get a specific interaccion by ID (ownership check)
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "ID de interacción inválido." });
    }

    const interaccion = await Interaccion.findById(id);
    if (!interaccion) {
      return res.status(404).json({ message: "Interacción no encontrada." });
    }

    // Ownership check
    if (!canAccessUserData(interaccion.usuario_id, req)) {
      return res.status(403).json({ message: "No autorizado." });
    }

    res.status(200).json(interaccion);
  } catch (error) {
    res.status(500).json({ message: "Error interno del servidor." });
  }
});

// 4. Delete an interaccion (owner only)
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "ID de interacción inválido." });
    }

    const interaccion = await Interaccion.findById(id);
    if (!interaccion) {
      return res.status(404).json({ message: "Interacción no encontrada para eliminar" });
    }

    // Only owner can delete (not even profesor)
    if (String(interaccion.usuario_id) !== String(req.userId)) {
      return res.status(403).json({ message: "No autorizado." });
    }

    await Interaccion.findByIdAndDelete(id);
    res.status(200).json({ message: "Interacción eliminada exitosamente" });
  } catch (error) {
    res.status(500).json({ message: "Error interno del servidor." });
  }
});


module.exports = router;
