const KOMMO_TOKEN = process.env.KOMMO_TOKEN;
const KOMMO_SUBDOMAIN = process.env.KOMMO_SUBDOMAIN || 'pangeainkinfo';
const BASE_URL = `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4`;

const headers = {
  'Authorization': `Bearer ${KOMMO_TOKEN}`,
  'Content-Type': 'application/json',
};

// Pipelines — sin colores (Kommo asigna por defecto, los cambias visual luego)
const PIPELINES = [
  {
    key: 'TT',
    name: 'Tattoo Turista',
    stages: ['Nuevo Lead', 'Contactado', 'Agendado', 'Pago Confirmado', 'Review Enviado', 'Referido Enviado'],
  },
  {
    key: 'TL',
    name: 'Tattoo Local',
    stages: ['Nuevo Lead', 'Contactado', 'Agendado', 'Pago Confirmado', 'Review Enviado', 'Dia 7 Referido', 'Dia 30 Check'],
  },
  {
    key: 'PT',
    name: 'Piercing Turista',
    stages: ['Nuevo Lead', 'Contactado', 'Pago Confirmado', 'Review Enviado'],
  },
  {
    key: 'PL',
    name: 'Piercing Local',
    stages: ['Nuevo Lead', 'Contactado', 'Pago Confirmado', 'Review Enviado', 'Dia 14 Proximo'],
  },
];

async function createPipeline(pipeline, sortIndex) {
  console.log(`\n📦 Creando pipeline: ${pipeline.name}...`);

  const body = [{
    name: pipeline.name,
    sort: sortIndex,
    is_main: false,
    is_unsorted_on: false,
    _embedded: {
      statuses: pipeline.stages.map((name, i) => ({
        name: name,
        sort: (i + 1) * 10,
      }))
    }
  }];

  const res = await fetch(`${BASE_URL}/leads/pipelines`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (data._embedded?.pipelines?.[0]) {
    const p = data._embedded.pipelines[0];
    console.log(`✅ Pipeline creado: ${p.name} (ID: ${p.id})`);
    return { key: pipeline.key, id: p.id, name: p.name };
  } else {
    console.log(`❌ Error:`, JSON.stringify(data, null, 2));
    return null;
  }
}

async function main() {
  if (!KOMMO_TOKEN) {
    console.error('❌ KOMMO_TOKEN no está definido');
    process.exit(1);
  }

  console.log('🖤 Pangea Ink — Setup Kommo Pipelines');
  console.log(`📡 Conectando a: ${KOMMO_SUBDOMAIN}.kommo.com`);

  const results = [];
  let sortIndex = 100;
  for (const pipeline of PIPELINES) {
    const result = await createPipeline(pipeline, sortIndex);
    if (result) results.push(result);
    sortIndex += 10;
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n\n🎉 SETUP COMPLETO');
  console.log('═══════════════════════════════');
  console.log('Copia estas variables a Railway:\n');
  for (const r of results) {
    console.log(`KOMMO_PIPELINE_${r.key}=${r.id}`);
  }
  console.log('═══════════════════════════════');
}

main().catch(console.error);
