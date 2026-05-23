import express from "express";

// --- Middleware de Sécurité ---
const requireApiKey = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${process.env.WORKER_API_KEY}`) {
    console.warn(`[Alerte Sécurité] Tentative d'accès non autorisée.`);
    return res.status(401).json({ error: "Accès refusé. Clé invalide." });
  }
  next();
};

export default requireApiKey;
