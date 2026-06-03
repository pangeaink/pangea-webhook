const express = require('express');
const app = express();
app.use(express.json());

// ─── CONFIG ───────────────────────────────────────────────
const KOMMO_SUBDOMAIN = process.env.KOMMO_SUBDOMAIN || 'pangeainkinfo';
const KOMMO_TOKEN     = process.env.KOMMO_TOKEN;
const HC_API_KEY      = process.env.HC_API_KEY;
const PORT            = process.env.PORT || 3000;

// ─── HIGHLIGHTCARDS CARD IDs ──────────────────────────────
// Reemplaza estos IDs cuando crees las tarjetas en Highlightcards
const CARDS = {
  TT: process.env.HC_CARD_TT, // Tattoo Turista
  TL: process.env.HC_CARD_TL, // Tattoo Local
  PT: process.env.HC_CARD_PT, // Piercing Turista
  PL: process.env.HC_CARD_PL, // Piercing Local
};

// ─── KOMMO PIPELINE IDs ───────────────────────────────────
// Reemplaza cuando estructuremos Kommo
const PIPELINES = {
  TT: process.env.KOMMO_PIPELINE_TT,
  TL: process.env.KOMMO_PIPELINE_TL,
  PT: process.env.KOMMO_PIPELINE_PT,
  PL: process.env.KOMMO_PIPELINE_PL,
};

// ─── WHATSAPP MESSAGES ────────────────────────────────────
const MESSAGES = {
  TT: {
    day0:  `🖤 Welcome to Pangea Ink! Your experience is permanent — and so is our gratitude. Check your tattoo care instructions here: [link]`,
    day0b: `⭐ We'd love your Google Review while Panama is still fresh! It takes 30 seconds: [google_review_link]`,
    day1:  `📸 Share your Pangea experience! Tag us @pangeaink — we'd love to repost your story.`,
    day2:  `🤘 Know someone who wants to get tattooed in Panama? Send them your referral link and you both win: [referral_link]`,
  },
  TL: {
    day0:  `🖤 Gracias por confiar en Pangea Ink. Tu tatuaje es para siempre — al igual que nuestra dedicación. Instrucciones de cuidado: [link]`,
    day3:  `⭐ ¿Nos regalas una reseña en Google? Solo 30 segundos y nos ayuda muchísimo: [google_review_link]`,
    day7:  `🤘 ¿Tienes alguien que quiera tatuarse? Comparte tu link de referido y ambos ganan: [referral_link]`,
    day30: `🖤 ¡Han pasado 30 días! ¿Cómo está tu tatuaje? ¿Ya tienes en mente el próximo proyecto?`,
  },
  PT: {
    day0:  `🖤 Welcome to Pangea Ink! Your piercing looks amazing. Care instructions: [link]`,
    day0b: `⭐ Quick Google Review before you leave Panama? Means the world to us: [google_review_link]`,
    day1:  `🤘 Share your Pangea piercing! Tag us @pangeaink`,
  },
  PL: {
    day0:  `🖤 ¡Gracias por tu visita a Pangea Ink! Aquí tus instrucciones de cuidado del piercing: [link]`,
    day3:  `⭐ ¿Nos dejas una reseña en Google? 30 segundos: [google_review_link]`,
    day14: `💎 ¿Listo para el siguiente piercing? Escríbenos cuando quieras.`,
  },
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
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${HC_API_KEY}`,
    },
    body: JSON.stringify({
      first_name: customer.firstName,
      last_name:  customer.lastName  || '',
      phone:      customer.phone     || '',
      email:      customer.email     || '',
    }),
  });
  const data = await res.json();
  console.log('Highlightcards response:', data);
  return data;
}

async function tagLeadInKommo(leadId, type, pipeline) {
  if (!KOMMO_TOKEN) return null;
  const body = { tags: [{ name: type }] };
  if (pipeline) body.pipeline_id = parseInt(pipeline);

  const res = await fetch(`https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads/${leadId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${KOMMO_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  console.log('Kommo response:', data);
  return data;
}

// ─── MAIN WEBHOOK ─────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  try {
    console.log('📦 Incoming webhook:', JSON.stringify(req.body, null, 2));

    const body     = req.body;
    const note     = body.note || body.line_items_note || body.order_note || '';
    const leadId   = body.lead_id || body.kommo_lead_id || null;
    const customer = {
      firstName: body.customer_name || body.first_name || 'Cliente',
      lastName:  body.last_name  || '',
      phone:     body.phone      || body.customer_phone || '',
      email:     body.email      || body.customer_email || '',
    };
    const location = body.location || 'unknown'; // "Casco Viejo" or "Via Argentina"

    console.log(`📍 Location: ${location}`);
    console.log(`📝 Note: "${note}"`);

    // 1. Detect client type
    const type = detectType(note);
    if (!type) {
      console.log('⚠️  No type detected in note. Skipping segmentation.');
      return res.json({ status: 'skipped', reason: 'no type in note' });
    }
    console.log(`✅ Type detected: ${type}`);

    // 2. Issue Highlightcards card
    const cardId = CARDS[type];
    if (cardId) {
      await issueHighlightCard(cardId, customer);
      console.log(`🃏 Card issued for type: ${type}`);
    } else {
      console.log(`⚠️  No card ID configured for type: ${type}`);
    }

    // 3. Tag lead in Kommo
    if (leadId) {
      await tagLeadInKommo(leadId, type, PIPELINES[type]);
      console.log(`🏷️  Lead ${leadId} tagged as ${type} in Kommo`);
    } else {
      console.log('⚠️  No lead ID provided — skipping Kommo tagging');
    }

    res.json({
      status:   'success',
      type,
      location,
      customer: customer.firstName,
    });

  } catch (err) {
    console.error('❌ Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:  'Pangea Ink Webhook Server 🖤',
    version: '1.0.0',
    ready:   true,
  });
});

app.listen(PORT, () => {
  console.log(`🖤 Pangea webhook server running on port ${PORT}`);
});
