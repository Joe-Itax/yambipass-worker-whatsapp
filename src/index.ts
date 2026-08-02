import express from "express";
import makeWASocket, {
  DisconnectReason,
  fetchLatestWaWebVersion,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import * as qrcode from "qrcode";
import "dotenv/config";

import requireApiKey from "./middlewares/require-api-key .js";
import { usePrismaAuthState } from "./auth/prisma-auth-state.js";
import { startWorker } from "./worker.js";
import prisma from "./lib/prisma.js";

const app = express();

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const host = "0.0.0.0";

let globalSock: ReturnType<typeof makeWASocket> | null = null;

// Cache de la version WhatsApp Web.
// Elle est récupérée une seule fois et réutilisée
// lors des reconnexions normales.
let waVersion:
  | Awaited<ReturnType<typeof fetchLatestWaWebVersion>>["version"]
  | null = null;

app.use(express.json());

// --------------------------------------------------
// Routes API
// --------------------------------------------------

app.get("/api/ping", (req, res) => {
  res.status(200).send("pong");
});

app.post("/api/trigger-worker", requireApiKey, (req, res) => {
  console.log("⚡ Signal reçu de Next.js ! Force le réveil du worker...");

  if (globalSock) {
    // Lance immédiatement le worker
    // sans attendre le prochain cycle prévu.
    startWorker(globalSock);

    return res.status(200).json({
      message: "Worker notifié et réveillé",
    });
  }

  return res.status(503).json({
    message: "Bot WhatsApp non connecté",
  });
});

// --------------------------------------------------
// Configuration session WhatsApp
// --------------------------------------------------

const SESSION_ID = "yambipass-main";

// --------------------------------------------------
// Récupération de la version WhatsApp Web
// --------------------------------------------------

async function getWaVersion() {
  // Si une version a déjà été récupérée,
  // on la réutilise pour les reconnexions.
  if (waVersion) {
    return waVersion;
  }

  console.log("🌐 Récupération de la version actuelle de WhatsApp Web...");

  const { version, isLatest } = await fetchLatestWaWebVersion();

  waVersion = version;

  console.log(
    `[WhatsApp] Version Web utilisée : ${version.join(".")} | Latest: ${isLatest}`,
  );

  return waVersion;
}

// --------------------------------------------------
// Connexion WhatsApp
// --------------------------------------------------

async function connectToWhatsApp() {
  try {
    console.log("🔐 Chargement des credentials WhatsApp...");

    const { state, saveCreds } = await usePrismaAuthState(SESSION_ID);

    // Récupère la version une seule fois.
    // Les reconnexions normales réutiliseront cette version.
    const version = await getWaVersion();

    const sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      logger: pino({
        level: "silent",
      }),
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      console.log("[WhatsApp] Connection update :", {
        connection,
        hasQr: Boolean(qr),
      });

      // --------------------------------------------------
      // Affichage du QR Code
      // --------------------------------------------------

      if (qr) {
        console.log("\n--- SCANNEZ CE QR CODE POUR CONNECTER LE BOT ---");

        qrcode.toString(
          qr,
          {
            type: "terminal",
            small: true,
          },
          (err, url) => {
            if (err) {
              console.error("❌ Erreur génération QR :", err);
              return;
            }

            console.log(url);
          },
        );
      }

      // --------------------------------------------------
      // Gestion de la fermeture de connexion
      // --------------------------------------------------

      if (connection === "close") {
        // Le socket actuel n'est plus utilisable.
        globalSock = null;

        // console.dir(lastDisconnect, {
        //   depth: null,
        // });

        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(
          `[WhatsApp] Connexion fermée (Code: ${statusCode}). Reconnexion automatique : ${shouldReconnect}`,
        );

        // --------------------------------------------------
        // Cas spécial : 405
        // --------------------------------------------------
        // Si WhatsApp refuse à nouveau la connexion avec 405,
        // on invalide la version mise en cache.
        // La prochaine tentative récupérera une nouvelle version.
        // --------------------------------------------------

        if (statusCode === 405) {
          console.warn(
            "⚠️ Erreur 405 détectée. La version WhatsApp Web en cache sera actualisée.",
          );

          waVersion = null;
        }

        // --------------------------------------------------
        // Reconnexion automatique
        // --------------------------------------------------

        if (shouldReconnect) {
          setTimeout(() => {
            console.log("🔄 Tentative de reconnexion...");

            connectToWhatsApp().catch((err) => {
              console.error("❌ Erreur lors de la reconnexion WhatsApp :", err);
            });
          }, 8000);

          return;
        }

        // --------------------------------------------------
        // Session déconnectée définitivement
        // --------------------------------------------------

        console.log("⚠️ Session WhatsApp déconnectée définitivement.");

        console.log("🧹 Nettoyage automatique des credentials en DB...");

        prisma.whatsappSession
          .deleteMany({
            where: {
              id: {
                startsWith: `${SESSION_ID}-`,
              },
            },
          })
          .then(() => {
            console.log("✅ Session supprimée de la DB.");

            console.log(
              "🔄 Nouvelle tentative de connexion pour générer un nouveau QR Code...",
            );

            connectToWhatsApp().catch((err) => {
              console.error(
                "❌ Erreur lors de la nouvelle connexion WhatsApp :",
                err,
              );
            });
          })
          .catch((err) => {
            console.error("❌ Erreur lors du nettoyage de la session :", err);
          });
      }

      // --------------------------------------------------
      // Connexion réussie
      // --------------------------------------------------
      else if (connection === "open") {
        console.log("✅ Bot WhatsApp connecté et prêt !");

        globalSock = sock;

        startWorker(sock);
      }
    });
  } catch (error) {
    // Une erreur peut survenir avant même que
    // connection.update soit initialisé.
    console.error("❌ Impossible d'initialiser la connexion WhatsApp :", error);

    // On retente après 8 secondes.
    setTimeout(() => {
      console.log("🔄 Nouvelle tentative d'initialisation WhatsApp...");

      connectToWhatsApp().catch((err) => {
        console.error("❌ Erreur lors de la nouvelle tentative :", err);
      });
    }, 8000);
  }
}

// --------------------------------------------------
// Démarrage du serveur
// --------------------------------------------------

app.listen(port, host, () => {
  console.log(`🚀 Serveur Worker démarré sur ${host}:${port}`);

  connectToWhatsApp().catch((err) => {
    console.error("❌ Erreur au démarrage du bot WhatsApp :", err);
  });
});
