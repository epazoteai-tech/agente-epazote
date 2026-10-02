/**
 * Candado de la Mesa de Control de Epazote.
 *
 * Portado TAL CUAL del KDS de Viking Food (src/auth.ts, 30/09/2026), que ya
 * pasó por E70 (panel abierto en internet), E71 (freno por instancia) y el
 * hueco de la pantalla que no contaba intentos. Solo cambian los nombres:
 * MESA_PIN, tabla mesa_intentos, cookie mesa_pin. Lo de abajo es el texto
 * original: donde dice "cocina" léase "el host del restaurante".
 */
import { Request, Response, NextFunction } from 'express';
import { db } from './db/client';

/**
 * Candado del KDS y los reportes.
 *
 * Todo esto vivía abierto en internet: quien tuviera la URL veía las comandas
 * en vivo, descargaba el reporte con nombre, teléfono y valor total de cada
 * cliente, metía pedidos falsos a la cocina o marcaba listo un pedido real que
 * nadie había preparado.
 *
 * El PIN va en la variable de entorno MESA_PIN. La pantalla de cocina lo escribe
 * una vez y queda en una cookie de un año, así que la compu de cocina no lo
 * vuelve a pedir aunque se cierre el navegador.
 *
 * Se usa cookie y no localStorage porque la cookie viaja sola en la NAVEGACIÓN
 * (`GET /kds.html`), no solo en los `fetch`. Con localStorage, al recargar
 * después de escribir el PIN la petición del HTML iba sin credencial y la
 * pantalla se quedaba pidiendo el PIN en un ciclo infinito.
 *
 * `SameSite=Lax` es lo que evita el CSRF: otro sitio no puede hacer que el
 * navegador de la cocina mande esta cookie en un POST a `/api/kds/...`.
 *
 * Si falta MESA_PIN, `coincide` rechaza TODO (nunca compara contra vacío): el
 * KDS queda cerrado en vez de abierto. Un default permisivo es exactamente el
 * agujero que esto viene a tapar. El bot de WhatsApp sigue corriendo — index.ts
 * lo avisa en el log al arrancar, no tumba el proceso.
 */

export const COOKIE_PIN = 'mesa_pin';

function pinEsperado(): string {
  return process.env.MESA_PIN ?? '';
}

/** Comparación de tiempo constante — un `===` sobre un secreto corto filtra
 * por tiempo cuántos caracteres iniciales acertó quien lo está adivinando. */
function coincide(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Lee la cookie a mano para no sumar `cookie-parser` por un solo valor. */
function cookie(req: Request, nombre: string): string {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const parte of raw.split(';')) {
    const i = parte.indexOf('=');
    if (i === -1) continue;
    if (parte.slice(0, i).trim() === nombre) {
      return decodeURIComponent(parte.slice(i + 1).trim());
    }
  }
  return '';
}

function pinDeLaPeticion(req: Request): string {
  // El header sirve para la validación inicial de la pantalla de PIN (antes de
  // que exista la cookie) y para probar la API con curl.
  const header = req.header('x-mesa-pin');
  if (typeof header === 'string' && header) return header;
  return cookie(req, COOKIE_PIN);
}

/**
 * Freno de fuerza bruta, COMPARTIDO entre instancias.
 *
 * Sin esto el PIN no protege nada: probar todas las combinaciones contra la API
 * es cuestión de horas. Detrás están el nombre, teléfono y valor total de cada
 * cliente, y la posibilidad de meter comandas falsas a la cocina.
 *
 * ⚠️ El largo del PIN NO se da por sabido acá. Este comentario decía "4 dígitos
 * son 10,000 combinaciones" y el PIN real de Viking es de 6, o sea un millón:
 * con el freno puesto, adivinarlo pasa de meses a años. La cuenta cambia por
 * cien con cada dígito, así que quien evalúe el riesgo tiene que ir a ver
 * cuánto mide MESA_PIN en Railway, no creerle a un comentario.
 *
 * POR QUÉ EN POSTGRES Y NO EN MEMORIA. Vivía en un `Map`, con el comentario
 * "es un solo contenedor". Al probar el freno contra producción esa premisa
 * resultó falsa: doce intentos seguidos con un PIN equivocado devolvieron 401 y
 * 429 alternados — lo que pasa cuando cada instancia lleva su propia cuenta y
 * el balanceador las reparte. El atacante conseguía tantos intentos como
 * réplicas hubiera, y un reinicio de Railway borraba el bloqueo.
 *
 * EL CAMINO FELIZ NO TOCA LA BASE. Quien llega con una cookie válida —la
 * cocina, todo el día, cada 4 segundos— entra sin una sola consulta. Solo se
 * escribe cuando alguien FALLA el PIN, que es raro. Dos consecuencias buenas:
 * la pantalla no paga latencia por el candado, y con Postgres caído la cocina
 * que ya tiene su PIN sigue entrando.
 *
 * Bloqueo progresivo (2s, 4s, 8s… con techo de 5 minutos) para que el personal
 * que se equivoca una o dos veces no se quede fuera diez minutos.
 */
const MAX_FALLOS_LIBRES = 5;
const TECHO_BLOQUEO_SEG = 300;

/**
 * Caché local de "hasta cuándo está bloqueada esta llave".
 *
 * No es la fuente de verdad —esa es la tabla— sino un amortiguador: mientras
 * alguien martilla con un PIN equivocado, cada petición se rechaza sin tocar
 * Postgres. Sin esto, un ataque a mil peticiones por segundo se convertiría en
 * mil escrituras por segundo contra la misma base que atiende WhatsApp.
 */
const bloqueoLocal = new Map<string, number>();

function llaveDe(req: Request): string {
  return req.ip ?? 'desconocida';
}

/**
 * Registra el fallo y devuelve hasta cuándo queda bloqueada la llave.
 *
 * El backoff se calcula EN SQL para que el incremento y la decisión ocurran en
 * la misma operación atómica: dos instancias fallando a la vez no se pisan la
 * cuenta. El exponente va acotado a 20 porque `2 ^ n` sobre un numeric de
 * Postgres con n grande produce un número absurdo y lento de calcular.
 */
async function registrarFallo(llave: string): Promise<number> {
  const { rows } = await db.query<{ fallos: number; bloqueado_hasta: string | null }>(
    `INSERT INTO mesa_intentos (llave, fallos, bloqueado_hasta)
     VALUES ($1, 1, NULL)
     ON CONFLICT (llave) DO UPDATE
     SET fallos = mesa_intentos.fallos + 1,
         bloqueado_hasta = CASE
           WHEN mesa_intentos.fallos + 1 > $2
           THEN now() + (LEAST(2 * 2 ^ LEAST(mesa_intentos.fallos + 1 - $2 - 1, 20), $3) || ' seconds')::interval
           ELSE mesa_intentos.bloqueado_hasta
         END,
         actualizado_at = now()
     RETURNING fallos, bloqueado_hasta`,
    [llave, MAX_FALLOS_LIBRES, TECHO_BLOQUEO_SEG]
  );

  const fila = rows[0];
  const hasta = fila?.bloqueado_hasta ? new Date(fila.bloqueado_hasta).getTime() : 0;
  if (hasta > Date.now()) {
    bloqueoLocal.set(llave, hasta);
    console.warn(
      `[auth] ${fila.fallos} PIN fallidos desde ${llave}, bloqueado ${Math.round((hasta - Date.now()) / 1000)}s`
    );
  }
  return hasta;
}

async function limpiarFallos(llave: string): Promise<void> {
  bloqueoLocal.delete(llave);
  await db.query('DELETE FROM mesa_intentos WHERE llave = $1', [llave]).catch(() => {});
}

export function pinValido(req: Request): boolean {
  return coincide(pinDeLaPeticion(req), pinEsperado());
}

/**
 * Comprueba el PIN aplicando el freno. Devuelve el resultado para el caller.
 *
 * El orden —bloqueo, PIN, fallo— importa: el chequeo del bloqueo va primero
 * para que martillar no sirva de nada, y sale de la caché local cuando la hay
 * para no convertir un ataque en carga sobre Postgres.
 */
async function revisar(
  req: Request
): Promise<{ estado: 'ok' | 'invalido' | 'bloqueado'; esperaSeg: number }> {
  const llave = llaveDe(req);

  const bloqueadoHasta = bloqueoLocal.get(llave) ?? 0;
  if (bloqueadoHasta > Date.now()) {
    return { estado: 'bloqueado', esperaSeg: Math.ceil((bloqueadoHasta - Date.now()) / 1000) };
  }
  if (bloqueadoHasta) bloqueoLocal.delete(llave);

  if (pinValido(req)) {
    // Sin rastro local de fallos no hay nada que limpiar, y este es el camino
    // de la cocina: se sale sin tocar la base.
    if (bloqueadoHasta) void limpiarFallos(llave);
    return { estado: 'ok', esperaSeg: 0 };
  }

  // Diagnóstico temporal: el freno cuenta por `req.ip`, y detrás del proxy de
  // Railway no está confirmado que ese valor sea el del cliente y no el de un
  // salto intermedio. Si fuera lo segundo, un solo atacante bloquearía a todo
  // el mundo. Se registra la cadena cruda para poder decidirlo con datos.
  // Borrar en cuanto se sepa.
  console.warn(
    `[auth] PIN inválido | path=${req.path} ip=${req.ip ?? '?'} ` +
      `xff="${(req.headers['x-forwarded-for'] as string | undefined) ?? ''}"`
  );

  let hasta = 0;
  try {
    hasta = await registrarFallo(llave);
  } catch (e) {
    // Si no se pudo contar el fallo, igual se RECHAZA. Falla cerrado: perder la
    // cuenta no puede convertirse en dejar pasar.
    console.error(`[auth] no se pudo registrar el fallo: ${(e as Error).message}`);
  }

  if (hasta > Date.now()) {
    return { estado: 'bloqueado', esperaSeg: Math.ceil((hasta - Date.now()) / 1000) };
  }
  return { estado: 'invalido', esperaSeg: 0 };
}

/** Para la API: responde 401 en JSON. */
export function requierePin(req: Request, res: Response, next: NextFunction): void {
  void revisar(req).then((r) => {
    if (r.estado === 'ok') {
      next();
      return;
    }
    if (r.estado === 'bloqueado') {
      res.status(429).json({
        error: 'demasiados_intentos',
        message: `Demasiados intentos. Espera ${r.esperaSeg}s.`,
      });
      return;
    }
    res.status(401).json({ error: 'pin_invalido', message: 'PIN incorrecto o sesión expirada.' });
  });
}

/**
 * Para las páginas: en vez de un 401 en JSON devuelve la pantalla de PIN.
 *
 * La pantalla va embebida acá y no como archivo en `public/` a propósito: si
 * viviera ahí, `express.static` la serviría junto al resto y habría que
 * exceptuarla del candado — una excepción de más en la puerta que estamos
 * cerrando.
 */
export function requierePinODaPantalla(req: Request, res: Response, next: NextFunction): void {
  // Pasa por `revisar`, igual que la API, y no por `pinValido` a secas.
  //
  // Con `pinValido` esta puerta no contaba intentos ni bloqueaba NUNCA: un
  // script podía pedir /kds.html con una cookie distinta cada vez y recorrer el
  // espacio completo del PIN sin ningún freno —horas, no meses— distinguiendo
  // el acierto por el 200 contra el 401. El mismo ataque contra /api/kds/* se
  // bloqueaba a los 5 intentos. O sea: el candado documentado estaba abierto por
  // la otra puerta, y detrás están los reportes con nombre, teléfono y valor
  // total de cada cliente.
  //
  // Una navegación con cookie VÁLIDA sigue sin gastar cupo — `revisar` limpia
  // los fallos al acertar, así que la cocina puede abrir la pantalla las veces
  // que quiera.
  void revisar(req).then((r) => {
    if (r.estado === 'ok') {
      next();
      return;
    }
    if (r.estado === 'bloqueado') {
      // 429 y no la pantalla de PIN: si se la devolviéramos, quien está
      // bloqueado seguiría viendo una caja de texto que ya no sirve, y volvería
      // a teclear.
      res
        .status(429)
        .type('html')
        .send(
          `<!doctype html><html lang="es"><head><meta charset="utf-8" />` +
            `<title>Epazote — Espera</title><meta name="viewport" content="width=device-width, initial-scale=1" />` +
            `<style>body{background:#EDE6DC;color:#181410;font-family:system-ui,sans-serif;display:flex;` +
            `align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}` +
            `p{font-size:22px;line-height:1.5}</style></head><body>` +
            `<p>Demasiados intentos.<br />Espera ${r.esperaSeg} segundos y vuelve a intentar.</p></body></html>`
        );
      return;
    }
    res.status(401).type('html').send(PANTALLA_PIN);
  });
}

const PANTALLA_PIN = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>Epazote — Mesa de Control</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link href="https://fonts.googleapis.com/css2?family=Teko:wght@500&family=Barlow:wght@400;600&display=swap" rel="stylesheet" />
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; color:#2A1C1B;
         background:#A33538 url('/mesa/marca/estuco.jpg') center / 600px; background-blend-mode:multiply;
         font-family:'Barlow',system-ui,-apple-system,sans-serif; }
  .caja { width:min(380px,90vw); text-align:center; }
  .caja img { width:min(300px,78vw); display:block; margin:0 auto 26px; }
  .tarjeta { background:#fff; border-radius:18px; padding:22px 20px 18px; box-shadow:0 18px 40px -18px rgba(0,0,0,.45); }
  h1 { font:500 1.6rem/1 'Teko',sans-serif; letter-spacing:.14em; text-transform:uppercase; color:#A33538; margin:4px 0 6px; }
  p.ayuda { color:#7C6C6A; margin:0 0 18px; font-size:.95rem; }
  input { width:100%; box-sizing:border-box; font:500 2.4rem/1 'Teko',sans-serif; text-align:center; letter-spacing:.45em;
          padding:.6rem .4rem .35rem; border-radius:12px; border:1.5px solid #ECDDDB; background:#FBF8F6; color:#2A1C1B; }
  input:focus { outline:none; border-color:#A33538; background:#fff; }
  button { width:100%; margin-top:14px; padding:.95rem; font:600 1.05rem 'Barlow',sans-serif;
           border:0; border-radius:12px; background:#0B8135; color:#fff; cursor:pointer; }
  .error { color:#A33538; margin:12px 0 0; font-size:.9rem; min-height:1.2em; }
</style>
</head>
<body>
<div class="caja">
  <img src="/mesa/marca/logo-blanco.png" alt="Epazote, Atmósfera culinaria" />
  <div class="tarjeta">
  <h1>Mesa de Control</h1>
  <p class="ayuda">Escribe el PIN. Solo se pide una vez en este dispositivo.</p>
  <input id="pin" type="password" inputmode="numeric" autocomplete="off" autofocus />
  <button id="entrar">Entrar</button>
  <p class="error" id="error"></p>
  </div>
</div>
<script>
(function () {
  var input = document.getElementById("pin");
  var error = document.getElementById("error");
  var boton = document.getElementById("entrar");

  function entrar() {
    var pin = input.value.trim();
    if (!pin) return;
    boton.disabled = true;
    error.textContent = "Verificando...";
    // Se valida contra la API ANTES de guardar la cookie: si no, un PIN
    // equivocado quedaba guardado y la pantalla entraba en ciclo de recargas.
    fetch("/api/mesa/ping", { headers: { "x-mesa-pin": pin } })
      .then(function (res) {
        if (res.status === 429) {
          return res.json().then(function (d) { throw new Error(d.message || "Demasiados intentos."); });
        }
        if (!res.ok) throw new Error("PIN incorrecto.");
        // Secure solo bajo https: en http (desarrollo local) el navegador
        // descartaría la cookie y la pantalla quedaría pidiendo el PIN en ciclo.
        var seguro = location.protocol === "https:" ? "; Secure" : "";
        document.cookie =
          "mesa_pin=" + encodeURIComponent(pin) + "; max-age=31536000; path=/; SameSite=Lax" + seguro;
        location.reload();
      })
      .catch(function (err) {
        boton.disabled = false;
        error.textContent = err.message || "PIN incorrecto.";
        input.value = "";
        input.focus();
      });
  }

  boton.addEventListener("click", entrar);
  input.addEventListener("keydown", function (ev) { if (ev.key === "Enter") entrar(); });
})();
</script>
</body>
</html>`;
