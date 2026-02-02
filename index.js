require('dotenv').config();

const fs = require('fs');
const path = require('path');
const os = require('os');
const { google } = require('googleapis');
const { Telegraf } = require('telegraf');

// ------------------ CONFIG ------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'LISTADOCOMPRAS';

// ------------------ CREDS (LOCAL FILE OR RAILWAY JSON) ------------------
function ensureCredsFile() {
  // 1) Prefer env var with file path (LOCAL)
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (envPath && String(envPath).trim() !== '') {
    const abs = path.isAbsolute(envPath) ? envPath : path.resolve(process.cwd(), envPath);
    if (!fs.existsSync(abs)) {
      throw new Error(`GOOGLE_APPLICATION_CREDENTIALS apunta a un archivo que no existe:\n${abs}`);
    }
    return abs;
  }

  // 2) Else use JSON content variable (RAILWAY)
  const json = process.env.GOOGLE_SA_JSON;
  if (json && String(json).trim() !== '') {
    const credsPath = path.join(os.tmpdir(), 'service-account.json');
    fs.writeFileSync(credsPath, json);
    return credsPath;
  }

  // 3) Fallback: local file named service-account.json in project root
  const fallback = path.resolve(process.cwd(), 'service-account.json');
  if (fs.existsSync(fallback)) return fallback;

  throw new Error(
    `Faltan credenciales.\n` +
    `Define GOOGLE_APPLICATION_CREDENTIALS (ruta al JSON) o GOOGLE_SA_JSON (contenido del JSON).\n` +
    `También puedes poner service-account.json en la raíz del proyecto (solo local).`
  );
}

const CREDS_FILE = ensureCredsFile();

// ------------------ GOOGLE AUTH ------------------
function getAuth() {
  return new google.auth.GoogleAuth({
    keyFile: CREDS_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

// ------------------ HELPERS ------------------
function fmt(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// ------------------ APPEND ROW (A:H ONLY) ------------------
async function guardarCompra({ monto, meses, banco, descripcion, titular }) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const fechaCompra = fmt(new Date());
  const estatus = 'ACTIVA';

  const row = [
    descripcion,         // A
    titular,             // B
    fechaCompra,         // C
    estatus,             // D
    monto,               // E
    '',                  // F (formula)
    meses,               // G
    banco.toUpperCase(), // H
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:H`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });

  console.log('✅ Compra guardada en Sheets (A:H)');
}

// ------------------ TELEGRAM BOT ------------------
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply(
    `🤖 *Bot de Compras activo*\n\n` +
    `📌 *Sintaxis:*\n` +
    `/compra <monto> <meses> <banco> <descripción>\n\n` +
    `📝 *Ejemplo:*\n` +
    `/compra 9000 12 rappicard Pantalla Samsung 85\n\n` +
    `ℹ️ Notas:\n` +
    `• El banco se guarda en MAYÚSCULAS automáticamente\n` +
    `• Fechas/pagos se calculan en Google Sheets\n`,
    { parse_mode: 'Markdown' }
  );
});

// Acepta: /compra, /Compra, /COMPRA, /compra@TuBot (cualquier mayúscula/minúscula)
bot.hears(/^\/compra(@\w+)?\b/i, async (ctx) => {
  try {
    const texto = (ctx.message?.text || '').trim();
    console.log('📩 Texto recibido:', texto);

    // Quita el comando (/compra o /compra@bot) y deja solo argumentos
    const argsText = texto.replace(/^\/compra(@\w+)?\s*/i, '').trim();

    // Separamos por espacios, pero conservando descripción con espacios
    const partes = argsText.split(' ').filter(Boolean);

    // Formato: monto meses banco descripcion...
    if (partes.length < 4) {
      return ctx.reply('❌ Formato incorrecto:\n/compra <monto> <meses> <banco> <descripción>\nEj: /compra 9000 12 rappicard Pantalla Samsung 85');
    }

    const monto = Number(partes[0]);
    const meses = Number(partes[1]);
    const banco = String(partes[2] || '').trim().toUpperCase();
    const descripcion = partes.slice(3).join(' ').trim();

    if (Number.isNaN(monto) || Number.isNaN(meses)) {
      return ctx.reply('❌ Monto y meses deben ser números');
    }
    if (!descripcion) {
      return ctx.reply('❌ Falta descripción');
    }

    const titular = ctx.from.first_name || ctx.from.username || 'SIN_NOMBRE';

    await guardarCompra({ monto, meses, banco, descripcion, titular });

    return ctx.reply(
      `✅ Compra guardada\n\n` +
      `🛒 ${descripcion}\n` +
      `🏷️ ${banco}\n` +
      `💰 $${monto}\n` +
      `📆 ${meses} meses\n` +
      `👤 ${titular}`
    );
  } catch (err) {
    console.error('❌ Error:', err);
    return ctx.reply('❌ Error guardando la compra (revisa consola)');
  }
});


bot.launch();
console.log('🚀 Bot iniciado correctamente');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
