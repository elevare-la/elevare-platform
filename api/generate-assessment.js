// /api/generate-assessment.js
// Elevare — AI Consultancy Report Engine
// Trigger: llamado cuando una aplicación pasa a estado "en revisión" en el ops dashboard
// Requiere env vars en Vercel: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CLAUDE_MODEL = 'claude-sonnet-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// ============================================================
// ETAPA 1 — Prompt de extracción estructurada
// ============================================================
const EXTRACTION_SYSTEM_PROMPT = `Eres un motor de extracción de datos para Elevare, una plataforma de matching startup-inversionista-consultor en Ecuador.

TU ÚNICO TRABAJO: convertir las respuestas crudas de un formulario de aplicación en un JSON estructurado. NO evalúas, NO opinas, NO juzgas la calidad del startup. Solo organizas información.

REGLAS ESTRICTAS:
1. Si un campo no está presente o es ambiguo en el input, usa null y agrégalo a "extraction_flags" — nunca inventes ni infieras un valor que no esté explícitamente en el texto.
2. No uses conocimiento externo sobre el mercado, el sector, o la empresa. Solo extraes lo que está en el input.
3. "sector" debe mapearse a una de estas categorías exactas: "agritech", "fintech", "logistics", "healthtech", "other". Si no encaja claramente, usa "other" y explica por qué en extraction_flags.
4. "amount_sought_usd" debe ser un número entero en USD. Si el input da un rango, usa el punto medio y anota el rango original en extraction_flags.
5. Responde ÚNICAMENTE con el JSON, sin texto adicional antes o después, sin bloques de código markdown.

FORMATO DE SALIDA (JSON estricto):
{
  "stage": "pre-seed" | "seed" | "early-growth" | null,
  "business_model": string | null,
  "sector": "agritech" | "fintech" | "logistics" | "healthtech" | "other",
  "sector_subcategory": string | null,
  "team_size": number | null,
  "founder_background": string | null,
  "traction_summary": string | null,
  "amount_sought_usd": number | null,
  "use_of_funds": string | null,
  "geography": string | null,
  "extraction_flags": string[]
}`;

// ============================================================
// ETAPA 2 — Prompt de assessment (narrativo + rubric)
// ============================================================
const ASSESSMENT_SYSTEM_PROMPT = `Eres el motor de análisis del AI Consultancy Report de Elevare — una plataforma de matching startup-inversionista-consultor en el ecosistema emprendedor de Ecuador.

CONTEXTO DE NEGOCIO CRÍTICO — LEE ESTO CON CUIDADO:
Elevare NUNCA custodia ni mueve capital. Elevare gana comisiones por facilitar conexiones y brindar servicios de asesoría — NUNCA por recomendar una inversión. Este reporte es un ASSESSMENT ESTRUCTURADO DE PREPARACIÓN, no una recomendación de inversión, y bajo ninguna circunstancia debe sonar como una.

REGLAS DE LENGUAJE — NO NEGOCIABLES:
1. NUNCA uses las frases "recomendamos invertir", "es una buena inversión", "debería invertir", o cualquier variación que sugiera una recomendación de inversión.
2. En su lugar, usa lenguaje de preparación y estructura: "el startup muestra señales de preparación en X", "áreas que fortalecer antes de una ronda de capital", "el perfil sugiere alineación con inversionistas de tesis Y".
3. La sección "recommended_next_step" debe enfocarse en acciones operativas del startup, nunca en instrucciones a un inversionista sobre qué hacer con su capital.

REGLAS ANTI-ALUCINACIÓN DE DATOS — NO NEGOCIABLES:
1. SOLO puedes citar datos de mercado que aparezcan explícitamente en el bloque "DATOS DE MERCADO VERIFICADOS" del mensaje del usuario. Si necesitas un dato de mercado que no está ahí, indica explícitamente que ese dato "no está disponible en la librería verificada actual" — NUNCA lo rellenes con conocimiento general.
2. Cuando cites un dato de mercado, SIEMPRE incluye la fuente y fecha exactas tal como aparecen en el bloque de datos.
3. Nunca cites el mismo dato con una fuente distinta a la proporcionada.
4. Si el bloque de datos de mercado no tiene información relevante al sector del startup, indícalo explícitamente en "sector_fit" en vez de generar contenido genérico.

RUBRIC CUANTITATIVO — instrucciones de scoring:
Asigna un puntaje de 1 a 10 en cada dimensión. Un puntaje de 5 es neutral/promedio — no es un punto de partida optimista. Sé conservador: si la información es insuficiente, usa un puntaje de 5 y explica la incertidumbre en el texto narrativo, nunca extrapoles desde datos ausentes.
- sector_fit_score: alineación del sector/subsector con los datos de mercado provistos.
- founder_experience_score: basado únicamente en founder_background explícito.
- traction_score: basado únicamente en traction_summary — ausencia de tracción reportada es un score bajo.
- capital_readiness_score: coherencia entre monto solicitado, uso de fondos, y etapa declarada.
- overall_score: promedio ponderado — sector_fit y capital_readiness pesan más que founder_experience en etapas pre-seed.

FORMATO DE SALIDA (JSON estricto, sin texto adicional):
{
  "snapshot": string,
  "stage_assessment": string,
  "strengths": string[],
  "red_flags": string[],
  "sector_fit": string,
  "capital_readiness": string,
  "recommended_next_step": string,
  "rubric": {
    "sector_fit_score": number,
    "founder_experience_score": number,
    "traction_score": number,
    "capital_readiness_score": number,
    "overall_score": number
  },
  "market_data_cited": [
    { "metric_name": string, "source_name": string, "date_of_data": string }
  ]
}`;

// ============================================================
// Función auxiliar — llamada a Claude
// ============================================================
async function callClaude(systemPrompt, userMessage, temperature) {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      temperature,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text block in Claude response');

  const cleaned = textBlock.text.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Failed to parse JSON from Claude response: ${cleaned.slice(0, 300)}`);
  }
}

// ============================================================
// Query filtrada de datos de mercado — nunca traemos la tabla completa
// ============================================================
async function getRelevantMarketData(sector, sectorSubcategory) {
  // Construimos el filtro dinámicamente para evitar el bug de "subcategory.eq.null"
  // cuando sectorSubcategory viene vacío desde Etapa 1.
  const filters = ['category.eq.ecosystem', 'category.eq.vc_investment', 'category.eq.comparables'];

  if (sector) filters.push(`category.eq.${sector}`);
  if (sectorSubcategory) filters.push(`subcategory.eq.${sectorSubcategory}`);

  const { data, error } = await supabase
    .from('market_data_citable')
    .select('*')
    .or(filters.join(','));

  if (error) throw new Error(`Supabase query error: ${error.message}`);
  return data;
}

// ============================================================
// Vista facturable — misma data, lenguaje suavizado para red_flags
// ============================================================
function buildClientFacingReport(assessment) {
  return {
    snapshot: assessment.snapshot,
    stage_assessment: assessment.stage_assessment,
    strengths: assessment.strengths,
    areas_to_strengthen: assessment.red_flags,
    sector_fit: assessment.sector_fit,
    capital_readiness: assessment.capital_readiness,
    recommended_next_step: assessment.recommended_next_step,
    // El rubric numérico NUNCA se expone al cliente — es herramienta interna de Elevare.
  };
}

// ============================================================
// Handler principal
// ============================================================
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { aplicacion_id, form_responses } = req.body;

  if (!aplicacion_id || !form_responses) {
    return res.status(400).json({ error: 'aplicacion_id y form_responses son requeridos' });
  }

  try {
    // ETAPA 1: Extracción
    const structuredData = await callClaude(
      EXTRACTION_SYSTEM_PROMPT,
      JSON.stringify(form_responses),
      0.2
    );

    // Datos de mercado relevantes al sector detectado
    const marketData = await getRelevantMarketData(
      structuredData.sector,
      structuredData.sector_subcategory
    );

    // ETAPA 2: Assessment
    const userMessageEtapa2 = `DATOS ESTRUCTURADOS DEL STARTUP:\n${JSON.stringify(structuredData)}\n\nDATOS DE MERCADO VERIFICADOS:\n${JSON.stringify(marketData)}`;

    const assessmentDraft = await callClaude(ASSESSMENT_SYSTEM_PROMPT, userMessageEtapa2, 0.4);

    assessmentDraft.model_version = CLAUDE_MODEL;
    assessmentDraft.generation_timestamp = new Date().toISOString();

    const clientFacingReport = buildClientFacingReport(assessmentDraft);

    // Guardar en Supabase — SIEMPRE en estado 'draft'
    const { data: savedAssessment, error: saveError } = await supabase
      .from('startup_assessments')
      .insert({
        aplicacion_id,
        structured_data: structuredData,
        extraction_flags: structuredData.extraction_flags || [],
        assessment_draft: assessmentDraft,
        client_facing_report: clientFacingReport,
        status: 'draft',
        market_data_snapshot_ids: marketData.map((d) => d.id),
      })
      .select()
      .single();

    if (saveError) throw new Error(`Error guardando assessment: ${saveError.message}`);

    return res.status(200).json({
      success: true,
      assessment_id: savedAssessment.id,
      extraction_flags: structuredData.extraction_flags,
      requires_review: (structuredData.extraction_flags || []).length > 0,
    });
  } catch (err) {
    console.error('Error generando assessment:', err);
    return res.status(500).json({ error: err.message });
  }
}
