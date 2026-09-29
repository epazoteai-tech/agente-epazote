/**
 * Validación de DATABASE_URL.
 *
 * Existe por un incidente real: en Railway, si la referencia
 * `${{Postgres.DATABASE_URL}}` no resuelve (porque el servicio de Postgres no
 * existe todavía o se llama distinto), la variable llega como texto literal.
 * La librería `pg` no se queja de eso: no logra parsearlo y se va a su default
 * silencioso, que es localhost:5432. El bot entonces truena con
 * `ECONNREFUSED 127.0.0.1:5432`, un error que apunta al lugar equivocado y
 * manda a buscar un Postgres local que nunca debió existir.
 *
 * Mejor fallar aquí, diciendo exactamente qué está mal.
 */
export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;

  if (!url) {
    throw new Error(
      'Falta DATABASE_URL.\n' +
        '  En Railway: servicio del bot → Variables → agrega DATABASE_URL\n' +
        '  con una referencia al servicio de Postgres.'
    );
  }

  if (url.includes('${{') || url.includes('}}')) {
    throw new Error(
      `DATABASE_URL trae una referencia de Railway sin resolver: "${url}"\n` +
        '  Suele ser que el servicio de Postgres no existe, o que no se llama\n' +
        '  como dice la referencia. En vez de escribirla a mano, usa el botón\n' +
        '  "Add a Variable Reference" en Variables y elige Postgres → DATABASE_URL.'
    );
  }

  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new Error(
      `DATABASE_URL no parece una URL de Postgres: "${url.slice(0, 40)}..."\n` +
        '  Debe empezar con postgresql://'
    );
  }

  if (process.env.NODE_ENV === 'production' && /@(localhost|127\.0\.0\.1|::1)[:/]/i.test(url)) {
    throw new Error(
      'DATABASE_URL apunta a localhost en producción.\n' +
        '  Es el valor de desarrollo del .env. En Railway tiene que ser una\n' +
        '  referencia al servicio de Postgres, no la cadena local.'
    );
  }

  return url;
}

/**
 * Avisa si las llaves de API están puestas en la variable equivocada.
 *
 * Pasó de verdad en este proyecto: `OPENAI_API_KEY` quedó con una llave de
 * Anthropic (`sk-ant-…`), en el `.env` y en Railway. Nada truena al arrancar
 * y el texto funciona perfecto — el error solo aparece cuando una paciente
 * manda su primera nota de voz, Whisper responde 401, y el bot contesta como
 * si no hubiera recibido nada. Es el peor tipo de falla: silenciosa y en
 * producción.
 *
 * No lanza a propósito: una llave mal puesta no debe tumbar un bot que por lo
 * demás funciona. Solo lo deja escrito en los logs del arranque.
 */
export function warnIfApiKeysLookSwapped(): void {
  const openai = process.env.OPENAI_API_KEY ?? '';
  const anthropic = process.env.ANTHROPIC_API_KEY ?? '';

  if (openai.startsWith('sk-ant-')) {
    console.warn(
      '[env] ⚠️  OPENAI_API_KEY trae una llave de ANTHROPIC (empieza con "sk-ant-"). ' +
        'El texto va a funcionar, pero las notas de voz NO se van a transcribir: ' +
        'Whisper responde 401 y el bot contesta como si el audio no existiera. ' +
        'Pon una llave de OpenAI (platform.openai.com) o borra la variable.'
    );
  }

  if (anthropic && !anthropic.startsWith('sk-ant-')) {
    console.warn(
      '[env] ⚠️  ANTHROPIC_API_KEY no empieza con "sk-ant-" — revisa que no esté ' +
        'cruzada con otra llave.'
    );
  }
}
