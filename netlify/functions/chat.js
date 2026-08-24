// netlify/functions/chat.js
//
// Função serverless (roda no servidor do Netlify, nunca no navegador do usuário).
// Recebe a pergunta do usuário + um resumo dos dados do Portal, chama a API da
// Anthropic usando a chave guardada em variável de ambiente (ANTHROPIC_API_KEY) e
// devolve a resposta em texto. A chave nunca é enviada nem fica visível pro navegador —
// só esse arquivo, rodando no servidor, tem acesso a ela.

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 3072;

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return resposta(405, { erro: 'Método não permitido' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return resposta(500, { erro: 'Chave de API não configurada no servidor. Configure ANTHROPIC_API_KEY nas variáveis de ambiente do site, no Netlify.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return resposta(400, { erro: 'Corpo da requisição inválido' });
  }

  const { pergunta, contexto, historico } = payload;
  if (!pergunta || typeof pergunta !== 'string') {
    return resposta(400, { erro: 'Pergunta não informada' });
  }

  const systemPrompt = `Você é o assistente de IA do Portal DMCON, um sistema de gestão da DMCON Contabilidade/RISE BPO.
Responda perguntas do usuário com base EXCLUSIVAMENTE nos dados do Portal fornecidos abaixo. Seja direto, claro e responda em português do Brasil.

REGRAS DE EXATIDÃO (muito importantes — o usuário quer o número EXATO que o sistema tem, não uma estimativa):
1. Os dados trazem linhas "por mês, TODO O HISTÓRICO (todos os anos)" no formato "2025 -> Jan: 0, Fev: 2, ... | 2026 -> Jan: 3, ... Ago: 5". Essas contagens já foram calculadas em cima de TODOS os registros do sistema (não só os listados por extenso) — são a fonte oficial e exata pra qualquer pergunta de quantidade por mês/ano. NUNCA conte manualmente itens de uma lista de texto pra responder uma pergunta de quantidade — sempre procure primeiro se já existe uma contagem pronta pra isso nos dados, e use esse número exato.
2. Para perguntas do tipo "quantos clientes eu fechei/entraram em tal mês", a fonte CORRETA é o bloco CLIENTES (OPERAÇÃO), contagem por "início vínculo" (data em que o cliente efetivamente passou a ter vínculo com a DMCON) — NÃO o bloco COMERCIAL (que só mostra quando a venda foi fechada, podendo cair em mês diferente). O próprio contexto já explica isso quando relevante; siga essa prioridade.
3. Para números que também aparecem no Dashboard do Portal (processos fora do prazo, contratos aguardando revisão, clientes ativos), use o bloco RESUMO GERAL — ele foi calculado exatamente do mesmo jeito que os cards da tela, pra nunca divergir do que a pessoa está vendo.
4. Se uma lista de itens individuais foi cortada por ser muito grande, isso aparece explicitamente no texto ("mostrando os primeiros X de Y") — mesmo assim, as CONTAGENS totais e por mês continuam exatas para os Y registros inteiros; não diga que só existem X.
5. Para processos societários em andamento, cada um vem com "Já feito" (o que já foi concluído no checklist) e "Falta fazer" (o que ainda falta) — quando perguntarem como está o processo de uma empresa, resuma essas duas listas de forma clara, e não apenas a etapa/status geral.
6. Se mesmo assim a pergunta não puder ser respondida com os dados fornecidos, diga isso claramente em vez de inventar informação. Nunca arredonde ou aproxime um número que está disponível exato nos dados.

Formate valores em reais como "R$ X.XXX". Responda em texto corrido ou listas simples, sem markdown complexo (sem tabelas). Pode ser detalhado quando a pergunta pedir uma lista ou um levantamento — não corte a resposta por economia, o usuário prefere a informação completa.

DADOS ATUAIS DO PORTAL:
${contexto || '(nenhum dado disponível no momento)'}`;

  const historicoValido = Array.isArray(historico)
    ? historico.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-10)
    : [];

  const mensagens = [...historicoValido, { role: 'user', content: pergunta }];

  try {
    const apiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: mensagens,
      }),
    });

    const data = await apiResp.json();

    if (!apiResp.ok) {
      console.error('Erro da API Anthropic:', data);
      return resposta(502, { erro: (data && data.error && data.error.message) || 'Erro ao consultar a IA' });
    }

    const texto = (data.content || []).map(b => b.text || '').join('').trim() || 'Não consegui gerar uma resposta.';
    return resposta(200, { resposta: texto });
  } catch (e) {
    console.error('Erro ao chamar a API Anthropic:', e);
    return resposta(500, { erro: 'Erro interno ao consultar a IA' });
  }
};

function resposta(statusCode, obj) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj),
  };
}
