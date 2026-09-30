#!/usr/bin/env node
// Uso: node scripts/hash-password.mjs "tu-contraseña"
// Imprime el hash bcrypt para pegar en APP_PASSWORD_HASH (.env.local o en Vercel).
import bcrypt from "bcryptjs";

const password = process.argv[2];
if (!password) {
  console.error('Uso: node scripts/hash-password.mjs "tu-contraseña"');
  process.exit(1);
}

console.log(bcrypt.hashSync(password, 10));
