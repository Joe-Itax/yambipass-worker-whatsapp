import { delay, type WASocket } from "@whiskeysockets/baileys";
import prisma from "./lib/prisma.js";

let isProcessing = false;
let currentBatchLimit = randomInt(35, 45);
let processedInCurrentBatch = 0;

const MESSAGE_DELAY_MIN_MS = 35_000;
const MESSAGE_DELAY_MAX_MS = 50_000;
const BATCH_PAUSE_MIN_MS = 10 * 60_000;
const BATCH_PAUSE_MAX_MS = 20 * 60_000;
const BATCH_SIZE_MIN = 35;
const BATCH_SIZE_MAX = 45;
const ERROR_NOT_ON_WHATSAPP = "NOT_ON_WHATSAPP";

type ProcessResult = "EMPTY" | "SENT" | "FAILED" | "SKIPPED";

export async function processNextMessage(
  sock: WASocket,
): Promise<ProcessResult> {
  const job = await prisma.whatsappQueue.findFirst({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });

  if (!job) return "EMPTY";

  // Verrouiller la tâche
  await prisma.whatsappQueue.update({
    where: { id: job.id },
    data: { status: "PROCESSING" },
  });

  try {
    const jid = await resolveWhatsappJid(sock, job.phoneNumber);
    console.log(`[Worker] Envoi à ${job.phoneNumber}...`);

    // --- Routine Anti-Ban ---
    await sock.sendPresenceUpdate("available", jid);
    await delay(1500);

    await sock.sendPresenceUpdate("composing", jid);
    await delay(Math.floor(Math.random() * 2000) + 3000); // Écriture (3-5s)
    await sock.sendPresenceUpdate("paused", jid);

    // Envoi unique : image + caption. Si pas d'image, fallback texte.
    if (job.qrCodeUrl) {
      await sock.sendMessage(jid, {
        image: { url: job.qrCodeUrl },
        caption: normalizeInvitationCaption(job.messageText),
      });
    } else {
      await sock.sendMessage(jid, {
        text: normalizeInvitationCaption(job.messageText),
      });
    }

    // Marquer comme terminé
    await prisma.whatsappQueue.update({
      where: { id: job.id },
      data: { status: "COMPLETED" },
    });

    console.log("✅ Succès.");
    return "SENT";
  } catch (error: any) {
    console.error(`❌ Échec (${job.phoneNumber}):`, error.message);
    const isNotOnWhatsapp =
      error?.code === ERROR_NOT_ON_WHATSAPP ||
      String(error?.message || "").includes(ERROR_NOT_ON_WHATSAPP);

    await prisma.whatsappQueue.update({
      where: { id: job.id },
      data: {
        status: isNotOnWhatsapp || job.attempts >= 2 ? "FAILED" : "PENDING",
        attempts: job.attempts + 1,
        errorMessage: isNotOnWhatsapp
          ? `${ERROR_NOT_ON_WHATSAPP}: Numéro non enregistré sur WhatsApp.`
          : error.message,
      },
    });

    await delay(10000); // Pause en cas d'erreur
    return isNotOnWhatsapp ? "SKIPPED" : "FAILED";
  }
}

export async function startWorker(sock: WASocket) {
  if (isProcessing) return; // Si déjà en train de tourner, on ignore
  isProcessing = true;

  try {
    while (true) {
      const result = await processNextMessage(sock);
      if (result === "EMPTY") break;

      if (result !== "SKIPPED") {
        processedInCurrentBatch += 1;
      }

      const pendingCount = await getPendingCount();
      if (pendingCount === 0) break;

      if (processedInCurrentBatch >= currentBatchLimit) {
        const pause = randomInt(BATCH_PAUSE_MIN_MS, BATCH_PAUSE_MAX_MS);
        console.log(
          `⏸️ Lot de ${processedInCurrentBatch}/${currentBatchLimit} terminé. Pause de ${Math.round(
            pause / 60_000,
          )} min avant la suite (${pendingCount} restant(s)).`,
        );
        await delay(pause);
        resetBatch();
      } else {
        const nextDelay = randomInt(MESSAGE_DELAY_MIN_MS, MESSAGE_DELAY_MAX_MS);
        console.log(
          `⏳ Prochain envoi dans ${Math.round(nextDelay / 1000)}s (${processedInCurrentBatch}/${currentBatchLimit}, ${pendingCount} restant(s))...`,
        );
        await delay(nextDelay);
      }
    }
  } catch (error: any) {
    console.error(
      "❌ [Worker] Erreur critique (ex: perte de connexion DB):",
      error.message,
    );
  } finally {
    isProcessing = false;
    setTimeout(() => startWorker(sock), 10000);
  }
}

async function resolveWhatsappJid(sock: WASocket, phoneNumber: string) {
  const jid = `${phoneNumber}@s.whatsapp.net`;
  const onWhatsAppRes = (await sock.onWhatsApp(jid)) || [];
  const [account] = Array.isArray(onWhatsAppRes) ? onWhatsAppRes : [];

  if (!account?.exists) {
    const error = new Error(
      `${ERROR_NOT_ON_WHATSAPP}: ${phoneNumber} n'est pas enregistré sur WhatsApp.`,
    );
    (error as Error & { code: string }).code = ERROR_NOT_ON_WHATSAPP;
    throw error;
  }

  return account.jid || jid;
}

function normalizeInvitationCaption(messageText: string) {
  return messageText
    .replace("Votre pass digital :", "Votre Invitation :")
    .replace(
      "Pour confirmer la bonne reception de votre pass",
      "Pour confirmer la bonne reception de votre invitation",
    );
}

async function getPendingCount() {
  return prisma.whatsappQueue.count({
    where: { status: "PENDING" },
  });
}

function resetBatch() {
  processedInCurrentBatch = 0;
  currentBatchLimit = randomInt(BATCH_SIZE_MIN, BATCH_SIZE_MAX);
  console.log(`🎲 Nouveau lot WhatsApp: ${currentBatchLimit} message(s).`);
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
