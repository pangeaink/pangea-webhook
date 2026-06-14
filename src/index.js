const express = require('express');
const app = express();
app.use(express.json());

// ─── COMPAT: garantizar fetch en Node < 18 ───────────────────────────────────
// fetch global solo existe en Node 18+. Si Railway corre una versión anterior,
// caemos a node-fetch. Así el webhook nunca truena por "fetch is not defined".
if (typeof fetch === 'undefined') {
  global.fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const KOMMO_SUBDOMAIN        = process.env.KOMMO_SUBDOMAIN || 'pangeainkinfo';
const KOMMO_TOKEN            = process.env.KOMMO_TOKEN;
const HC_API_KEY             = process.env.HC_API_KEY;
const HC_REFERRAL_FIELD_ID   = process.env.HC_REFERRAL_FIELD_ID;  // Kommo custom field ID
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

// ─── MAPEO DE SEDE (bots×sede, v2.1) ──────────────────────────────────────────
// Square manda el Location Id crudo (ej. "LHSEB0J3XZBM4"). Lo traducimos a una
// sede legible y resolvemos los links de reseña/Calendly de ESA sede, para que
// el Salesbot los use directo sin lógica condicional.
// Location Ids de Square → Settings → Locations (confirmados jun 2026).
const LOCATION_MAP = {
  'LHSEB0J3XZBM4': 'casco-viejo',     // Pangea Ink Casco Viejo
  'LN3YNP3NZGB38': 'via-argentina',   // Pangea Ink Via Argentina
  'L0EEWR8XGGTV1': 'casco-viejo',     // Valhalla Tattoo (no se usa; fallback a casco por si entra)
};

// Links por sede. Override por variables de entorno; si no, usan los valores
// confirmados (fichas de Google Business y eventos de Calendly, jun 2026).
const SEDE_LINKS = {
  'casco-viejo': {
    nombre:   'Casco Viejo',
    review:   process.env.GOOGLE_REVIEW_LINK_CASCO || 'https://g.page/r/CWrIShzGWNg8EBM/review',
    calendly: process.env.CALENDLY_LINK_CASCO      || 'https://calendly.com/pangeaink-info/reserva-clon',
  },
  'via-argentina': {
    nombre:   'Vía Argentina',
    review:   process.env.GOOGLE_REVIEW_LINK_VA || 'https://g.page/r/CR6SHjnBnBxcEBM/review',
    calendly: process.env.CALENDLY_LINK_VA      || 'https://calendly.com/pangeaink-info/reserva',
  },
};

// IDs de campos personalizados de Kommo donde el webhook escribe la sede y los
// links resueltos, para que el Salesbot los inserte. Crear estos campos en Kommo
// y poner sus IDs aquí (env vars). Si no existen, el webhook NO falla: simplemente
// no escribe esos campos (la info igual va en la nota interna).
const KOMMO_FIELD_SEDE          = process.env.KOMMO_FIELD_SEDE;          // texto: "casco-viejo" / "via-argentina"
const KOMMO_FIELD_REVIEW_LINK   = process.env.KOMMO_FIELD_REVIEW_LINK;   // texto: review link de la sede
const KOMMO_FIELD_CALENDLY_LINK = process.env.KOMMO_FIELD_CALENDLY_LINK; // texto: calendly link de la sede
const KOMMO_FIELD_IDIOMA        = process.env.KOMMO_FIELD_IDIOMA;        // texto: "es" / "en" (v2.2)

// Traduce un Location Id de Square a su sede. Si no lo reconoce, devuelve null
// (y lo deja registrado para detectarlo en logs).
function resolveSede(locationId) {
  const sede = LOCATION_MAP[locationId] || null;
  if (!sede) {
    console.warn(`⚠️  Location Id no reconocido: "${locationId}" — revisar LOCATION_MAP`);
  }
  return sede;
}

// ─── NUEVO v2.2: IDIOMA por teléfono ──────────────────────────────────────────
// Regla de Carlos (14 jun 2026): +507 (Panamá) = español; cualquier otro código
// internacional = inglés; SIN teléfono = inglés (apuesta segura, turista de paso).
// Devuelve "es" o "en".
function detectLang(phone) {
  if (!phone) return 'en';                       // sin teléfono → inglés
  // Normaliza: deja solo dígitos (quita +, espacios, guiones, paréntesis).
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return 'en';
  // Panamá = código 507. Aceptamos con o sin prefijos internacionales (00, 011).
  let d = digits;
  if (d.startsWith('00'))  d = d.slice(2);       // prefijo internacional 00
  if (d.startsWith('011')) d = d.slice(3);       // prefijo internacional EEUU 011
  if (d.startsWith('507')) return 'es';          // Panamá → español
  // Número local panameño sin código país: 8 dígitos que empiezan con 6 (móvil PA).
  if (digits.length === 8 && digits.startsWith('6')) return 'es';
  return 'en';                                   // cualquier otro → inglés
}

// Tipo por defecto cuando la nota NO trae TT/TL/PT/PL (merch / compra sin servicio).
// Estos NO emiten tarjeta de fidelidad, pero sí entran al flujo "Compra general".
const RETAIL = 'RETAIL';

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// Detecta el tipo de cliente a partir de la nota de Square.
// ESTRICTO: busca el código como TOKEN aislado (separado por espacios, comas,
// guiones, etc.), NO como substring. Así "TATTOO LOCAL" NO se confunde con TT,
// y "PIERCING" no dispara nada raro. El equipo escribe el código (TT/TL/PT/PL)
// en la nota; esta función lo encuentra aunque venga con otras palabras.
function detectType(note) {
  if (!note) return null;
  // Normaliza: mayúsculas y separa por cualquier no-letra → lista de tokens.
  const tokens = note.toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  // Prioridad explícita por si (raro) hubiera más de un código en la nota.
  for (const code of ['TT', 'PT', 'TL', 'PL']) {
    if (tokens.includes(code)) return code;
  }
  return null;
}

// Pequeño helper: lee la respuesta y avisa si el status HTTP no fue ok.
async function safeJson(res, label) {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`⚠️  ${label} respondió ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    return await res.json();
  } catch {
    // Algunas respuestas (204, errores) no traen JSON; no es fatal.
    return null;
  }
}

// Fetch responsible user name from Kommo lead
async function getArtistFromKommo(leadId) {
  if (!KOMMO_TOKEN || !leadId) return { name: null, userId: null };
  try {
    const leadRes = await fetch(
      `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads/${leadId}`,
      { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` } }
    );
    const leadData = await safeJson(leadRes, 'Kommo lead (artist)');
    const userId = leadData?.responsible_user_id;
    if (!userId) return { name: null, userId: null };

    const userRes = await fetch(
      `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/users/${userId}`,
      { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` } }
    );
    const userData = await safeJson(userRes, 'Kommo user');
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
    const data = await safeJson(res, 'Highlightcards issue');
    console.log('🃏 Highlightcards response:', JSON.stringify(data));

    const walletUrl   = data?.wallet_url   || data?.pass_url      || data?.url   || null;
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
    const data = await safeJson(res, 'Kommo lead PATCH');
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
    const data = await safeJson(res, 'Kommo note');
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

    const body   = req.body || {};
    const note   = body.note || body.line_items_note || body.order_note || '';
    const leadId = body.lead_id || body.kommo_lead_id || null;

    const customer = {
      firstName: body.customer_name || body.first_name || 'Cliente',
      lastName:  body.last_name     || '',
      phone:     body.phone         || body.customer_phone || '',
      email:     body.email         || body.customer_email || '',
    };
    const location = body.location || 'unknown';

    // Traducir el Location Id de Square a sede + resolver sus links
    const sede      = resolveSede(location);                  // "casco-viejo" / "via-argentina" / null
    const sedeData  = sede ? SEDE_LINKS[sede] : null;         // { nombre, review, calendly } o null
    const sedeName  = sedeData ? sedeData.nombre : null;      // nombre legible (o null si no se reconoció)

    console.log(`📍 Location Id: ${location} → Sede: ${sede || 'NO RECONOCIDA'}`);
    console.log(`📝 Note: "${note}"`);

    // ── NUEVO v2.2: idioma por teléfono (es/en) ───────────────────────────────
    const lang = detectLang(customer.phone);
    console.log(`🗣️  Idioma: ${lang} (teléfono: ${customer.phone || 'sin teléfono'})`);

    // ── 1. Detect client type ─────────────────────────────────────────────────
    // v2.2: si NO hay código de servicio (TT/TL/PT/PL), NO se descarta — se trata
    // como RETAIL (merch / compra sin servicio): recibe el gracias y entra al flujo
    // "Compra general", pero NO se le emite tarjeta de fidelidad (esas son para
    // tatuaje/piercing). El enrutamiento RETAIL lo maneja el Salesbot/pipeline.
    const detected = detectType(note);
    const type     = detected || RETAIL;
    const isService = !!detected;   // true para TT/TL/PT/PL; false para RETAIL
    console.log(isService ? `✅ Type detected: ${type}` : `🛍️  Sin código de servicio → ${RETAIL} (merch / compra general)`);

    // ── 2. Fetch artist from Kommo ────────────────────────────────────────────
    // responsible_user.name → disponible en Salesbot como {{responsible_user.name}}
    const artist = await getArtistFromKommo(leadId);

    // ── 3. Issue Highlightcards card — SOLO para servicios (no RETAIL) ─────────
    const cardId   = isService ? CARDS[type] : null;
    const hcResult = isService ? await issueHighlightCard(cardId, customer) : null;
    const referralUrl = hcResult?.referralUrl || null;
    if (!isService) console.log('🛍️  RETAIL: no se emite tarjeta de fidelidad (es para servicios).');

    // ── 4. Build Kommo custom fields ──────────────────────────────────────────
    // Referral link (solo servicios) + sede + links de la sede + idioma.
    // Cada campo solo se escribe si su ID está configurado en las env vars.
    const customFields = [];
    if (referralUrl && HC_REFERRAL_FIELD_ID) {
      customFields.push({
        field_id: parseInt(HC_REFERRAL_FIELD_ID),
        values:   [{ value: referralUrl }],
      });
    }
    if (sede && KOMMO_FIELD_SEDE) {
      customFields.push({
        field_id: parseInt(KOMMO_FIELD_SEDE),
        values:   [{ value: sede }],
      });
    }
    if (sedeData && KOMMO_FIELD_REVIEW_LINK) {
      customFields.push({
        field_id: parseInt(KOMMO_FIELD_REVIEW_LINK),
        values:   [{ value: sedeData.review }],
      });
    }
    if (sedeData && KOMMO_FIELD_CALENDLY_LINK) {
      customFields.push({
        field_id: parseInt(KOMMO_FIELD_CALENDLY_LINK),
        values:   [{ value: sedeData.calendly }],
      });
    }
    if (KOMMO_FIELD_IDIOMA) {
      customFields.push({
        field_id: parseInt(KOMMO_FIELD_IDIOMA),
        values:   [{ value: lang }],
      });
    }

    // ── 5. Update Kommo lead ──────────────────────────────────────────────────
    if (leadId) {
      // Para RETAIL no hay pipeline en PIPELINES{}; se usa KOMMO_PIPELINE_RETAIL
      // (opcional). Si no está, el lead solo se etiqueta y el routing lo hace el bot.
      const pipelineForType = isService
        ? PIPELINES[type]
        : (process.env.KOMMO_PIPELINE_RETAIL || null);

      await updateLeadInKommo(leadId, type, pipelineForType, customFields);
      console.log(`🏷️  Lead ${leadId} → ${type} @ ${sede || 'sede?'} [${lang}]`);

      // Internal note with all key info (visible en Kommo)
      const noteText = [
        `🖤 Pangea Webhook v2.2`,
        `Tipo: ${type}${isService ? '' : ' (merch / sin servicio — sin tarjeta)'}`,
        `Idioma: ${lang}`,
        sedeName ? `Sucursal: ${sedeName} (${sede})` : `Sucursal: ⚠️ Location Id no reconocido (${location})`,
        artist.name ? `Artista: ${artist.name}`        : null,
        sedeData    ? `Review link: ${sedeData.review}`  : null,
        sedeData    ? `Calendly: ${sedeData.calendly}`   : null,
        referralUrl ? `HC Referral Link: ${referralUrl}` : null,
        cardId      ? `HC Card ID: ${cardId}`            : null,
      ]
        .filter(Boolean)
        .join('\n');

      await addNoteToKommo(leadId, noteText);
    } else {
      console.log('⚠️  No lead ID — skipping Kommo update');
    }

    // ── 6. Respond ────────────────────────────────────────────────────────────
    res.json({
      status:       'success',
      type,
      isService,
      lang,
      location,
      sede:         sede || null,
      sedeReconocida: !!sede,
      reviewLink:   sedeData?.review   || null,
      calendlyLink: sedeData?.calendly || null,
      customer:     customer.firstName,
      artist:       artist.name,
      referralUrl,
      hcIssued:     !!hcResult,
      leadUpdated:  !!leadId,
    });

  } catch (err) {
    console.error('❌ Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── DIAGNÓSTICO: probar el mapeo de sede sin hacer una compra real ───────────
// GET /test-sede?location=LHSEB0J3XZBM4  → muestra a qué sede y links resuelve.
// Útil para verificar la config sin tocar Square/Kommo.
app.get('/test-sede', (req, res) => {
  const location = req.query.location || '';
  const sede     = resolveSede(location);
  const sedeData = sede ? SEDE_LINKS[sede] : null;
  res.json({
    location,
    sede:         sede || null,
    reconocida:   !!sede,
    nombre:       sedeData?.nombre   || null,
    reviewLink:   sedeData?.review   || null,
    calendlyLink: sedeData?.calendly || null,
    mapeoCompleto: LOCATION_MAP,
  });
});

// ─── DIAGNÓSTICO: probar la detección de tipo desde una nota ──────────────────
// GET /test-type?note=Compra%20TT  → muestra qué tipo detecta (o RETAIL si ninguno).
app.get('/test-type', (req, res) => {
  const note = req.query.note || '';
  const detected = detectType(note);
  res.json({ note, type: detected || RETAIL, isService: !!detected });
});

// ─── DIAGNÓSTICO: probar el idioma desde un teléfono ──────────────────────────
// GET /test-lang?phone=+50762620736  → "es"  |  ?phone=+1305...  → "en"
app.get('/test-lang', (req, res) => {
  const phone = req.query.phone || '';
  res.json({ phone, lang: detectLang(phone) });
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: '🖤 Pangea Ink Webhook v2.2',
    ready:  true,
    node:   process.version,
    checks: {
      kommo_token:           !!KOMMO_TOKEN,
      hc_api_key:            !!HC_API_KEY,
      hc_card_TT:            !!CARDS.TT,
      hc_card_TL:            !!CARDS.TL,
      hc_card_PT:            !!CARDS.PT,
      hc_card_PL:            !!CARDS.PL,
      pipeline_TT:           !!PIPELINES.TT,
      pipeline_TL:           !!PIPELINES.TL,
      pipeline_PT:           !!PIPELINES.PT,
      pipeline_PL:           !!PIPELINES.PL,
      pipeline_RETAIL:       !!process.env.KOMMO_PIPELINE_RETAIL,
      hc_referral_field:     !!HC_REFERRAL_FIELD_ID,
      field_sede:            !!KOMMO_FIELD_SEDE,
      field_review_link:     !!KOMMO_FIELD_REVIEW_LINK,
      field_calendly_link:   !!KOMMO_FIELD_CALENDLY_LINK,
      field_idioma:          !!KOMMO_FIELD_IDIOMA,
    },
    sedes: Object.keys(SEDE_LINKS),
  });
});

app.listen(PORT, () => {
  console.log(`🖤 Pangea webhook v2.2 running on port ${PORT} (Node ${process.version})`);
});
