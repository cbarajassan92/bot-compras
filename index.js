/**
 * ============================================================
 * BOT DE COMPRAS — Telegram + Google Sheets
 * ============================================================
 *
 * OBJETIVO
 * --------
 * Registrar compras en una hoja de Google Sheets de forma segura
 * usando Telegram como interfaz.
 *
 * El bot NO guarda automáticamente: primero pide confirmación.
 *
 * ------------------------------------------------------------
 * SINTAXIS OFICIAL DEL COMANDO
 * ------------------------------------------------------------
 * /compra <monto> <meses> <banco> <descripción>
 *
 * Ejemplo:
 * /compra 9000 12 rappicard Pantalla Samsung 85
 *
 * Reglas:
 * - El banco se guarda automáticamente en MAYÚSCULAS
 * - La fecha se guarda como DD/MM/YYYY
 * - Cálculos (restante, pago x mes, fechas) se hacen en Sheets
 *
 * ------------------------------------------------------------
 * FLUJO GENERAL
 * ------------------------------------------------------------
 * 1) Usuario envía /compra ...
 * 2) Bot valida y normaliza datos
 * 3) Bot muestra PREVIEW + botones:
 *    ✅ Confirmar
 *    ❌ Cancelar
 * 4) Solo al confirmar se inserta la fila en Google Sheets
 *
 * ------------------------------------------------------------
 * ORDEN DE COLUMNAS EN GOOGLE SHEETS (A:K)
 * ------------------------------------------------------------
 * A DESCRIPCION DE LA COMPRA
 * B TITULAR
 * C F. COMPRA
 * D ESTATUS
 * E MONTO
 * F RESTANTE        (fórmula en Sheet)
 * G MESES
 * H BANCO
 * I PAGO X MES      (fórmula en Sheet)
 * J F. INICIO       (fórmula en Sheet)
 * K F. FIN          (fórmula en Sheet)
 * ============================================================
 */

require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

/* ============================================================
 * CONFIGURACIÓN Y VARIABLES DE ENTORNO
 * ============================================================
 */

// Token del bot de Telegram
const BOT_TOKEN = process.env.BOT_TOKEN;

// ID del Google Spreadsheet
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// Nombre de la pestaña (tab) donde se insertan las compras
const SHEET_NAME = process.env.SHEET_NAME || "LISTADOCOMPRAS";

// Ruta al archivo de credenciales del Service Account
// - En Windows (desarrollo local): ./service-account.json
// - En Linux/Railway (producción): /tmp/service-account.json
const GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  (process.platform === "win32"
    ? path.join(__dirname, "service-account.json")
    : "/tmp/service-account.json");

// Validaciones críticas al iniciar
if (!BOT_TOKEN) throw new Error("Falta BOT_TOKEN");
if (!SPREADSHEET_ID) throw new Error("Falta SPREADSHEET_ID");

// Logs informativos de arranque
console.log("🚀 Starting Container");
console.log("🔎 SPREADSHEET_ID existe:", !!SPREADSHEET_ID);
console.log("🔎 SHEET_NAME:", SHEET_NAME);
console.log("🔎 BOT_TOKEN existe:", !!BOT_TOKEN);
console.log("🔎 Credenciales:", GOOGLE_APPLICATION_CREDENTIALS);

/* ============================================================
 * HELPERS / FUNCIONES UTILITARIAS
 * ============================================================
 */

/**
 * Retorna la fecha actual en formato DD/MM/YYYY
 * Ejemplo: 10/01/2026
 *
 * NO se usa toLocaleDateString para evitar diferencias
 * entre sistemas operativos o configuraciones regionales.
 */
function formatDateDMY(date = new Date()) {
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

/**
 * Parsea y valida el texto del comando /compra
 *
 * Entrada esperada:
 * /compra <monto> <meses> <banco> <descripción>
 *
 * Devuelve:
 * {
 *   amount: Number,
 *   months: Number,
 *   bank: String,
 *   description: String
 * }
 *
 * Si el formato es inválido → retorna null
 */
function parseCompraCommand(text) {
  const normalized = text.trim();
  const withoutCommand = normalized.replace(/^\/compra(@\w+)?\s*/i, "");
  const parts = withoutCommand.split(/\s+/).filter(Boolean);

  // Se requieren al menos 4 partes
  if (parts.length < 4) return null;

  // Limpieza de símbolos ($ y comas)
  const amountRaw = parts[0].replace(/[$,]/g, "");
  const monthsRaw = parts[1].replace(/,/g, "");

  const amount = Number(amountRaw);
  const months = Number(monthsRaw);
  const bank = parts[2];
  const description = parts.slice(3).join(" ");

  // Validaciones duras
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (!Number.isInteger(months) || months <= 0 || months > 60) return null;
  if (!bank || !description) return null;

  return { amount, months, bank, description };
}

/* ============================================================
 * GOOGLE SHEETS CLIENT
 * ============================================================
 */

/**
 * Crea y retorna el cliente de Google Sheets
 * usando Service Account.
 *
 * Lanza error si:
 * - No existe el archivo de credenciales
 * - El JSON es inválido
 */
function getSheetsClient() {
  if (!fs.existsSync(GOOGLE_APPLICATION_CREDENTIALS)) {
    throw new Error(
      `No existe el archivo de credenciales en: ${GOOGLE_APPLICATION_CREDENTIALS}`
    );
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

/**
 * Inicialización GLOBAL del cliente de Sheets.
 *
 * Se hace una sola vez para:
 * - Evitar crear el cliente en cada confirmación
 * - Evitar errores de "usar antes de inicializar"
 */
let sheets = null;
try {
  sheets = getSheetsClient();
  console.log("✅ Google Sheets client listo");
} catch (e) {
  console.error("❌ No se pudo inicializar Google Sheets:", e.message);
}

/* ============================================================
 * MANEJO DE COMPRAS PENDIENTES (CONFIRMACIÓN)
 * ============================================================
 *
 * Se usa un Map en memoria:
 * key   = `${chatId}:${userId}`
 * value = { data, createdAt }
 *
 * Esto permite:
 * - Que cada usuario confirme SOLO su compra
 * - Que la última compra enviada sea la válida
 */

const pendingPurchases = new Map();
const PENDING_TTL_MS = 3 * 60 * 1000; // 3 minutos

/* ============================================================
 * BOT TELEGRAM
 * ============================================================
 */

const bot = new Telegraf(BOT_TOKEN);

/**
 * /start
 * Muestra instrucciones básicas de uso
 */
bot.start((ctx) => {
  ctx.reply(
    "🤖 Bot de Compras activo\n\n" +
      "📌 Sintaxis:\n" +
      "/compra <monto> <meses> <banco> <descripción>\n\n" +
      "🧾 Ejemplo:\n" +
      "/compra 9000 12 rappicard Pantalla Samsung 85\n\n" +
      "ℹ️ Notas:\n" +
      "- El banco se guarda en MAYÚSCULAS\n" +
      "- Los cálculos se hacen en Google Sheets"
  );
});

/**
 * /version
 * Útil para saber qué build está corriendo (dev/prod)
 */
const VERSION = process.env.VERSION || "2026-02-01-01";
bot.command("version", (ctx) => ctx.reply(`Bot version: ${VERSION}`));

/* ============================================================
 * COMANDO /compra → PREVIEW + CONFIRMACIÓN
 * ============================================================
 */

bot.hears(/^\/compra(\@\w+)?\s+/i, async (ctx) => {
  try {
    const parsed = parseCompraCommand(ctx.message.text);

    // Si el formato no es válido, se corta el flujo
    if (!parsed) {
      return ctx.reply(
        "❌ Formato inválido.\n\n" +
          "📌 Sintaxis:\n/compra <monto> <meses> <banco> <descripción>\n\n" +
          "🧾 Ejemplo:\n/compra 9000 12 rappicard Pantalla Samsung 85"
      );
    }

    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const key = `${chatId}:${userId}`;

    // Normalización de datos
    const purchaseData = {
      date: formatDateDMY(),
      amount: parsed.amount,
      months: parsed.months,
      bank: parsed.bank.toUpperCase(),
      description: parsed.description,
      user: ctx.from.first_name || "Usuario",
    };

    // Se guarda como compra pendiente
    pendingPurchases.set(key, {
      data: purchaseData,
      createdAt: Date.now(),
    });

    // Mensaje de previsualización
    const preview =
      `🧾 *Confirmar compra*\n\n` +
      `📌 *${purchaseData.description}*\n` +
      `💰 Monto: *$${purchaseData.amount}*\n` +
      `🗓️ Meses: *${purchaseData.months}*\n` +
      `🏦 Banco: *${purchaseData.bank}*\n` +
      `👤 Titular: *${purchaseData.user}*\n` +
      `📅 F. compra: *${purchaseData.date}*`;

    await ctx.replyWithMarkdown(
      preview,
      Markup.inlineKeyboard([
        Markup.button.callback("✅ Confirmar", "confirm_purchase"),
        Markup.button.callback("❌ Cancelar", "cancel_purchase"),
      ])
    );
  } catch (err) {
    console.error("Error /compra:", err);
    ctx.reply("❌ Ocurrió un error preparando la compra.");
  }
});

/* ============================================================
 * CONFIRMAR COMPRA → INSERTAR EN GOOGLE SHEETS
 * ============================================================
 */

bot.action("confirm_purchase", async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const key = `${chatId}:${userId}`;

    const pending = pendingPurchases.get(key);
    if (!pending) {
      await ctx.answerCbQuery("No hay una compra pendiente.");
      return;
    }

    // Verifica expiración
    if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
      pendingPurchases.delete(key);
      await ctx.editMessageText("⏱️ Esta confirmación expiró.");
      await ctx.answerCbQuery();
      return;
    }

    // Verifica que Sheets esté disponible
    if (!sheets) {
      await ctx.editMessageText("❌ Google Sheets no está listo.");
      await ctx.answerCbQuery();
      return;
    }

    const purchase = pending.data;

    // Inserción alineada EXACTAMENTE a A:K
    const values = [[
      purchase.description,
      purchase.user,
      purchase.date,
      "ACTIVA",
      purchase.amount,
      "",
      purchase.months,
      purchase.bank,
      "",
      "",
      "",
    ]];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:K`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values },
    });

    pendingPurchases.delete(key);

    await ctx.editMessageText("✅ Compra guardada exitosamente.");
    await ctx.answerCbQuery();
  } catch (err) {
    console.error("Error confirm_purchase:", err);
    await ctx.editMessageText("❌ Error al guardar la compra.");
    await ctx.answerCbQuery();
  }
});

/* ============================================================
 * CANCELAR COMPRA
 * ============================================================
 */

bot.action("cancel_purchase", async (ctx) => {
  const key = `${ctx.chat.id}:${ctx.from.id}`;
  pendingPurchases.delete(key);
  await ctx.editMessageText("❌ Compra cancelada.");
  await ctx.answerCbQuery();
});

/* ============================================================
 * LIMPIEZA AUTOMÁTICA DE PENDIENTES EXPIRADOS
 * ============================================================
 */

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingPurchases.entries()) {
    if (now - v.createdAt > PENDING_TTL_MS) {
      pendingPurchases.delete(k);
    }
  }
}, 30 * 1000);

/* ============================================================
 * ARRANQUE DEL BOT
 * ============================================================
 */

bot.launch()
  .then(() => console.log("🚀 Bot iniciado correctamente"))
  .catch((err) => console.error("❌ Error iniciando bot:", err));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
