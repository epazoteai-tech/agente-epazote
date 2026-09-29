#!/usr/bin/env bash
# ===========================================================================
# Sube el bot al repo de GitHub del CLIENTE, sin usar la cuenta de la agencia.
#
# Antes de correrlo, agrega estas dos líneas a .env (git lo ignora):
#
#   GITHUB_REPO=https://github.com/USUARIO-DEL-CLIENTE/bot-del-cliente.git
#   GITHUB_TOKEN=github_pat_...
#
# El token es un fine-grained PAT de la cuenta del CLIENTE, con acceso solo a
# ese repo y permiso "Contents: Read and write".
#
# El token nunca queda guardado en el remoto ni en el historial del shell.
# ===========================================================================
set -uo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$AQUI"

if [ -f .env ]; then set -a; . ./.env; set +a; fi

if [ -z "${GITHUB_REPO:-}" ] || [ -z "${GITHUB_TOKEN:-}" ]; then
  cat <<'AYUDA'
❌ Falta GITHUB_REPO o GITHUB_TOKEN en .env

Agrégalas así (ajusta el usuario del cliente):

  GITHUB_REPO=https://github.com/USUARIO-DEL-CLIENTE/bot-del-cliente.git
  GITHUB_TOKEN=github_pat_...

El token se saca en la cuenta del CLIENTE:
  Settings → Developer settings → Personal access tokens
  → Fine-grained tokens → Generate new token
  → Repository access: solo ese repo
  → Permissions → Repository permissions → Contents: Read and write
AYUDA
  exit 1
fi

# --- Validaciones antes de intentar el push -------------------------------
# Sin esto, un placeholder sin reemplazar o un token malo salen como un error
# genérico de git y se pierde media hora buscando dónde.

case "$GITHUB_REPO" in
  *USUARIO-DEL-CLIENTE*|*USUARIO*|*TU-USUARIO*)
    echo "❌ GITHUB_REPO todavía trae el texto de ejemplo sin reemplazar:"
    echo "   $GITHUB_REPO"
    echo
    echo "   Cambia la parte del usuario por el usuario real de GitHub del cliente."
    echo "   Se ve en la URL de su perfil: github.com/<ESE-ES-EL-USUARIO>"
    exit 1 ;;
esac

case "$GITHUB_REPO" in
  https://github.com/*/*.git) ;;
  https://github.com/*/*)
    GITHUB_REPO="${GITHUB_REPO%/}.git" ;;
  *)
    echo "❌ GITHUB_REPO no parece una URL de GitHub:"
    echo "   $GITHUB_REPO"
    echo "   Debe verse así: https://github.com/usuario/bot-del-cliente.git"
    exit 1 ;;
esac

# Pregunta a la API si el repo existe y si el token puede escribirle.
RUTA="${GITHUB_REPO#https://github.com/}"; RUTA="${RUTA%.git}"
echo "verificando $RUTA ..."
RESP="$(curl -sS -o /tmp/gh_check.json -w '%{http_code}'   -H "Authorization: Bearer ${GITHUB_TOKEN}"   -H "Accept: application/vnd.github+json"   -H "User-Agent: curl/8.4.0"   "https://api.github.com/repos/${RUTA}" 2>/dev/null)"

case "$RESP" in
  200)
    PUEDE_ESCRIBIR="$(python3 -c "import json;d=json.load(open('/tmp/gh_check.json'));print(d.get('permissions',{}).get('push',False))" 2>/dev/null)"
    if [ "$PUEDE_ESCRIBIR" = "True" ]; then
      echo "   ✅ el repo existe y el token puede escribirle"
    else
      echo "   ⚠️  el repo existe pero el token NO tiene permiso de escritura."
      echo "      En el token: Permissions → Repository permissions → Contents: Read and write"
      rm -f /tmp/gh_check.json; exit 1
    fi ;;
  401)
    echo "   ❌ el token no es válido o está mal copiado en .env"
    rm -f /tmp/gh_check.json; exit 1 ;;
  404)
    echo "   ❌ ese repo no existe, o el token no tiene acceso a él."
    echo "      Revisa que el usuario y el nombre del repo estén bien escritos,"
    echo "      y que en el token 'Repository access' incluya ESE repo."
    rm -f /tmp/gh_check.json; exit 1 ;;
  *)
    echo "   ⚠️  respuesta inesperada de GitHub (HTTP $RESP), intento el push de todos modos" ;;
esac
rm -f /tmp/gh_check.json
echo

# El remoto se guarda SIN el token. El token solo viaja en el push.
SIN_PROTO="${GITHUB_REPO#https://}"
CON_TOKEN="https://x-access-token:${GITHUB_TOKEN}@${SIN_PROTO}"

git remote remove origin 2>/dev/null
git remote add origin "$GITHUB_REPO"
echo "remoto configurado → $GITHUB_REPO"

RAMA="$(git symbolic-ref --short HEAD)"
echo "subiendo la rama '$RAMA' ($(git rev-list --count HEAD) commits)..."
echo

# OJO: el push va SIN -u. Con -u, git guarda la URL del push —token incluido—
# como `branch.<rama>.remote` en .git/config, en texto plano y para siempre.
# El upstream se arma abajo a mano, contra "origin", que sí está sin token.
if git push "$CON_TOKEN" "$RAMA":main 2>&1 | sed "s#${GITHUB_TOKEN}#***#g"; then
  # El ref remoto se trae con el token (el repo es privado) y solo entonces
  # se puede apuntar la rama a origin/main.
  git fetch "$CON_TOKEN" "+refs/heads/main:refs/remotes/origin/main" \
    >/dev/null 2>&1
  git config "branch.${RAMA}.remote" origin
  git config "branch.${RAMA}.merge" refs/heads/main
  echo
  echo "✅ Listo. El código ya está en el repo del cliente."
  echo "   Ahora en Railway: Deploy from GitHub repo → elige ese repo."
  echo
  echo "   Si Railway no lo ve en la lista, es que le falta acceso:"
  echo "   el cliente tiene que instalar la GitHub App de Railway en su cuenta"
  echo "   y darle acceso a ese repositorio."
else
  echo
  echo "❌ Falló el push. Causas típicas:"
  echo "   - El token no tiene 'Contents: Read and write' en ESE repo."
  echo "   - La URL de GITHUB_REPO está mal escrita."
  echo "   - El repo se creó con README y hay que hacer 'git pull --rebase' antes."
  exit 1
fi
