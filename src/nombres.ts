/**
 * Utilidades para tratar el nombre de un contacto.
 *
 * Viven aparte porque el mismo criterio lo necesitan dos lugares que no se
 * importan entre sí: el worker de mensajes (al agendar, para decidir si pisa
 * el nombre del contacto en GHL) y el de follow-ups (para decidir si saluda
 * por nombre).
 */

/**
 * ¿El nombre que trae el contacto parece un nombre de persona?
 *
 * Cuando el lead entra por WhatsApp, GHL llena `firstName` con el nombre de
 * perfil de WhatsApp, que el contacto pone a su gusto: emojis, un apodo, su
 * estado de ánimo. Caso real: el contacto se llamaba "💤💤💤💤🩵🩵🩵" y así
 * salió en el recordatorio ("Hola 💤💤💤💤🩵🩵🩵, te recordamos tu cita…")
 * aunque nos había dado su nombre completo al agendar.
 *
 * Por eso un `firstName` lleno NO significa un `firstName` correcto: ese
 * campo llega lleno SIEMPRE, y un guard del tipo `if (!contacto.firstName)`
 * nunca entra.
 *
 * Heurística deliberadamente laxa: basta UNA letra (incluidos acentos y ñ)
 * para considerarlo nombre y respetarlo. Solo se descarta lo que no tiene
 * ninguna — emojis, signos, números sueltos —, que es justo el caso que
 * queremos pisar con el nombre real que dio el contacto.
 */
export function pareceNombreReal(nombre: string | null | undefined): boolean {
  return /\p{L}/u.test(nombre ?? '');
}
