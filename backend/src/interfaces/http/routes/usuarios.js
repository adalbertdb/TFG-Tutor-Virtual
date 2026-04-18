const express = require("express");
const Usuario = require("../../../infrastructure/persistence/mongodb/models/usuario");
const { requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

// All user management routes require admin role
router.post("/usuarios", requireRole("admin"), (req, res) => {
   const nuevoUsuario = new Usuario(req.body);
   nuevoUsuario
   .save()
   .then((data) => res.json(data))
   .catch((error) => res.json({ message: error }));
});

// Get all users (admin only)
router.get("/usuarios", requireRole("admin"), (req, res) => {
    Usuario
   .find()
   .then((data) => res.json(data))
   .catch((error) => res.json({ message: error }));
});

// Get a user (admin only)
router.get("/usuarios/:id", requireRole("admin"), (req, res) => {
    const { id } = req.params;
    Usuario
   .findById(id)
   .then((data) => res.json(data))
   .catch((error) => res.json({ message: error }));
});

// Update a user (admin only)
router.put("/usuarios/:id", requireRole("admin"), (req, res) => {
    const { id } = req.params;
    const { loguin_usuario } = req.body;
    Usuario
   .updateOne({ _id: id}, {$set: {loguin_usuario}})
   .then((data) => res.json(data))
   .catch((error) => res.json({ message: error }));
});



module.exports = router;

