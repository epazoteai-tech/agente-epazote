/**
 * Transcripción de audios con OpenAI Whisper API.
 *
 * WhatsApp manda voice notes como .ogg (Opus). Whisper soporta ogg, opus,
 * mp3, wav, m4a, etc. directamente.
 */

import { getConfig } from '../config';

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';

function getApiKey(): string | null {
  return process.env.OPENAI_API_KEY ?? null;
}

/**
 * Transcribe un audio (base64) usando Whisper.
 * Devuelve el texto transcrito o null si falla.
 */
export async function transcribirAudio(params: {
  base64: string;
  mimeType: string;
  ext: string;
}): Promise<string | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn('[whisper] OPENAI_API_KEY no configurada — no se puede transcribir');
    return null;
  }

  try {
    const buffer = Buffer.from(params.base64, 'base64');
    const ext = ['ogg', 'opus', 'mp3', 'wav', 'm4a', 'mp4', 'mpga', 'webm', 'flac'].includes(params.ext)
      ? params.ext
      : 'ogg';
    const filename = `audio.${ext}`;

    const formData = new FormData();
    const blob = new Blob([buffer], { type: params.mimeType || 'audio/ogg' });
    formData.append('file', blob, filename);
    formData.append('model', 'whisper-1');
    formData.append('language', getConfig().persona.audio_language);

    const res = await fetch(WHISPER_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData,
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn(`[whisper] ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = await res.json() as { text?: string };
    return data.text?.trim() ?? null;
  } catch (err) {
    console.warn('[whisper] error:', (err as Error).message);
    return null;
  }
}
