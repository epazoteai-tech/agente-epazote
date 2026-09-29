// --- Conversación ---
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: string; // ISO timestamp
  /**
   * Quién lo escribió cuando NO fue el bot ni el contacto. 'humano' = una
   * persona del consultorio escribió a mano en GHL (se guarda como assistant
   * para que el modelo tenga el contexto, pero marcado, para que el detector
   * de "hay una persona atendiendo" no lo confunda con un mensaje del bot).
   */
  origen?: 'humano';
}

export interface Conversation {
  id: string;
  contact_id: string;
  phone: string;
  contact_name: string | null;
  messages: ChatMessage[];
  metadata: Record<string, unknown>;
}

// --- Payload del webhook de GHL (formato real del Workflow) ---
export interface GHLWebhookPayload {
  contact_id: string;
  first_name?: string;
  full_name?: string;
  phone: string;
  location: {
    id: string;
    name?: string;
    [key: string]: unknown;
  };
  message?: {
    type?: number;
    body?: string;
  };
  workflow?: {
    id: string;
    name: string;
  };
  [key: string]: unknown;
}

// --- Canal de entrega de GHL Conversations API ---
// Valores válidos según docs de GHL para POST /conversations/messages.type
export type GhlChannel =
  | 'SMS'
  | 'Email'
  | 'WhatsApp'
  | 'FB'
  | 'IG'
  | 'Custom'
  | 'Live_Chat'
  | 'GMB';

// --- Datos del job en pg-boss ---
export interface MessageJobData {
  contactId: string;
  phone: string;
  contactName: string | null;
  message: string;
  channel: GhlChannel;
}
