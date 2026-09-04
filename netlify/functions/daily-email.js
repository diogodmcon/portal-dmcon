// netlify/functions/daily-email.js
//
// Função AGENDADA (roda sozinha todo dia às 8h da manhã de Brasília, sem ninguém precisar abrir
// o Portal — ver o agendamento em netlify.toml). Ela:
//   1) Busca no Supabase os dados do Fiscal que o Portal já salva sozinho (apurações, obrigações
//      acessórias, histórico de ações, e um resumo de empresas/responsáveis — ver a função
//      fopSalvar() no index.html) e a lista de usuários (pra descobrir o e-mail de cada um).
//   2) Monta o resumo de "o que foi feito ontem" e "o que falta fazer hoje" no Fiscal.
//   3) Manda um e-mail pros GESTORES com a visão geral do escritório inteiro, e um e-mail
//      individual pra cada responsável fiscal, só com as pendências dele(a).
//   4) Envia tudo pelo EmailJS (o mesmo serviço já usado pros outros avisos automáticos do
//      Portal), usando a API deles pra uso em servidor — isso exige a CHAVE PRIVADA do EmailJS
//      guardada como variável de ambiente EMAILJS_PRIVATE_KEY no Netlify (ver README.md).
//
// Este arquivo só cobre o módulo FISCAL por enquanto (apurações + obrigações acessórias).
//
// As chaves do Supabase usadas abaixo são as mesmas chaves "públicas" que já vão dentro do
// index.html (o navegador de qualquer usuário logado já as usa) — não precisa de nenhuma chave
// nova do Supabase pra isso funcionar.

const SUPABASE_URL = 'https://kyhrnidgejhbuvrgqjki.supabase.co';
const SUPABASE_KEY = 'sb_publishable_m5PX-oFVXeCoGIbntiv-2w_gF7txmgn';

const EMAILJS_SERVICE_ID = 'service_2nj95me';
const EMAILJS_PUBLIC_KEY = 'wx0NN-MhY_8wD1eWx';
// Template SEPARADO do usado pros avisos de evento (template_9bn7xib) — esse aqui precisa
// aceitar um corpo de texto grande. Crie um template novo no EmailJS com os campos {{to_name}},
// {{titulo}} e {{corpo}}, e cole o ID dele na variável de ambiente EMAILJS_TEMPLATE_DIGEST_ID
// (Netlify → Site settings → Environment variables). Sem isso, a função não sabe pra qual
// template do EmailJS mandar o resumo.
const EMAILJS_TEMPLATE_DIGEST_ID = process.env.EMAILJS_TEMPLATE_DIGEST_ID || '';

// Quem recebe o resumo de GESTOR (mesmo critério de "Acesso de Gestor" usado dentro do Portal).
const EMAILS_GESTORES = [
  { email: 'diogo@dmcon.com.br', nome: 'Diogo' },
  { email: 'marilia@dmcon.com.br', nome: 'Marília' },
];

// Fallback de e-mails já confirmados, pro caso de algum usuário ainda não ter e-mail cadastrado
// no Supabase (mesmos endereços usados nos outros avisos automáticos do Portal — ver
// EMAILS_RESPONSAVEIS no index.html). Complete aqui à medida que for confirmando mais gente, ou
// (melhor ainda) cadastre o e-mail de cada um em 👤 Usuários dentro do Portal.
const EMAILS_CONHECIDOS = {
  'DIOGO': 'diogo@dmcon.com.br', 'DF': 'diogo@dmcon.com.br', 'MASTER': 'diogo@dmcon.com.br',
  'MARILIA': 'marilia@dmcon.com.br', 'MF': 'marilia@dmcon.com.br',
  'ANDREZA': 'andreza@dmcon.com.br', 'ANDRESA': 'andreza@dmcon.com.br', 'AN': 'andreza@dmcon.com.br',
  'CAMILA': 'camila@dmcon.com.br', 'CA': 'camila@dmcon.com.br',
};

const FOP_LABELS = {
  icms:'ICMS', fundos:'Fundos Est.', ipi:'IPI', pis_cofins:'PIS/COFINS', iss:'ISS', retidos:'Retidos',
  irpj_csll:'IRPJ/CSLL', pgdas:'PGDAS', das_mei:'DAS MEI', conferencia:'Conferência',
  efd_contrib:'EFD Contribuições', efd_reinf:'EFD-Reinf', mit:'MIT', sped_fiscal:'SPED Fiscal',
  sintegra:'SINTEGRA', destda:'DeSTDA',
};

// Mesmas regras de fopGetImpostos()/fopGetAcessorias() do index.html — duplicadas aqui porque
// este arquivo roda no servidor e não tem acesso ao código do navegador. Se um dia mudar as
// regras lá (ex.: novo imposto, nova obrigação), precisa mudar aqui também.
function fopGetImpostos(empresa) {
  const t = (empresa.tributacao || '').toLowerCase().trim();
  const ie = (empresa.inscEst || '').trim();
  const temIE = ie && ie !== 'Isento' && ie !== 'SEM IE' && ie !== '-' && ie !== '';
  if (t.includes('simples')) return ['pgdas'];
  if (t === 'mei') return ['das_mei'];
  if (t.includes('associa')) return ['iss', 'retidos'];
  const base = ['pis_cofins', 'iss', 'retidos', 'irpj_csll'];
  if (temIE) return ['icms', 'fundos', 'ipi', ...base];
  return base;
}
function fopGetAcessorias(empresa) {
  if (/filial/i.test(empresa.nome || '')) return ['sped_fiscal'];
  const t = (empresa.tributacao || '').toLowerCase().trim();
  const ie = (empresa.inscEst || '').trim();
  const temIE = ie && ie !== 'Isento' && ie !== 'SEM IE' && ie !== '-' && ie !== '';
  if (t.includes('simples')) return temIE ? ['sintegra', 'destda'] : [];
  if (t === 'mei') return [];
  const acess = ['efd_contrib', 'efd_reinf', 'mit'];
  if (temIE) acess.push('sped_fiscal');
  return acess;
}

function fopGetKey(cnpj, ano, mes) { return `${cnpj}_${ano}_${String(mes).padStart(2, '0')}`; }

// ── Datas — Brasília/Itajaí-SC está fixo em UTC-3 (sem horário de verão desde 2019). Calculamos
// tudo a partir do instante UTC atual, sem depender do fuso horário configurado no servidor. ──
const MS_OFFSET_BRT = 3 * 60 * 60 * 1000;

function calcularReferenciaDeTempo(agoraUTC) {
  const comoBRT = new Date(agoraUTC.getTime() - MS_OFFSET_BRT); // campos UTC = data/hora civis em BRT
  const anoRef = comoBRT.getUTCFullYear();
  const mesRef = comoBRT.getUTCMonth() + 1; // 1-12, mês corrente (BRT)
  const diaRef = comoBRT.getUTCDate();
  const mesIndexUTC = comoBRT.getUTCMonth();
  // Fronteiras do dia de ONTEM (calendário BRT), como instantes UTC reais — pra comparar com os
  // timestamps ISO (sempre UTC) gravados no histórico do Fiscal.
  const inicioOntemUTC = new Date(Date.UTC(anoRef, mesIndexUTC, diaRef - 1, 0, 0, 0) + MS_OFFSET_BRT);
  const fimOntemUTC = new Date(Date.UTC(anoRef, mesIndexUTC, diaRef, 0, 0, 0) + MS_OFFSET_BRT);
  const hojeLabel = new Date(Date.UTC(anoRef, mesIndexUTC, diaRef, 12));
  const ontemLabel = new Date(Date.UTC(anoRef, mesIndexUTC, diaRef - 1, 12));
  return { anoRef, mesRef, diaRef, inicioOntemUTC, fimOntemUTC, hojeLabel, ontemLabel };
}

function fmtData(d) {
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
}

// Acha o e-mail de um "responsável" (nome, iniciais, ou fiscalResp) cruzando com a lista de
// usuários vinda do Supabase, com fallback pro mapa de e-mails já confirmados acima.
function acharEmail(nomeOuResp, usuarios) {
  if (!nomeOuResp) return null;
  const alvo = nomeOuResp.trim().toUpperCase();
  if (!alvo) return null;
  const porNome = usuarios.find(u => u.email && (u.nome || '').trim().toUpperCase() === alvo);
  if (porNome) return { email: porNome.email, nome: porNome.nome };
  const porIniciais = usuarios.find(u => u.email && (u.iniciais || '').trim().toUpperCase() === alvo);
  if (porIniciais) return { email: porIniciais.email, nome: porIniciais.nome };
  const porFiscalResp = usuarios.find(u => u.email && ((u.fiscalResp || u.fiscal_resp || '').trim().toUpperCase() === alvo));
  if (porFiscalResp) return { email: porFiscalResp.email, nome: porFiscalResp.nome };
  const porParcial = usuarios.find(u => u.email && (u.nome || '').trim().toUpperCase().includes(alvo));
  if (porParcial) return { email: porParcial.email, nome: porParcial.nome };
  if (EMAILS_CONHECIDOS[alvo]) return { email: EMAILS_CONHECIDOS[alvo], nome: nomeOuResp };
  return null;
}

// Resumo de status de um imposto/obrigação (mesma lógica de status usada no Portal — ver
// FOP_STATUS no index.html): 'finalizado' = entregue; 'na' = não se aplica (ignorado); qualquer
// outra coisa (vazio, apurando, disponível, aprovado, correção) = ainda falta.
function processarFamilia(clientes, getObrigs, apurStore, ano, mes) {
  const porResp = {}; // { responsável: {empresas, apuradas, correcoes} }
  const pendentesPorResp = {}; // { RESPONSAVEL_MAIUSCULO: [ "Empresa — Imposto, Imposto (em correção)" ] }

  clientes.forEach(c => {
    const obrigs = getObrigs(c);
    if (!obrigs.length) return;
    const chave = fopGetKey(c.cnpj, ano, mes);
    const apur = apurStore[chave] || {};
    const resp = (c.respMes || '').split('-')[0].trim() || 'Sem responsável';
    if (!porResp[resp]) porResp[resp] = { empresas: 0, apuradas: 0, correcoes: 0 };
    porResp[resp].empresas++;

    let temCorrecao = false;
    const faltando = [];
    let totalReal = 0, finalReal = 0;
    obrigs.forEach(imp => {
      const st = (apur[imp] || {}).status || '';
      if (st === 'na') return;
      totalReal++;
      if (st === 'finalizado') finalReal++;
      else { faltando.push(FOP_LABELS[imp] || imp); if (st === 'correcao') temCorrecao = true; }
    });
    if (temCorrecao) porResp[resp].correcoes++;

    if (totalReal > 0 && finalReal === totalReal) {
      porResp[resp].apuradas++;
    } else if (faltando.length) {
      const chaveResp = resp.toUpperCase();
      if (!pendentesPorResp[chaveResp]) pendentesPorResp[chaveResp] = [];
      pendentesPorResp[chaveResp].push(`${c.nome} — ${faltando.join(', ')}${temCorrecao ? ' (em correção)' : ''}`);
    }
  });

  return { porResp, pendentesPorResp };
}

// Monta o texto do e-mail dos gestores e a lista de e-mails individuais a enviar. Função PURA
// (não faz I/O) pra dar pra testar sem precisar de rede — ver test_daily_email.js.
function montarResumo({ clientes, fopApur, fopApurAcess, fopHistorico, usuarios, agoraUTC }) {
  const { anoRef, mesRef, inicioOntemUTC, fimOntemUTC, hojeLabel, ontemLabel } = calcularReferenciaDeTempo(agoraUTC);

  const acoesOntem = fopHistorico.filter(h => {
    const ts = new Date(h.ts);
    return ts >= inicioOntemUTC && ts < fimOntemUTC;
  });
  const porUsuarioOntem = {};
  acoesOntem.forEach(a => {
    const u = a.usuario || 'Usuário';
    if (!porUsuarioOntem[u]) porUsuarioOntem[u] = [];
    porUsuarioOntem[u].push(a);
  });

  const rApur = processarFamilia(clientes, c => fopGetImpostos(c), fopApur, anoRef, mesRef);
  const rAcess = processarFamilia(clientes, c => fopGetAcessorias(c), fopApurAcess, anoRef, mesRef);

  const totEmpApur = Object.values(rApur.porResp).reduce((s, d) => s + d.empresas, 0);
  const apuradasApur = Object.values(rApur.porResp).reduce((s, d) => s + d.apuradas, 0);
  const totEmpAcess = Object.values(rAcess.porResp).reduce((s, d) => s + d.empresas, 0);
  const apuradasAcess = Object.values(rAcess.porResp).reduce((s, d) => s + d.apuradas, 0);

  let corpoGestor = `Resumo do Fiscal — ${fmtData(hojeLabel)}\n\n`;
  corpoGestor += `O QUE FOI FEITO ONTEM (${fmtData(ontemLabel)}):\n`;
  if (!acoesOntem.length) {
    corpoGestor += 'Nenhuma ação registrada ontem.\n';
  } else {
    Object.entries(porUsuarioOntem).forEach(([u, acoes]) => {
      corpoGestor += `\n${u} (${acoes.length} ${acoes.length > 1 ? 'ações' : 'ação'}):\n`;
      acoes.slice(0, 20).forEach(a => {
        const impStr = (a.imposto && a.imposto !== '—') ? ' — ' + (FOP_LABELS[a.imposto] || a.imposto) : '';
        corpoGestor += `  • ${a.empresa}${impStr} — ${a.acao}\n`;
      });
      if (acoes.length > 20) corpoGestor += `  ... e mais ${acoes.length - 20} ação(ões).\n`;
    });
  }

  corpoGestor += `\n\nSITUAÇÃO HOJE (mês ${String(mesRef).padStart(2, '0')}/${anoRef}):\n`;
  corpoGestor += `Apurações: ${apuradasApur} de ${totEmpApur} empresas já apuraram tudo (${totEmpApur - apuradasApur} faltando).\n`;
  corpoGestor += `Obrigações Acessórias: ${apuradasAcess} de ${totEmpAcess} empresas já entregaram tudo (${totEmpAcess - apuradasAcess} faltando).\n`;

  const todosResp = new Set([...Object.keys(rApur.porResp), ...Object.keys(rAcess.porResp)]);
  const naoIdentificados = new Set();
  corpoGestor += `\nPendências por responsável:\n`;
  [...todosResp].sort().forEach(r => {
    const a = rApur.porResp[r] || { empresas: 0, apuradas: 0, correcoes: 0 };
    const b = rAcess.porResp[r] || { empresas: 0, apuradas: 0, correcoes: 0 };
    const correcoes = a.correcoes + b.correcoes;
    corpoGestor += `  • ${r}: apurações ${a.apuradas}/${a.empresas}, acessórias ${b.apuradas}/${b.empresas}${correcoes ? `, ${correcoes} em correção` : ''}\n`;
    if (!acharEmail(r, usuarios)) naoIdentificados.add(r);
  });
  if (naoIdentificados.size) {
    corpoGestor += `\n⚠️ Não encontrei e-mail cadastrado pra: ${[...naoIdentificados].join(', ')} — essas pessoas não receberam o e-mail individual de tarefas hoje. Cadastre o e-mail delas em 👤 Usuários no Portal.\n`;
  }

  // Junta as pendências de apurações + acessórias por responsável, pro e-mail individual.
  const pendentesPorResp = {};
  [rApur.pendentesPorResp, rAcess.pendentesPorResp].forEach(mapa => {
    Object.entries(mapa).forEach(([resp, itens]) => {
      if (!pendentesPorResp[resp]) pendentesPorResp[resp] = [];
      pendentesPorResp[resp].push(...itens);
    });
  });

  const emailsIndividuais = [];
  Object.entries(pendentesPorResp).forEach(([resp, itens]) => {
    const contato = acharEmail(resp, usuarios);
    if (!contato) return; // já reportado na lista de não identificados acima
    const primeiroNome = (contato.nome || resp).split(' ')[0];
    let corpo = `Bom dia, ${primeiroNome}!\n\nHoje (${fmtData(hojeLabel)}) suas pendências no Fiscal são:\n\n`;
    itens.forEach(it => { corpo += `• ${it}\n`; });
    corpo += `\nEntre no Portal DMCON pra dar andamento. Bom trabalho!`;
    emailsIndividuais.push({ email: contato.email, nome: contato.nome, responsavel: resp, itens: itens.length, corpo, titulo: `Suas tarefas de hoje — ${fmtData(hojeLabel)}` });
  });

  return {
    tituloGestor: `Resumo Fiscal — ${fmtData(hojeLabel)}`,
    corpoGestor,
    emailsIndividuais,
    naoIdentificados: [...naoIdentificados],
    stats: { totEmpApur, apuradasApur, totEmpAcess, apuradasAcess, acoesOntem: acoesOntem.length },
  };
}

// ── I/O (Supabase + EmailJS) — separado da lógica pura acima ──
async function supaSelect(tabela, query) {
  const url = `${SUPABASE_URL}/rest/v1/${tabela}?${query}`;
  const resp = await fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  if (!resp.ok) throw new Error(`Erro ao consultar ${tabela}: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function enviarEmail(destinatario, nome, titulo, corpo) {
  const privateKey = process.env.EMAILJS_PRIVATE_KEY;
  if (!privateKey || !EMAILJS_TEMPLATE_DIGEST_ID) {
    console.warn('EMAILJS_PRIVATE_KEY ou EMAILJS_TEMPLATE_DIGEST_ID não configurados — e-mail NÃO enviado para', destinatario);
    return { ok: false, erro: 'Configuração do EmailJS incompleta (ver variáveis de ambiente no Netlify)' };
  }
  try {
    const resp = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_DIGEST_ID,
        user_id: EMAILJS_PUBLIC_KEY,
        accessToken: privateKey,
        template_params: { to_email: destinatario, to_name: nome, name: 'Portal DMCON', titulo, corpo },
      }),
    });
    if (!resp.ok) throw new Error(`${resp.status} ${await resp.text()}`);
    return { ok: true };
  } catch (e) {
    console.warn('Erro ao enviar e-mail para', destinatario, ':', e.message);
    return { ok: false, erro: e.message };
  }
}

exports.handler = async function () {
  try {
    const chaves = ['fiscal_apur', 'fiscal_apur_acess', 'fiscal_historico', 'fiscal_clientes_resolvido'];
    const linhas = await supaSelect('configuracoes', `chave=in.(${chaves.map(c => `"${c}"`).join(',')})&select=chave,valor`);
    const dados = {};
    linhas.forEach(l => { try { dados[l.chave] = JSON.parse(l.valor); } catch (e) { dados[l.chave] = null; } });

    const clientes = dados.fiscal_clientes_resolvido || [];
    if (!clientes.length) {
      console.warn('daily-email: nenhum cliente no snapshot "fiscal_clientes_resolvido" ainda — abra o Portal e faça qualquer ação no Fiscal pra esse snapshot ser gerado pela 1ª vez.');
    }

    let usuarios = [];
    try { usuarios = await supaSelect('usuarios', 'select=*&ativo=eq.true'); } catch (e) { console.warn('Erro ao buscar usuarios:', e.message); }

    const resumo = montarResumo({
      clientes,
      fopApur: dados.fiscal_apur || {},
      fopApurAcess: dados.fiscal_apur_acess || {},
      fopHistorico: dados.fiscal_historico || [],
      usuarios,
      agoraUTC: new Date(),
    });

    const resultados = [];
    for (const g of EMAILS_GESTORES) {
      const r = await enviarEmail(g.email, g.nome, resumo.tituloGestor, resumo.corpoGestor);
      resultados.push({ para: g.email, tipo: 'gestor', ...r });
    }
    for (const e of resumo.emailsIndividuais) {
      const r = await enviarEmail(e.email, e.nome, e.titulo, e.corpo);
      resultados.push({ para: e.email, tipo: 'colaborador', responsavel: e.responsavel, itens: e.itens, ...r });
    }

    console.log('daily-email concluído:', JSON.stringify({ stats: resumo.stats, naoIdentificados: resumo.naoIdentificados, resultados }));
    return { statusCode: 200, body: JSON.stringify({ ok: true, enviados: resultados.length, resultados, naoIdentificados: resumo.naoIdentificados }) };
  } catch (e) {
    console.error('daily-email erro:', e);
    return { statusCode: 500, body: JSON.stringify({ ok: false, erro: e.message }) };
  }
};

// Exporta as peças internas só pra dar pra testar sem depender de rede (ver test_daily_email.js).
exports._internal = { montarResumo, calcularReferenciaDeTempo, fopGetImpostos, fopGetAcessorias, acharEmail, fmtData };
