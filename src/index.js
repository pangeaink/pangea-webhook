const express = require('express');
const app = express();
app.use(express.json());

// ─── CONFIG ───────────────────────────────────────────────
const KOMMO_SUBDOMAIN  = process.env.KOMMO_SUBDOMAIN  || 'pangeainkinfo';
const KOMMO_TOKEN      = process.env.KOMMO_TOKEN;
const HC_API_KEY       = process.env.HC_API_KEY;
const PORT             = process.env.PORT || 3000;
const GOOGLE_REVIEW    = process.env.GOOGLE_REVIEW_LINK || 'https://g.page/r/XXXXXXX/review';
const CALENDLY         = process.env.CALENDLY_LINK     || 'https://calendly.com/pangeaink';
const INSTAGRAM        = '@pangeaink';

// ─── HIGHLIGHTCARDS CARD IDs ──────────────────────────────
const CARDS = {
  TT: process.env.HC_CARD_TT,
  TL: process.env.HC_CARD_TL,
  PT: process.env.HC_CARD_PT,
  PL: process.env.HC_CARD_PL,
};

// ─── KOMMO PIPELINE IDs ───────────────────────────────────
const PIPELINES = {
  TT: process.env.KOMMO_PIPELINE_TT || '13875504',
  TL: process.env.KOMMO_PIPELINE_TL || '13875508',
  PT: process.env.KOMMO_PIPELINE_PT || '13875512',
  PL: process.env.KOMMO_PIPELINE_PL || '13875516',
};

const BASE_URL = `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4`;
const KOMMO_HEADERS = {
  'Authorization': `Bearer ${KOMMO_TOKEN}`,
  'Content-Type': 'application/json',
};

// ─── MENSAJES WHATSAPP ────────────────────────────────────
const SEQUENCES = {
  TT: [
    { delay: 0,                          msg: (n) => `🖤 *${n}*, gracias por vivir esta experiencia con nosotros en Pangea Ink.\n\nTu tatuaje es permanente — y también lo es nuestro compromiso.\n\n📋 Cuidados: ${CALENDLY}\n\n¡Bienvenido a la familia! 🤘` },
    { delay: 2 * 60 * 60 * 1000,        msg: (n) => `⭐ *${n}*, ¿nos regalas 30 segundos?\n\nTu opinión en Google nos ayuda mucho:\n👉 ${GOOGLE_REVIEW}\n\n¡Gracias! 🖤` },
    { delay: 24 * 60 * 60 * 1000,       msg: (n) => `📸 *${n}*, etiquétanos en ${INSTAGRAM} — nos encantaría compartir tu historia. 🤘🖤` },
    { delay: 2 * 24 * 60 * 60 * 1000,   msg: (n) => `🤘 ¿Conoces a alguien que quiera tatuarse en Panamá?\n\nComparte Pangea Ink con ellos 👉 ${CALENDLY}` },
  ],
  TL: [
    { delay: 0,                          msg: (n) => `🖤 *${n}*, gracias por confiar en Pangea Ink.\n\n📋 Cuidados: ${CALENDLY}` },
    { delay: 3 * 24 * 60 * 60 * 1000,   msg: (n) => `⭐ *${n}*, ¿nos dejas una reseña?\n👉 ${GOOGLE_REVIEW}\n\n¡Gracias! 🖤` },
    { delay: 7 * 24 * 60 * 60 * 1000,   msg: (n) => `🤘 *${n}*, ¿alguien que quiera tatuarse? Comparte Pangea 👉 ${CALENDLY}` },
    { delay: 30 * 24 * 60 * 60 * 1000,  msg: (n) => `🖤 *${n}*, ¡un mes ya! ¿Cómo está el tatuaje? ¿Próximo proyecto? 🤘` },
  ],
  PT: [
    { delay: 0,                          msg: (n) => `🖤 *${n}*, gracias por tu visita. 💎\n\n📋 Cuidados del piercing: ${CALENDLY}` },
    { delay: 2 * 60 * 60 * 1000,        msg: (n) => `⭐ *${n}*, ¿nos dejas una reseña antes de salir de Panamá?\n👉 ${GOOGLE_REVIEW} 🖤` },
    { delay: 24 * 60 * 60 * 1000,       msg: (n) => `📸 Etiquétanos en ${INSTAGRAM} 💎🖤` },
  ],
  PL: [
    { delay: 0,                          msg: (n) => `🖤 *${n}*, gracias por tu visita.\n\n📋 Cuidados: ${CALENDLY}` },
    { delay: 3 * 24 * 60 * 60 * 1000,   msg: (n) => `⭐ *${n}*, ¿nos dejas una reseña?\n👉 ${GOOGLE_REVIEW} 🖤` },
    { delay: 14 * 24 * 60 * 60 * 1000,  msg: (n) => `💎 *${n}*, ¿listo para el siguiente piercing? Aquí estamos 🖤\n${CALENDLY}` },
  ],
};

// ─── HELPERS ──────────────────────────────────────────────
function detectType(note) {
  if (!note) return null;
  const n = note.toUpperCase().trim();
  if (n.includes('TT')) return 'TT';
  if (n.includes('TL')) return 'TL';
  if (n.includes('PT')) return 'PT';
  if (n.includes('PL')) return 'PL';
  return null;
}

async function issueHighlightCard(cardId, customer) {
  if (!cardId || !HC_API_KEY) return null;
  const res = await fetch(`https://app.highlightcards.co.uk/api/v1/cards/${cardId}/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${HC_API_KEY}` },
    body: JSON.stringify({ first_name: customer.firstName, phone: customer.phone, email: customer.email }),
  });
  return await res.json();
}

async function updateLeadInKommo(leadId, type) {
  if (!KOMMO_TOKEN || !leadId) return null;
  const res = await fetch(`${BASE_URL}/leads/${leadId}`, {
    method: 'PATCH',
    headers: KOMMO_HEADERS,
    body: JSON.stringify({
      pipeline_id: parseInt(PIPELINES[type]),
      tags: [{ name: type }],
    }),
  });
  return await res.json();
}

async function sendNoteToKommo(leadId, text) {
  if (!KOMMO_TOKEN || !leadId) return null;
  const res = await fetch(`${BASE_URL}/leads/${leadId}/notes`, {
    method: 'POST',
    headers: KOMMO_HEADERS,
    body: JSON.stringify([{ note_type: 'common', params: { text } }]),
  });
  return await res.json();
}

async function createKommoTask(leadId, text, dueDateMs) {
  if (!KOMMO_TOKEN || !leadId) return null;
  const res = await fetch(`${BASE_URL}/tasks`, {
    method: 'POST',
    headers: KOMMO_HEADERS,
    body: JSON.stringify([{
      entity_id: parseInt(leadId),
      entity_type: 'leads',
      task_type_id: 1,
      text,
      complete_till: Math.floor(dueDateMs / 1000),
      responsible_user_id: 12039579,
    }]),
  });
  return await res.json();
}

function scheduleMessages(type, leadId, customerName) {
  const seq = SEQUENCES[type];
  if (!seq) return;

  console.log(`\n📅 Secuencia ${type} programada para "${customerName}"`);

  seq.forEach((item, i) => {
    const dueMs = Date.now() + item.delay;
    const hours = Math.round(item.delay / 3600000);
    console.log(`  → Msg ${i+1}: ${hours === 0 ? 'inmediato' : `en ${hours}h`}`);

    setTimeout(async () => {
      const text = item.msg(customerName);
      console.log(`\n📲 Enviando msg ${i+1}/${seq.length} [${type}] para "${customerName}"`);

      if (item.delay <= 3 * 24 * 60 * 60 * 1000) {
        await sendNoteToKommo(leadId, text);
      } else {
        await createKommoTask(leadId, `WhatsApp para ${customerName}: ${text}`, dueMs);
      }
    }, item.delay);
  });
}

// ─── MAIN WEBHOOK ─────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  try {
    console.log('\n📦 Webhook recibido:', JSON.stringify(req.body, null, 2));

    const body     = req.body;
    const note     = body.note || body.customer_note || '';
    const leadId   = body.lead_id || null;
    const location = body.location || 'unknown';
    const customer = {
      firstName: body.customer_name || 'Cliente',
      phone:     body.phone || '',
      email:     body.email || '',
    };

    console.log(`📍 Sucursal: ${location}`);
    console.log(`📝 Nota: "${note}"`);

    const type = detectType(note);
    if (!type) {
      console.log('⚠️  Tipo no detectado. Agrega TT/TL/PT/PL en la nota de Square.');
      return res.json({ status: 'skipped', reason: 'no type in note' });
    }
    console.log(`✅ Tipo: ${type}`);

    // 1. Highlightcards
    const cardId = CARDS[type];
    if (cardId) {
      await issueHighlightCard(cardId, customer);
      console.log(`🃏 Tarjeta ${type} emitida`);
    }

    // 2. Kommo — mover al pipeline correcto
    if (leadId) {
      await updateLeadInKommo(leadId, type);
      console.log(`🏷️  Lead ${leadId} → Pipeline ${type}`);
    }

    // 3. Secuencia WhatsApp
    scheduleMessages(type, leadId, customer.firstName);

    res.json({ status: 'success', type, customer: customer.firstName });

  } catch (err) {
    console.error('❌ Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.json({ status: '🖤 Pangea Ink Webhook v2.0 — Online' }));

app.listen(PORT, () => console.log(`🖤 Pangea webhook server running on port ${PORT}`));
