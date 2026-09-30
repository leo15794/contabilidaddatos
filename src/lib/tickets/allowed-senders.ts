/**
 * Teléfonos autorizados a mandar tickets (los dueños), desde
 * WHATSAPP_ALLOWED_NUMBERS — separados por coma, en formato internacional
 * sin '+' (ej: 5493411234567). Se usa tanto si el canal termina siendo la
 * Cloud API oficial como una librería no oficial (Baileys); no depende de
 * ningún proveedor en particular.
 */
export function isAllowedSender(phone: string): boolean {
  const raw = process.env.WHATSAPP_ALLOWED_NUMBERS ?? "";
  const allowed = raw
    .split(",")
    .map((n) => n.trim().replace(/\D/g, ""))
    .filter(Boolean);
  if (allowed.length === 0) return false;
  return allowed.includes(phone.replace(/\D/g, ""));
}
