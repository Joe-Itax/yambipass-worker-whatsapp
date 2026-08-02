import express from "express";
import makeWASocket, { DisconnectReason } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import * as qrcode from "qrcode";
import "dotenv/config";
import requireApiKey from "./middlewares/require-api-key .js";
import { usePrismaAuthState } from "./auth/prisma-auth-state.js";
import { startWorker } from "./worker.js";
import prisma from "./lib/prisma.js";

const app = express();
const port = process.env.PORT || 3001;
let globalSock: any = null;

app.use(express.json());

// --- Routes API ---
app.get("/api/ping", (req, res) => {
  res.status(200).send("pong");
});

app.post("/api/trigger-worker", requireApiKey, (req, res) => {
  console.log("⚡ Signal reçu de Next.js ! Force le réveil du worker...");
  if (globalSock) {
    // On lance le worker immédiatement sans attendre les 10s
    startWorker(globalSock);
    res.status(200).json({ message: "Worker notifié et réveillé" });
  } else {
    res.status(503).json({ message: "Bot WhatsApp non connecté" });
  }
});

// Nom de la session
const SESSION_ID = "yambipass-main";

// --- Connexion WhatsApp ---
async function connectToWhatsApp() {
  const { state, saveCreds } = await usePrismaAuthState(SESSION_ID);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    // 1. Affichage du QR Code
    if (qr) {
      console.log("\n--- SCANNEZ CE QR CODE POUR CONNECTER LE BOT ---");
      qrcode.toString(qr, { type: "terminal", small: true }, (err, url) => {
        if (!err) console.log(url);
      });
    }

    // 2. Gestion de la fermeture de connexion
    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

      const isLoggedOut =
        statusCode === DisconnectReason.loggedOut || statusCode === 405;

      const shouldReconnect = !isLoggedOut;

      console.log(
        `[WhatsApp] Connexion fermée (Code: ${statusCode}). Reconnexion automatique : ${shouldReconnect}`,
      );

      if (shouldReconnect) {
        // Simple déconnexion réseau : on attend 8 secondes et on réessaye
        setTimeout(() => {
          console.log("🔄 Tentative de reconnexion réseau...");
          connectToWhatsApp();
        }, 8000);
      } else if (isLoggedOut) {
        // Correction de la logique ici
        // AUTOMATION : L'utilisateur a supprimé l'appareil depuis son téléphone
        console.log(
          "⚠️ Appareil déconnecté depuis le téléphone. Nettoyage automatique de la session en DB...",
        );

        prisma.whatsappSession
          .deleteMany({
            where: {
              id: { startsWith: `${SESSION_ID}-` },
            },
          })
          .then(() => {
            console.log(
              "✅ DB nettoyée avec succès. Génération d'un nouveau QR Code...",
            );
            // On relance immédiatement la fonction pour afficher le nouveau QR Code à scanner !
            connectToWhatsApp();
          })
          .catch((err) => {
            console.error(
              "❌ Erreur lors du nettoyage automatique de la session :",
              err.message,
            );
          });
      }
    }
    // 3. Connexion réussie
    else if (connection === "open") {
      console.log("✅ Bot WhatsApp connecté et prêt !");
      globalSock = sock;
      startWorker(sock);
    }
  });
}

app.listen(port, () => {
  console.log(`🚀 Serveur Worker démarré sur le port ${port}`);
  connectToWhatsApp();
});
