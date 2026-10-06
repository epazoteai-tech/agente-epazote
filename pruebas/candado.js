/**
 * Llave del freno del PIN detrás de Cloudflare.
 *
 * Caso real (06/10/2026): con epazote.sellerstudio.mx detrás del proxy de
 * Cloudflare, `req.ip` era el nodo de Cloudflare y todo el equipo compartía la
 * misma llave: la página respondía "Demasiados intentos" sin que nadie
 * hubiera tecleado un PIN.
 */
const { llaveDe, esDeCloudflare } = require('../dist/auth');

let fallas = 0;
const check = (n, real, esp) => {
  const ok = real === esp;
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${n}${ok ? '' : ` → ${real}`}`);
};
const req = (ip, cf) => ({ ip, header: (h) => (h === 'cf-connecting-ip' ? cf : undefined) });

check('nodo de Cloudflare v4 → IP del cliente', llaveDe(req('172.71.10.4', '189.203.1.9')), '189.203.1.9');
check('nodo de Cloudflare v6 → IP del cliente', llaveDe(req('2a06:98c1:3120::7', '189.203.1.9')), '189.203.1.9');
check('header falso por el dominio de Railway → se ignora', llaveDe(req('189.203.1.9', '1.2.3.4')), '189.203.1.9');
check('sin header → req.ip', llaveDe(req('172.71.10.4', undefined)), '172.71.10.4');
check('IPv4 mapeada a v6', esDeCloudflare('::ffff:104.21.14.80'), true);
check('IP de Telmex no es Cloudflare', esDeCloudflare('189.203.1.9'), false);
check('2a06:98c8:: queda fuera del /29', esDeCloudflare('2a06:98c8::1'), false);

console.log(fallas ? `\n${fallas} falla(s)` : '\nTodo bien');
process.exit(fallas ? 1 : 0);
