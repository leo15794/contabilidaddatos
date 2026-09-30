# Conciliación — 2 Datos y Mercadeo

Sistema de conciliación automática de ingresos y egresos: importa movimientos
bancarios, resúmenes de tarjeta de crédito y facturas de AFIP, y los cruza
automáticamente.

## Cómo funciona

1. **Importar** (`/import`): subís los archivos de cada fuente.
   - **AFIP**: el CSV que se exporta desde "Mis Comprobantes" (emitidas y
     recibidas por separado).
   - **Banco**: CSV del homebanking. La primera vez que usás un banco nuevo,
     la app te pide mapear qué columna es la fecha, la descripción y el
     importe (o débito/crédito si vienen separados).
   - **Tarjeta**: el PDF del resumen. ⚠️ Este parser es best-effort — ver
     sección de abajo.
2. Cada importación dispara el **motor de conciliación** automáticamente, que
   intenta cruzar cada movimiento con su contraparte en otra fuente:
   - Match exacto 1 a 1 (mismo importe, fechas cercanas, fuentes distintas).
   - Consumos de tarjeta de un mismo resumen sumados contra el pago bancario
     de ese resumen.
   - Sugerencias "fuzzy" (importe parecido + texto parecido) que quedan para
     que las confirmes o rechaces a mano — nunca se confirman solas.
3. **Revisión** (`/review`): ahí están las sugerencias para confirmar/rechazar,
   y los movimientos que no matchearon con nada, para unirlos manualmente.
4. **Dashboard** (`/dashboard`): totales de ingresos/egresos, % conciliado, y
   el historial de importaciones.
5. **Agente de WhatsApp** (opcional, ver sección abajo): los dueños mandan una
   foto del ticket/comprobante por WhatsApp y se carga solo como un gasto más,
   comparado automáticamente contra las facturas de AFIP.

## ⚠️ Pendiente de ajustar: parser de resúmenes de tarjeta

Los PDF de resumen de tarjeta tienen un layout distinto en cada banco/emisor
(Visa, Mastercard, cada banco arma el suyo). El parser en
`src/lib/parsers/card-pdf.ts` busca líneas con forma
`fecha  descripción  importe` con una expresión regular genérica — funciona
bien en resúmenes con formato simple, pero es muy probable que el primer PDF
real de Leo no calce perfectamente.

Cuando eso pase: subí igual el PDF (no importa si no detecta nada, no rompe
nada), y avisame. Con ese archivo como referencia se ajusta la regex o se
escribe un adaptador específico para ese emisor en un rato.

## Desarrollo local

```bash
npm install
cp .env.example .env.local   # completar DATABASE_URL, AUTH_SECRET, APP_PASSWORD_HASH
npm run hash-password "tu-contraseña"   # pegar el resultado en APP_PASSWORD_HASH
npm run db:push              # crea las tablas en la base
npm run dev
```

## Deploy (Vercel + Neon)

Estos pasos hay que hacerlos con tu cuenta — no los puedo hacer yo desde acá.

### 1. Crear la base de datos (Neon, gratis para este volumen)

1. Entrá a [neon.tech](https://neon.tech) y creá una cuenta (podés entrar con
   GitHub).
2. Creá un proyecto nuevo. Neon te da una `DATABASE_URL` lista para copiar
   (botón "Connection string") — guardala, la vas a necesitar en el paso 3.

_Alternativas equivalentes: Supabase o Vercel Postgres, si preferís. Cualquiera
de las tres sirve, solo cambia de dónde sacás la `DATABASE_URL`._

### 2. Subir el código a GitHub

```bash
cd conciliacion-2dym
git add -A
git commit -m "Primera versión del sistema de conciliación"
```

Creá un repo nuevo en GitHub (puede ser privado) y pusheá:

```bash
git remote add origin <url-de-tu-repo>
git push -u origin main
```

### 3. Conectar a Vercel

1. Entrá a [vercel.com](https://vercel.com) con tu cuenta (o creá una con
   GitHub) e importá el repositorio.
2. Antes de darle "Deploy", andá a **Settings → Environment Variables** y
   cargá:
   - `DATABASE_URL`: la que te dio Neon en el paso 1.
   - `AUTH_SECRET`: una cadena aleatoria larga. Se genera con
     `openssl rand -base64 32` en cualquier terminal.
   - `APP_PASSWORD_HASH`: corré `npm run hash-password "la-contraseña-que-quieras"`
     en tu máquina y pegá el resultado (no la contraseña en texto plano).
   - Si vas a usar el agente de WhatsApp (podés sumarlo después, no hace
     falta ahora): `ANTHROPIC_API_KEY`, `OPENWA_URL`, `OPENWA_API_KEY`,
     `OPENWA_SESSION_ID`, `OPENWA_WEBHOOK_SECRET`, `WHATSAPP_ALLOWED_NUMBERS`
     — ver la sección "Agente de WhatsApp para tickets" más abajo.
3. Deploy.

### 4. Crear las tablas en la base de producción

Una sola vez, desde tu máquina, apuntando a la base de Neon:

```bash
DATABASE_URL="<la-connection-string-de-neon>" npm run db:push
```

### 5. Entrar

Abrí la URL que te dio Vercel, ingresá con la contraseña que elegiste en el
paso 3, y ya está — desde ahí es "Importar" y subir los primeros archivos.

## Agente de WhatsApp para tickets

Los dueños mandan una foto del ticket/factura por WhatsApp y el sistema:
1. Verifica que el número sea uno autorizado (lista blanca).
2. Le pide a Claude que lea la foto y extraiga fecha, importe, comercio y CUIT.
3. Si la lectura salió clara, carga el gasto como una transacción más (fuente
   "Ticket (WhatsApp)") y corre la conciliación automática — si ya había una
   factura de AFIP cargada con ese importe y fecha, quedan unidas solas.
4. Si la foto está borrosa o falta un dato clave, no carga nada: le responde a
   quien mandó el ticket pidiendo una foto más clara, en vez de meter datos
   dudosos a la contabilidad.
5. Si el ticket no tiene factura asociada después de 3 días, aparece contado
   en el dashboard como "gastos sin factura" — para poder reclamarla a tiempo.

No se guarda la foto en sí, solo los datos que se extrajeron de ella (se puede
sumar más adelante si hace falta guardar el comprobante visual).

**Importante sobre este canal**: en vez de la WhatsApp Cloud API oficial de
Meta (que exige migrar o vincular un número de negocio nuevo), este agente
usa tu WhatsApp normal a través de **OpenWA**, un gateway self-hosted de
código abierto que simula una sesión de WhatsApp Web. Esto significa que no
hay que dar de alta nada con Meta, pero también que **viola los términos de
servicio de WhatsApp** — el riesgo real es que el número quede bloqueado en
algún momento, o que deje de andar si WhatsApp cambia algo internamente. Con
el volumen de este caso (algunos tickets sueltos por día) el riesgo es bajo,
y ya lo charlamos y lo aceptamos: no es algo que vaya a pasar por sorpresa.

OpenWA necesita un proceso corriendo 24/7 (como WhatsApp Web, que no se puede
cerrar) — no entra en Vercel, que es serverless. Por eso corre aparte, en un
VPS barato.

### Setup (con tus cuentas — esto no lo puedo hacer yo)

**1. API key de Anthropic** (para que el agente pueda "leer" las fotos):

- Entrá a [console.anthropic.com](https://console.anthropic.com/settings/keys),
  creá una API key y activá billing (el costo por ticket leído es mínimo,
  centavos de dólar).
- Esa key va en `ANTHROPIC_API_KEY`.

**2. Un VPS barato para OpenWA:**

- Recomiendo [Hetzner](https://www.hetzner.com/cloud/) (plan CX22, 2GB RAM,
  ~€4-5/mes) o un droplet de 2GB de [DigitalOcean](https://www.digitalocean.com/)
  (~6 USD/mes). Con el motor `baileys` (liviano, ~30-80MB por sesión) y la
  base de datos SQLite que trae OpenWA por defecto, un servidor de 2GB alcanza
  sobrando — no hace falta nada más grande ni una base de datos aparte.
- Instalá Docker en el VPS (en Ubuntu: `curl -fsSL https://get.docker.com | sh`).

**3. Levantar OpenWA:**

1. Subí la carpeta `openwa/` de este repo al VPS (o cloná el repo entero ahí
   y quedate solo con esa carpeta).
2. Copiá `openwa/.env.example` a `openwa/.env` y descomentá
   `ENGINE_TYPE=baileys`.
3. Arrancalo:
   ```bash
   cd openwa
   docker compose -f docker-compose.dev.yml up -d
   ```
4. En el primer arranque, OpenWA genera solo una API key de administrador:
   mirala en el banner de arranque (`docker compose -f docker-compose.dev.yml logs`)
   o leé el archivo `data/.api-key` dentro del contenedor. Esa es tu
   `OPENWA_API_KEY` para Vercel.
5. Entrá al dashboard (`http://<ip-del-vps>:2785`) con esa key, creá una
   sesión, y escaneá el código QR con el WhatsApp que van a usar para mandar
   los tickets (**WhatsApp → Dispositivos vinculados → Vincular un
   dispositivo**). El nombre que le pongas a la sesión es tu
   `OPENWA_SESSION_ID`.
6. Desde el dashboard (o la API), creá un webhook para esa sesión:
   - URL: `https://<tu-dominio>.vercel.app/api/tickets/ingest`
   - Eventos: `message.received`
   - Secret: cualquier string aleatorio largo (`openssl rand -hex 32`) — ese
     mismo valor va en `OPENWA_WEBHOOK_SECRET` en Vercel.

**4. Completar las variables en Vercel:**

- `OPENWA_URL`: la URL pública de tu VPS (`http://<ip>:2785`, o mejor un
  dominio con HTTPS si le ponés un proxy tipo Caddy/Nginx delante).
- `OPENWA_API_KEY`: la API key del paso 3.4.
- `OPENWA_SESSION_ID`: el nombre de la sesión del paso 3.5.
- `OPENWA_WEBHOOK_SECRET`: el secret del webhook del paso 3.6.
- `WHATSAPP_ALLOWED_NUMBERS`: teléfonos de los dueños autorizados a mandar
  tickets, separados por coma, en formato internacional sin "+" (ej.
  `5493411234567,5493413456789`).

Con todo eso cargado, ya podés mandarle una foto de un ticket al WhatsApp
vinculado desde uno de los teléfonos autorizados.

## Nota sobre el tamaño de los PDF

Vercel limita el tamaño del request a las funciones serverless (en el plan
gratuito, ~4.5 MB). Si algún resumen de tarjeta en PDF pesa más que eso, la
importación de ese archivo va a fallar — avisame si pasa y lo resolvemos
(comprimiendo el PDF, o subiéndolo directo a un storage antes de procesarlo).

## Arquitectura (por si hay que tocar algo)

- `src/db/schema.ts` — tablas: `transactions` (todo movimiento normalizado),
  `import_batches` (cada archivo subido), `matches`/`match_items`
  (agrupaciones de conciliación).
- `src/lib/parsers/` — un parser por fuente (`afip-csv.ts`, `bank-csv.ts`,
  `card-pdf.ts`), todos devuelven filas en el mismo formato.
- `src/lib/matching/engine.ts` — el motor de conciliación, 3 estrategias en
  cascada (exacta 1-a-1, tarjeta 1-a-N, fuzzy).
- `src/app/import`, `src/app/dashboard`, `src/app/review` — las 3 pantallas.
- `src/app/api/whatsapp/webhook/route.ts` — recibe los mensajes de WhatsApp.
- `src/lib/whatsapp/` — cliente de la Graph API de Meta y verificación de
  firma del webhook.
- `src/lib/tickets/extract.ts` — llamada a Claude para leer la foto del
  ticket.
- `src/proxy.ts` — protege todas las rutas salvo `/login` y `/api/whatsapp`
  (Next.js 16 renombró `middleware.ts` a `proxy.ts`).

Próximos pasos naturales cuando esto esté rodando un tiempo: afinar el parser
de tarjeta con PDFs reales, subir el agente de WhatsApp a producción real (no
solo el número de prueba de Meta, que tiene el límite de 5 destinatarios), y
más adelante reemplazar la exportación manual de AFIP por integración directa
vía Web Services (requiere certificado digital), que es el último tramo hacia
la automatización completa.
