/**
 * System prompt del bot.
 *
 * El contenido del prompt vive en `configuracion/prompt.md` (texto editable
 * sin tocar código). Los placeholders {{bot.name}}, {{business.description}},
 * etc. se llenan desde `configuracion/bot.config.yaml`.
 *
 * Para cambiar lo que el bot sabe o cómo se comporta:
 *   - Edita configuracion/prompt.md (texto del prompt)
 *   - Edita configuracion/bot.config.yaml (datos del negocio, personalidad)
 *
 * No necesitas tocar este archivo.
 */

import { renderPrompt } from '../config';

let cached: string | null = null;

export function buildSystemPrompt(): string {
  if (cached === null) cached = renderPrompt();
  return cached;
}
