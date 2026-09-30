/**
 * Cliente mínimo para mandar la respuesta por WhatsApp a través de la API de
 * OpenWA (el gateway self-hosted que corre en el VPS, no en Vercel).
 *
 * OpenWA no reenvía nada de lo que devolvemos en la respuesta HTTP del
 * webhook — para contestarle al que mandó el ticket hay que hacer un POST
 * aparte a su endpoint de envío de texto.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}.`);
  }
  return value;
}

/**
 * Manda un mensaje de texto por WhatsApp usando la sesión configurada en
 * OpenWA. No lanza si falla la llamada (fire-and-forget con log) porque un
 * error acá no debe hacer fallar el guardado del ticket, que ya ocurrió.
 */
export async function sendOpenWaText(chatId: string, text: string): Promise<void> {
  let openwaUrl: string;
  let apiKey: string;
  let sessionId: string;

  try {
    openwaUrl = requireEnv("OPENWA_URL").replace(/\/$/, "");
    apiKey = requireEnv("OPENWA_API_KEY");
    sessionId = requireEnv("OPENWA_SESSION_ID");
  } catch (err) {
    console.error("[tickets/ingest] No se pudo armar la respuesta por WhatsApp:", err);
    return;
  }

  try {
    const res = await fetch(`${openwaUrl}/api/sessions/${sessionId}/messages/send-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ chatId, text }),
    });

    if (!res.ok) {
      console.error(
        "[tickets/ingest] OpenWA respondió con error al mandar la respuesta:",
        res.status,
        await res.text(),
      );
    }
  } catch (err) {
    console.error("[tickets/ingest] Error de red mandando la respuesta por OpenWA:", err);
  }
}
