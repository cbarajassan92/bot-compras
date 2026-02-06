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
 * 4) Confirmar:
 *    - Si el banco es CAPITAL o PRESTAMO -> guarda directo
 *    - Si el banco tiene ciclo (corte + límite):
 *        a) Calcula "días para pagar" estimados si compras HOY con ese banco.
 *        b) Calcula las mejores tarjetas para HOY según "más días para pagar".
 *        c) Si hay una alternativa significativamente mejor -> 2da confirmación (OK Guardar)
 *        d) Si no -> guarda directo
 * 5) Solo al confirmar final se inserta la fila en Google Sheets
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
 * CONFIG: CICLO DE TARJETAS (CORTE + FECHA LÍMITE)
 * ============================================================
 *
 * Esta sección es el "cerebro" financiero del bot.
 *
 * Queremos poder responder:
 * - Si compro HOY con X tarjeta, ¿cuántos días tengo para pagar?
 * - ¿Qué tarjeta me da más tiempo (financiamiento) para pagar?
 *
 * Datos por tarjeta:
 * - cutDay: día del mes en que cierra el estado de cuenta
 * - dueDay: día del mes en que vence el pago (fecha límite)
 * - dueOffset:
 *     0 => la fecha límite cae en el MISMO mes del corte
 *     1 => la fecha límite cae en el MES SIGUIENTE al corte
 *
 * Estos valores están basados en tu comportamiento real observado
 * (tabla del mes pasado).
 *
 * Importante:
 * - Las llaves están en MAYÚSCULAS porque el bot normaliza el banco.
 */
const CARD_CYCLE = {
  BBVA:        { cutDay: 24, dueDay: 13, dueOffset: 1 },
  RAPPICARD:   { cutDay: 6,  dueDay: 26, dueOffset: 0 },
  HSBC:        { cutDay: 16, dueDay: 5,  dueOffset: 1 },
  BANAMEX:     { cutDay: 6,  dueDay: 26, dueOffset: 0 },
  NU:          { cutDay: 7,  dueDay: 19, dueOffset: 0 },
  MERCADOPAGO: { cutDay: 13, dueDay: 23, dueOffset: 0 },
};

/**
 * Bancos que NO pasan por validación financiera/corte.
 * Caso típico:
 * - CAPITAL (puede ser gasto directo / ciclo distinto / no interesa analizar)
 * - PRESTAMO (no es tarjeta de crédito con corte/límite tradicional)
 *
 * Para estos:
 * - Se muestra preview
 * - Al confirmar se guarda directo
 */
const SKIP_CUT_VALIDATION = new Set(["CAPITAL", "PRESTAMO"]);

/**
 * Umbral mínimo para mostrar advertencia:
 * Si existe una tarjeta alternativa que te da >= X días extra para pagar,
 * el bot muestra una 2da confirmación recomendando esa(s) tarjeta(s).
 *
 * Ej:
 * - Elegiste BANAMEX (te da 10 días para pagar)
 * - BBVA te da 30 días para pagar
 * - Diferencia 20 >= 5 => advertimos con recomendación
 */
const IMPROVEMENT_THRESHOLD_DAYS = 5;

/* ============================================================
 * HELPERS / FUNCIONES UTILITARIAS
 * ============================================================
 */

/**
 * Retorna la fecha actual en formato DD/MM/YYYY
 * Ejemplo: 10/01/2026
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

/**
 * Devuelve una Date con hora 00:00:00 para cálculos por día.
 * Evita errores por horas/minutos (ej. si ya son las 23:59).
 */
function normalizeToDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Suma meses a una fecha.
 * Se usa para construir el "corte del siguiente mes" y el "límite del siguiente mes".
 */
function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Crea una fecha usando el mismo año/mes de baseDate, pero con un día específico.
 * Ej: baseDate=2026-02-05, day=24 => 2026-02-24
 */
function buildDateYMDay(baseDate, day) {
  const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), day);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Obtiene la fecha de corte "próxima" para HOY.
 * - Si HOY <= corte del mes => el próximo corte es este mismo mes
 * - Si HOY >  corte del mes => el próximo corte es el del siguiente mes
 */
function getNextCutDate(today, cutDay) {
  const cutThisMonth = buildDateYMDay(today, cutDay);
  if (today <= cutThisMonth) return cutThisMonth;
  return buildDateYMDay(addMonths(today, 1), cutDay);
}

/**
 * Calcula la ventana de pago (cuántos días tienes para pagar) si compras HOY.
 *
 * Retorna:
 * {
 *   cutDate: Date,   // próximo corte que aplicaría a una compra HOY
 *   dueDate: Date,   // fecha límite de pago asociada a ese corte
 *   daysToPay: Number,
 *   cfg: { cutDay, dueDay, dueOffset }
 * }
 *
 * Nota:
 * En bancos reales, el "posteo" de compra puede variar, pero aquí usamos
 * un modelo consistente basado en tu comportamiento pasado.
 */
function getPaymentWindow(bank, today = new Date()) {
  const cfg = CARD_CYCLE[bank];
  if (!cfg) return null;

  const t = normalizeToDay(today);
  const cutDate = getNextCutDate(t, cfg.cutDay);

  // La base del límite parte del mes del corte + dueOffset
  const dueBase = addMonths(cutDate, cfg.dueOffset);
  let dueDate = buildDateYMDay(dueBase, cfg.dueDay);

  // Protección por si quedara igual/antes al corte (casos raros)
  if (dueDate <= cutDate) {
    dueDate = buildDateYMDay(addMonths(dueBase, 1), cfg.dueDay);
  }

  const daysToPay = Math.max(
    0,
    Math.ceil((dueDate - t) / (1000 * 60 * 60 * 24))
  );

  return { cutDate, dueDate, daysToPay, cfg };
}

/**
 * Genera un ranking de tarjetas para HOY según "más días para pagar".
 * Devuelve una lista ordenada desc (mejor primero).
 */
function rankCardsByDaysToPay(today = new Date(), excludeBanks = []) {
  const ex = new Set(excludeBanks);
  const t = normalizeToDay(today);

  const result = Object.keys(CARD_CYCLE)
    .filter((bank) => !ex.has(bank))
    .map((bank) => {
      const w = getPaymentWindow(bank, t);
      return w ? { bank, ...w } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.daysToPay - a.daysToPay);

  return result;
}

/* ============================================================
 * RAILWAY: CREAR service-account.json DESDE ENV (si aplica)
 * ============================================================
 *
 * En producción (Railway/Linux) no existe el archivo físico
 * service-account.json a menos que lo generemos.
 *
 * Estrategia:
 * - Si existe la variable GOOGLE_SA_JSON:
 *   - La parseamos (para validar)
 *   - Corregimos saltos de línea del private_key si vienen escapados
 *   - Escribimos el archivo en /tmp/service-account.json
 *
 * Esto permite seguir usando GoogleAuth({ keyFile: ... })
 * sin cambiar el resto del código.
 */
function ensureServiceAccountFile() {
  // Solo tiene sentido en Linux/containers, pero no daña en Windows.
  const raw = process.env.GOOGLE_SA_JSON;
  if (!raw) return;

  try {
    const parsed = JSON.parse(raw);

    // Fix típico: private_key viene con "\\n" en vez de "\n"
    if (parsed.private_key && typeof parsed.private_key === "string") {
      parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    }

    // Creamos /tmp si hiciera falta (normalmente ya existe)
    fs.writeFileSync(GOOGLE_APPLICATION_CREDENTIALS, JSON.stringify(parsed, null, 2));
    console.log("✅ Credenciales escritas en:", GOOGLE_APPLICATION_CREDENTIALS);
  } catch (e) {
    console.error("❌ GOOGLE_SA_JSON inválido:", e.message);
  }
}

// Ejecutamos antes de inicializar Google Sheets
ensureServiceAccountFile();


/* ============================================================
 * GOOGLE SHEETS CLIENT
 * ============================================================
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

let sheets = null;
try {
  sheets = getSheetsClient();
  console.log("✅ Google Sheets client listo");
} catch (e) {
  console.error("❌ No se pudo inicializar Google Sheets:", e.message);
}

/**
 * Guarda una compra en Google Sheets respetando el orden A:K.
 * Se centraliza aquí para que confirm_purchase y confirm_purchase_ok
 * no dupliquen código.
 */
async function savePurchaseToSheets(purchase) {
  if (!sheets) throw new Error("Google Sheets no está listo.");

  const values = [[
    purchase.description, // A
    purchase.user,        // B
    purchase.date,        // C
    "ACTIVA",             // D
    purchase.amount,      // E
    "",                   // F (fórmulas)
    purchase.months,      // G
    purchase.bank,        // H
    "",                   // I (fórmulas)
    "",                   // J (fórmulas)
    "",                   // K (fórmulas)
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:K`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

/* ============================================================
 * MANEJO DE COMPRAS PENDIENTES (CONFIRMACIÓN)
 * ============================================================
 *
 * Se usa un Map en memoria:
 * key   = `${chatId}:${userId}`
 * value = { data, createdAt, stage }
 *
 * stage:
 * - "PREVIEW" => primera pantalla
 * - "WARNED"  => ya se mostró recomendación (2da confirmación)
 */
const pendingPurchases = new Map();
const PENDING_TTL_MS = 3 * 60 * 1000; // 3 minutos

/* ============================================================
 * BOT TELEGRAM
 * ============================================================
 */

const bot = new Telegraf(BOT_TOKEN);

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

const VERSION = process.env.VERSION || "2026-02-03-01";
bot.command("version", (ctx) => ctx.reply(`Bot version: ${VERSION}`));

/* ============================================================
 * COMANDO /compra → PREVIEW + CONFIRMACIÓN
 * ============================================================
 *
 * Aquí solo se prepara la compra y se solicita confirmación.
 * No se guarda nada todavía.
 *
 * Mejora: se incluye (si aplica) un cálculo de "días para pagar"
 * estimado para la tarjeta elegida.
 */
bot.hears(/^\/compra(\@\w+)?\s+/i, async (ctx) => {
  try {
    const parsed = parseCompraCommand(ctx.message.text);

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

    const purchaseData = {
      date: formatDateDMY(),
      amount: parsed.amount,
      months: parsed.months,
      bank: parsed.bank.toUpperCase(),
      description: parsed.description,
      user: ctx.from.first_name || "Usuario",
    };

    // Guardamos pendiente (sobrescribe si había otra)
    pendingPurchases.set(key, {
      data: purchaseData,
      createdAt: Date.now(),
      stage: "PREVIEW",
    });

    // Si no está en skip y tenemos ciclo configurado, calculamos ventana de pago
    const windowInfo =
      !SKIP_CUT_VALIDATION.has(purchaseData.bank)
        ? getPaymentWindow(purchaseData.bank, new Date())
        : null;

    const financeLine = windowInfo
      ? `\n\n⏳ Tiempo para pagar (estimado): *${windowInfo.daysToPay} días*\n` +
        `📌 Corte: *${windowInfo.cutDate.toLocaleDateString("es-MX")}*\n` +
        `💳 Límite: *${windowInfo.dueDate.toLocaleDateString("es-MX")}*`
      : "";

    const preview =
      `🧾 *Confirmar compra*\n\n` +
      `📌 *${purchaseData.description}*\n` +
      `💰 Monto: *$${purchaseData.amount}*\n` +
      `🗓️ Meses: *${purchaseData.months}*\n` +
      `🏦 Banco: *${purchaseData.bank}*\n` +
      `👤 Titular: *${purchaseData.user}*\n` +
      `📅 F. compra: *${purchaseData.date}*` +
      financeLine;

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
 * CONFIRMAR COMPRA
 * ============================================================
 *
 * Aquí se decide:
 * - Guardar directo
 * - o mostrar recomendación (2da confirmación)
 *
 * Reglas:
 * 1) CAPITAL/PRESTAMO -> guardar directo
 * 2) Si banco no tiene ciclo configurado -> guardar directo
 * 3) Si existe una alternativa >= IMPROVEMENT_THRESHOLD_DAYS mejor:
 *    -> advertencia y 2da confirmación ("OK Guardar")
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

    if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
      pendingPurchases.delete(key);
      await ctx.editMessageText("⏱️ Esta confirmación expiró.");
      await ctx.answerCbQuery();
      return;
    }

    const purchase = pending.data;

    // 1) Bancos sin validación financiera -> guarda directo
    if (SKIP_CUT_VALIDATION.has(purchase.bank)) {
      await savePurchaseToSheets(purchase);
      pendingPurchases.delete(key);
      await ctx.editMessageText("✅ Compra guardada exitosamente.");
      await ctx.answerCbQuery();
      return;
    }

    // 2) Calculamos ventana de pago para tarjeta elegida
    const chosen = getPaymentWindow(purchase.bank, new Date());

    // Si el banco no está configurado en CARD_CYCLE, guardamos normal
    if (!chosen) {
      await savePurchaseToSheets(purchase);
      pendingPurchases.delete(key);
      await ctx.editMessageText("✅ Compra guardada exitosamente.");
      await ctx.answerCbQuery();
      return;
    }

    // 3) Ranking de tarjetas (excluimos la elegida)
    const ranking = rankCardsByDaysToPay(new Date(), [purchase.bank]);
    const bestAlt = ranking[0]; // mejor alternativa disponible

    /**
     * Disparador de advertencia:
     * Si existe alternativa y te da >= X días extra, advertimos.
     * Importante:
     * - Solo advertimos 1 vez por compra (stage !== "WARNED")
     */
    const shouldWarn =
      bestAlt &&
      bestAlt.daysToPay >= chosen.daysToPay + IMPROVEMENT_THRESHOLD_DAYS &&
      pending.stage !== "WARNED";

    if (shouldWarn) {
      pending.stage = "WARNED";
      pendingPurchases.set(key, pending);

      // Top 3 recomendaciones (o menos si no hay suficientes)
      const top3 = ranking.slice(0, 3)
        .map((x) =>
          `• ${x.bank}: ${x.daysToPay} días (límite ${x.dueDate.toLocaleDateString("es-MX")})`
        )
        .join("\n");

      const msg =
        `⚠️ *Recomendación de tarjeta*\n\n` +
        `Con *${purchase.bank}* tendrías aprox. *${chosen.daysToPay} días* para pagar.\n` +
        `📌 Corte: *${chosen.cutDate.toLocaleDateString("es-MX")}*\n` +
        `💳 Límite: *${chosen.dueDate.toLocaleDateString("es-MX")}*\n\n` +
        `Para tener *más tiempo*, hoy te conviene usar:\n` +
        `${top3}\n\n` +
        `Si aún así deseas guardarla con *${purchase.bank}*, presiona *OK Guardar*.`;

      await ctx.editMessageText(msg, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          Markup.button.callback("✅ OK Guardar", "confirm_purchase_ok"),
          Markup.button.callback("❌ Cancelar", "cancel_purchase"),
        ]),
      });

      await ctx.answerCbQuery();
      return;
    }

    // Si no hay alternativa significativamente mejor -> guardado directo
    await savePurchaseToSheets(purchase);
    pendingPurchases.delete(key);
    await ctx.editMessageText("✅ Compra guardada exitosamente.");
    await ctx.answerCbQuery();
  } catch (err) {
    console.error("Error confirm_purchase:", err);
    try { await ctx.editMessageText("❌ Error al guardar la compra."); } catch {}
    try { await ctx.answerCbQuery(); } catch {}
  }
});

/**
 * Segunda confirmación:
 * Solo se usa cuando ya se mostró la recomendación (stage WARNED).
 * Aquí ya se guarda definitivamente.
 */
bot.action("confirm_purchase_ok", async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const key = `${chatId}:${userId}`;

    const pending = pendingPurchases.get(key);
    if (!pending) {
      await ctx.answerCbQuery("No hay una compra pendiente.");
      return;
    }

    if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
      pendingPurchases.delete(key);
      await ctx.editMessageText("⏱️ Esta confirmación expiró.");
      await ctx.answerCbQuery();
      return;
    }

    const purchase = pending.data;

    await savePurchaseToSheets(purchase);
    pendingPurchases.delete(key);

    await ctx.editMessageText("✅ Compra guardada exitosamente.");
    await ctx.answerCbQuery();
  } catch (err) {
    console.error("Error confirm_purchase_ok:", err);
    try { await ctx.editMessageText("❌ Error al guardar la compra."); } catch {}
    try { await ctx.answerCbQuery(); } catch {}
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


/**
 * ============================================================
 * NUEVO COMANDO: /dias
 * ============================================================
 *
 * Objetivo:
 * - Mostrar cuántos días (estimados) tendrías para pagar si usaras
 *   HOY cada tarjeta configurada en CARD_CYCLE.
 *
 * Salida:
 * - Lista ordenada de MAYOR a MENOR (más días para pagar primero)
 * - Muestra:
 *    • BANCO: X días
 *      Corte: DD/MM/YYYY
 *      Límite: DD/MM/YYYY
 *
 * Notas:
 * - CAPITAL / PRESTAMO no aplican aquí porque no forman parte de CARD_CYCLE
 * - Usa el cálculo de getPaymentWindow() + rankCardsByDaysToPay()
 */
bot.command("dias", async (ctx) => {
  try {
    const today = new Date();

    // Ranking: mejor primero (más días para pagar)
    const ranking = rankCardsByDaysToPay(today);

    if (!ranking.length) {
      return ctx.reply("❌ No hay tarjetas configuradas para calcular días.");
    }

    // Construimos mensaje en formato legible (Markdown)
    const lines = ranking.map((x) => {
      const cut = x.cutDate.toLocaleDateString("es-MX");
      const due = x.dueDate.toLocaleDateString("es-MX");
      return (
        `• *${x.bank}*: *${x.daysToPay} días*\n` +
        `  📌 Corte: ${cut}\n` +
        `  💳 Límite: ${due}`
      );
    });

    const msg =
      `📅 *Días para pagar si usas la tarjeta HOY*\n` +
      `(ordenado por mayor tiempo)\n\n` +
      lines.join("\n\n");

    await ctx.replyWithMarkdown(msg);
  } catch (err) {
    console.error("Error /dias:", err);
    ctx.reply("❌ Ocurrió un error calculando los días.");
  }
});


/* ============================================================
 * ARRANQUE DEL BOT
 * ============================================================
 */

bot.launch()
  .then(() => console.log("🚀 Bot iniciado correctamente"))
  .catch((err) => console.error("❌ Error iniciando bot:", err));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
