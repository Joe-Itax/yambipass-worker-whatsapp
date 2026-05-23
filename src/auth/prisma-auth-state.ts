import {
  initAuthCreds,
  BufferJSON,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import prisma from "../lib/prisma.js";

export const usePrismaAuthState = async (
  sessionId: string,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
  const readData = async (id: string) => {
    const parsedId = `${sessionId}-${id}`;
    const data = await prisma.whatsappSession.findUnique({
      where: { id: parsedId },
    });
    if (data?.data) return JSON.parse(data.data, BufferJSON.reviver);
    return null;
  };

  const writeData = async (data: any, id: string) => {
    const parsedId = `${sessionId}-${id}`;
    const stringified = JSON.stringify(data, BufferJSON.replacer);
    await prisma.whatsappSession.upsert({
      where: { id: parsedId },
      create: { id: parsedId, data: stringified },
      update: { data: stringified },
    });
  };

  const removeData = async (id: string) => {
    const parsedId = `${sessionId}-${id}`;
    try {
      await prisma.whatsappSession.delete({ where: { id: parsedId } });
    } catch (error) {}
  };

  const creds = (await readData("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: { [_: string]: SignalDataTypeMap[typeof type] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === "app-state-sync-key" && value) value = value;
              data[id] = value;
            }),
          );
          return data;
        },
        set: async (data) => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            const categoryData = data[category as keyof typeof data];
            if (categoryData) {
              for (const id in categoryData) {
                const value = categoryData[id];
                const key = `${category}-${id}`;
                tasks.push(value ? writeData(value, key) : removeData(key));
              }
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, "creds"),
  };
};
