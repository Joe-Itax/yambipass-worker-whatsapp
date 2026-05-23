import { delay, type WASocket } from "@whiskeysockets/baileys";
import prisma from "./lib/prisma.js";

export async function processNextMessage(sock: WASocket): Promise<boolean> {
  const job = await prisma.whatsappQueue.findFirst({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });

  if (!job) return false;

  // Verrouiller la tâche
  await prisma.whatsappQueue.update({
    where: { id: job.id },
    data: { status: "PROCESSING" },
  });

  try {
    const jid = `${job.phoneNumber}@s.whatsapp.net`;
    console.log(`[Worker] Envoi à ${job.phoneNumber}...`);

    // --- Routine Anti-Ban ---
    await sock.sendPresenceUpdate("available", jid);
    await delay(1500);

    await sock.sendPresenceUpdate("composing", jid);
    await delay(Math.floor(Math.random() * 2000) + 3000); // Écriture (3-5s)
    await sock.sendPresenceUpdate("paused", jid);

    // Envoi du texte
    await sock.sendMessage(jid, { text: job.messageText });
    await delay(2000);

    // Envoi du QR Code
    if (job.qrCodeUrl) {
      await sock.sendMessage(jid, {
        image: { url: job.qrCodeUrl },
        caption: "Voici votre pass d'accès unique pour l'événement.",
      });
    }

    // Marquer comme terminé
    await prisma.whatsappQueue.update({
      where: { id: job.id },
      data: { status: "COMPLETED" },
    });

    // Gros délai aléatoire entre 35s et 55s
    const nextDelay = Math.floor(Math.random() * (55000 - 35000 + 1)) + 35000;
    console.log(
      `✅ Succès. Prochain envoi dans ${Math.round(nextDelay / 1000)}s...`,
    );
    await delay(nextDelay);

    return true;
  } catch (error: any) {
    console.error(`❌ Échec (${job.phoneNumber}):`, error.message);

    await prisma.whatsappQueue.update({
      where: { id: job.id },
      data: {
        status: job.attempts >= 2 ? "FAILED" : "PENDING",
        attempts: job.attempts + 1,
        errorMessage: error.message,
      },
    });

    await delay(10000); // Pause en cas d'erreur
    return true;
  }
}

export async function startWorker(sock: WASocket) {
  let hasMore = true;
  while (hasMore) {
    hasMore = await processNextMessage(sock);
  }
  // File vide : on revérifie dans 10 secondes
  setTimeout(() => startWorker(sock), 10000);
}
