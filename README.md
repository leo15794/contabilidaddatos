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
3. Deploy.

### 4. Crear las tablas en la base de producción

Una sola vez, desde tu máquina, apuntando a la base de Neon:

```bash
DATABASE_URL="<la-connection-string-de-neon>" npm run db:push
```

### 5. Entrar

Abrí la URL que te dio Vercel, ingresá con la contraseña que elegiste en el
paso 3, y ya está — desde ahí es "Importar" y subir los primeros archivos.

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
- `src/proxy.ts` — protege todas las rutas salvo `/login` (Next.js 16 renombró
  `middleware.ts` a `proxy.ts`).

Próximos pasos naturales cuando esto esté rodando un tiempo: afinar el parser
de tarjeta con PDFs reales, y más adelante reemplazar la exportación manual de
AFIP por integración directa vía Web Services (requiere certificado digital),
que es el último tramo hacia la automatización completa.
