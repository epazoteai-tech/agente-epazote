/**
 * ¿Quién escribió este saliente: una persona del equipo o el celular solo?
 *
 *   npm run test:atencion
 *
 * Caso real (Epazote, 01/10/2026): el saludo automático de WhatsApp Business
 * salió en el mismo segundo que el "Buen día" del cliente, contó como persona
 * y el bot se calló 2 horas. El cliente esperó 8 y se fue a otro restaurante.
 */
const { esRespuestaAutomatica } = require('../dist/services/atencion-humana');

let fallas = 0;
const check = (n, real, esp) => {
  const ok = real === esp;
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${n}${ok ? '' : ` → ${real}`}`);
};
const t = (iso) => Date.parse(iso);
const entrantes = [t('2026-10-01T13:51:59Z'), t('2026-10-01T13:52:14Z')];

check('saludo automático en el mismo segundo → automático', esRespuestaAutomatica(t('2026-10-01T13:51:59Z'), entrantes), true);
check('a 3 segundos → automático', esRespuestaAutomatica(t('2026-10-01T13:52:17Z'), entrantes), true);
check('a 10 segundos → lo escribió una persona', esRespuestaAutomatica(t('2026-10-01T13:52:24Z'), entrantes), false);
check('la respuesta del equipo 8 horas después → persona', esRespuestaAutomatica(t('2026-10-01T22:01:29Z'), entrantes), false);
check('un saliente ANTES de cualquier entrante → persona', esRespuestaAutomatica(t('2026-10-01T13:50:00Z'), entrantes), false);
check('sin entrantes → persona', esRespuestaAutomatica(t('2026-10-01T13:51:59Z'), []), false);

console.log(fallas ? `\n${fallas} FALLA(S)` : '\nTodo bien');
process.exit(fallas ? 1 : 0);
