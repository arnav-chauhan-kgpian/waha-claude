import { config } from "./config.js";

export type WahaStatus =
  | "STARTING"
  | "SCAN_QR_CODE"
  | "WORKING"
  | "FAILED"
  | "STOPPED";

export type WahaSession = {
  name: string;
  status: WahaStatus;
  me?: { id: string; pushName?: string } | null;
};

export type WahaChat = {
  id: string;
  name?: string;
  lastMessageAt?: number;
  unreadCount?: number;
};

export type WahaMessage = {
  id: string;
  body?: string;
  text?: string;
  from?: string;
  fromMe?: boolean;
  timestamp?: number;
  author?: string;
  notifyName?: string;
};

class WahaError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  accept = "application/json"
): Promise<T> {
  const res = await fetch(`${config.wahaUrl}${path}`, {
    method,
    headers: {
      "X-Api-Key": config.wahaApiKey,
      Accept: accept,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new WahaError(res.status, `WAHA ${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const waha = {
  async getSession(name: string): Promise<WahaSession | null> {
    try {
      return await call<WahaSession>("GET", `/api/sessions/${encodeURIComponent(name)}`);
    } catch (e) {
      if (e instanceof WahaError && e.status === 404) return null;
      throw e;
    }
  },

  async createAndStart(name: string): Promise<WahaSession> {
    return await call<WahaSession>("POST", "/api/sessions", {
      name,
      start: true,
      config: {
        noweb: {
          store: { enabled: true, fullSync: true },
        },
      },
    });
  },

  async deleteSession(name: string): Promise<void> {
    await call<void>("DELETE", `/api/sessions/${encodeURIComponent(name)}`);
  },

  async start(name: string): Promise<WahaSession> {
    return await call<WahaSession>("POST", `/api/sessions/${encodeURIComponent(name)}/start`);
  },

  async stop(name: string): Promise<WahaSession> {
    return await call<WahaSession>("POST", `/api/sessions/${encodeURIComponent(name)}/stop`);
  },

  async qrPngBase64(name: string): Promise<{ mimetype: string; data: string }> {
    return await call(
      "GET",
      `/api/${encodeURIComponent(name)}/auth/qr?format=image`,
      undefined,
      "application/json"
    );
  },

  async listContacts(name: string): Promise<Array<{ id: string; name?: string; phoneNumber?: string }>> {
    return await call(
      "GET",
      `/api/contacts/all?session=${encodeURIComponent(name)}`
    );
  },

  async listChats(name: string, limit = 50): Promise<WahaChat[]> {
    return await call<WahaChat[]>(
      "GET",
      `/api/${encodeURIComponent(name)}/chats?limit=${limit}&sortBy=conversationTimestamp&sortOrder=desc`
    );
  },

  async getMessages(name: string, chatId: string, limit = 50): Promise<WahaMessage[]> {
    return await call<WahaMessage[]>(
      "GET",
      `/api/${encodeURIComponent(name)}/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}&downloadMedia=false`
    );
  },

  async sendText(name: string, chatId: string, text: string): Promise<{ id: { id: string } } | any> {
    return await call("POST", "/api/sendText", { session: name, chatId, text });
  },
};
