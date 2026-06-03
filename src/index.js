const express = require('express');
const app = express();
app.use(express.json());

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const KOMMO_SUBDOMAIN        = process.env.KOMMO_SUBDOMAIN || 'pangeainkinfo';
const KOMMO_TOKEN            = process.env.KOMMO_TOKEN;
const HC_API_KEY             = process.env.HC_API_KEY;
const HC_REFERRAL_FIELD_ID   = process.env.HC_REFERRAL_FIELD_ID;  // Kommo custom field ID (agregar después)
const PORT                   = process.env.PORT || 3000;

// ─── HIGHLIGHTCARDS CARD IDs ──────────────────────────────────────────────────
const CARDS = {
  TT: process.env.HC_CARD_TT,
  TL: process.env.HC_CARD_TL,
  PT: process.env.HC_CARD_PT,
  PL: process.env.HC_CARD_PL,
};

// ─── KOMMO PIPELINE IDs ───────────────────────────────────────────────────────
const PIPELINES = {
  TT: process.env.KOMMO_PIPELINE_TT,
  TL: process.env.KOMMO_PIPELINE_TL,
  PT: process.env.KOMMO_PIPELINE_PT,
  PL: process.env.KOMMO_PIPELINE_PL,
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function detectType(note) {
  if (!note) return null;
  const n = note.toUpperCase().trim();
  // Order matters: PT before PL, TT before TL
  if (n.includes('TT')) return 'TT';
  if (n.includes('PT')) return 'PT';
  if (n.includes('TL')) return 'TL';
  if (n.includes('PL')) return 'PL';
  return null;
}

// Fetch responsible user name from Kommo lead
async function getArtistFromKommo(leadId) {
  if (!KOMMO_TOKEN || !leadId) return { name: null, userId: null };
  try {
    const leadRes = await fetch(
      `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads/${leadId}`,
      { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` } }
    );
    const leadData = await leadRes.json();
    const userId = leadData?.responsible_user_id;
    if (!userId) return { name: null, userId: null };

    const userRes = await fetch(
      `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/users/${userId}`,
      { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` } }
    );
    const userData = await userRes.json();
    const name = userData?.name || userData?.login || null;
    console.log(`🎨 Artist resolved: ${name} (userId: ${userId})`);
    return { name, userId };
  } catch (err) {
    console.error('⚠️  Could not fetch artist from Kommo:', err.message);
    return { name: null, userId: null };
  }
}

// Issue Highlightcards card → returns wallet + referral URL
async function issueHighlightCard(cardId, customer) {
  if (!cardId || !HC_API_KEY) {
    console.log('⚠️  Highlightcards skipped — no cardId or API key');
    return null;
  }
  try {
    const res = await fetch(
      `https://app.highlightcards.co.uk/api/v1/cards/${cardId}/issue`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${HC_API_KEY}`,
        },
        body: JSON.stringify({
          first_name: customer.firstName,
          last_name:  customer.lastName || '',
          phone:      customer.phone    || '',
          email:      customer.email    || '',
        }),
      }
    );
    const data = await res.json();
    console.log('🃏 Highlightcards response:', JSON.stringify(data));

    const walletUrl   = data?.wallet_url   || data?.pass_url     || data?.url    || null;
    const referralUrl = data?.referral_url || data?.referral_link || walletUrl   || null;

    return { walletUrl, referralUrl, raw: data };
  } catch (err) {
    console.error('⚠️  Highlightcards error:', err.message);
    return null;
  }
}

// PATCH Kommo lead: tag + pipeline + optional custom fields
async function updateLeadInKommo(leadId, type, pipeline, customFields = []) {
  if (!KOMMO_TOKEN || !leadId) return null;
  try {
    const body = { tags: [{ name: type }] };
    if (pipeline) body.pipeline_id = parseInt(pipeline);
    if (customFields.length > 0) body.custom_fields_values = customFields;

    const res = await fetch(
      `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads/${leadId}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${KOMMO_TOKEN}`,
        },
        body: JSON.stringify(body),
      }
    );
    const data = await res.json();
    console.log('✅ Kommo lead updated:', JSON.stringify(data));
    return data;
  } catch (err) {
    console.error('⚠️  Kommo update error:', err.message);
    return null;
  }
}

// Add internal note to Kommo lead
async function addNoteToKommo(leadId, text) {
  if (!KOMMO_TOKEN || !leadId) return null;
  try {
    const res = await fetch(
      `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads/notes`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${KOMMO_TOKEN}`,
        },
        body: JSON.stringify([
          {
            entity_id: parseInt(leadId),
            note_type: 'common',
            params:    { text },
          },
        ]),
      }
    );
    const data = await res.json();
    console.log('📝 Note added to Kommo lead');
    return data;
  } catch (err) {
    console.error('⚠️  Kommo note error:', err.message);
    return null;
  }
}

// ─── MAIN WEBHOOK ─────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  try {
    console.log('📦 Incoming webhook:', JSON.stringify(req.body, null, 2));

    const body   = req.body;
    const note   = body.note || body.line_items_note || body.order_note || '';
    const leadId = body.lead_id || body.kommo_lead_id || null;

    const customer = {
      firstName: body.customer_name || body.first_name || 'Cliente',
      lastName:  body.last_name     || '',
      phone:     body.phone         || body.customer_phone || '',
      email:     body.email         || body.customer_email || '',
    };
    const location = body.location || 'unknown';

    console.log(`📍 Location: ${location}`);
    console.log(`📝 Note: "${note}"`);

    // ── 1. Detect client type ─────────────────────────────────────────────────
    const type = detectType(note);
    if (!type) {
      console.log('⚠️  No type detected in note. Skipping.');
      return res.json({ status: 'skipped', reason: 'no type in note' });
    }
    console.log(`✅ Type detected: ${type}`);

    // ── 2. Fetch artist from Kommo ────────────────────────────────────────────
    // responsible_user.name → disponible en Salesbot como {{responsible_user.name}}
    const artist = await getArtistFromKommo(leadId);

    // ── 3. Issue Highlightcards card ──────────────────────────────────────────
    const cardId   = CARDS[type];
    const hcResult = await issueHighlightCard(cardId, customer);
    const referralUrl = hcResult?.referralUrl || null;

    // ── 4. Build Kommo custom fields (if HC_REFERRAL_FIELD_ID is set) ─────────
    const customFields = [];
    if (referralUrl && HC_REFERRAL_FIELD_ID) {
      customFields.push({
        field_id: parseInt(HC_REFERRAL_FIELD_ID),
        values:   [{ value: referralUrl }],
      });
    }

    // ── 5. Update Kommo lead ──────────────────────────────────────────────────
    if (leadId) {
      await updateLeadInKommo(leadId, type, PIPELINES[type], customFields);
      console.log(`🏷️  Lead ${leadId} → ${type}`);

      // Internal note with all key info (visible en Kommo)
      const noteText = [
        `🖤 Pangea Webhook v2`,
        `Tipo: ${type}`,
        `Sucursal: ${location}`,
        artist.name   ? `Artista: ${artist.name}`         : null,
        referralUrl   ? `HC Referral Link: ${referralUrl}` : null,
        cardId        ? `HC Card ID: ${cardId}`            : null,
      ]
        .filter(Boolean)
        .join('\n');

      await addNoteToKommo(leadId, noteText);
    } else {
      console.log('⚠️  No lead ID — skipping Kommo update');
    }

    // ── 6. Respond ────────────────────────────────────────────────────────────
    res.json({
      status:      'success',
      type,
      location,
      customer:    customer.firstName,
      artist:      artist.name,
      referralUrl,
      hcIssued:    !!hcResult,
    });

  } catch (err) {
    console.error('❌ Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: '🖤 Pangea Ink Webhook v2.0',
    ready:  true,
    checks: {
      kommo_token:       !!KOMMO_TOKEN,
      hc_api_key:        !!HC_API_KEY,
      hc_card_TT:        !!CARDS.TT,
      hc_card_TL:        !!CARDS.TL,
      hc_card_PT:        !!CARDS.PT,
      hc_card_PL:        !!CARDS.PL,
      pipeline_TT:       !!PIPELINES.TT,
      pipeline_TL:       !!PIPELINES.TL,
      pipeline_PT:       !!PIPELINES.PT,
      pipeline_PL:       !!PIPELINES.PL,
      hc_referral_field: !!HC_REFERRAL_FIELD_ID,
    },
  });
});

app.listen(PORT, () => {
  console.log(`🖤 Pangea webhook v2 running on port ${PORT}`);
});
