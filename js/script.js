// ===================== MÁSCARA MONETÁRIA BR =====================
function parseBR(val) {
  if (typeof val !== 'string') val = String(val || '');
  // Remove pontos de milhar, troca vírgula por ponto
  return parseFloat(val.replace(/\./g, '').replace(',', '.')) || 0;
}

function aplicarMascaraMoeda(el) {
  el.addEventListener('input', function() {
    let v = this.value.replace(/\D/g, ''); // só dígitos
    if (!v) { this.value = ''; return; }
    v = (parseInt(v, 10) / 100).toFixed(2);
    this.value = v.replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  });
  el.addEventListener('focus', function() {
    if (!this.value) this.value = '';
  });
}

function aplicarMascaraPercentual(el) {
  el.addEventListener('input', function() {
    let v = this.value.replace(/\D/g, '');
    if (!v) { this.value = ''; return; }
    v = (parseInt(v, 10) / 100).toFixed(2);
    // Limita a 100,00
    if (parseFloat(v) > 100) v = '100.00';
    this.value = v.replace('.', ',');
  });
}

function formatarBR(num, decimais = 2) {
  if (isNaN(num)) return '';
  return num.toFixed(decimais).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.input-moeda').forEach(aplicarMascaraMoeda);
  document.querySelectorAll('.input-pct').forEach(aplicarMascaraPercentual);
});

// ===================== VARIÁVEIS GLOBAIS E CONSTANTES =====================
const DB_VERSION = 3;
let db; // será o objeto Firestore
let usuarioLogado = null;
let simulacaoAtual = [];

const PISO_MENSAL_ASSESSOR = 2000;
const VALOR_FIXO_SDR = 2000;

let configPassagem = {
  metro: 7.90,
  onibus: 5.00
};

const PRODUTOS_GENIAL = ["BTC", "Bmf", "Bovespa", "CRI/CRA", "Clubes", "Debênture", "Fundos C.O", "Mercado Secundário"];
const PRODUTO_REPASSE_IMPORTADO = "Repasse Genial (Importado)";
const PRODUTOS = ["Renda Fixa", "Fundos", "Seguro", "Consórcio", "Renda Variável", "Plano de Saúde", ...PRODUTOS_GENIAL];
const SEGURADORAS = ["Azos", "Bradesco", "Genial", "Icatu", "MAG", "MetLife", "Porto"];
const ADMINISTRADORAS_CONSORCIO = ["HS", "Ademicon", "Embracon"];
const TIPOS_RENDA_VARIAVEL = ["Ações", "Opções"];
const EMPRESAS_PLANO_SAUDE = ["Sul América", "Porto", "Bradesco", "HapVida"];

// Mapeamento dos códigos/nomes de assessor da planilha da Genial para o nome do funcionário no sistema
const MAPEAMENTO_REPASSE_GENIAL = {
  "RT 2": "Pablo Henrique",
  "RT 3": "Cauã Barqueta",
  "RT 4": "Wagner Pinheiro de Barros",
  "RT 9": "Gabriel Almeida de Sousa",
  "LUCAS DE ARAÚJO FELIZARDO DA SILVA": "Lucas de Araújo Felizardo da Silva",
  "DAVI DA SILVA FARIA": "Davi da Silva Faria"
};

function normalizarNome(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

const ADMINS_PADRAO = [
  { nome: "Gabriel Almeida", login: "gabriel.almeida", senha: "Ritmo@1234" }
];

// ===================== FIREBASE / FIRESTORE SHIM =====================
// Shim que mantém a mesma API do IndexedDB mas usa Firestore por baixo

function abrirBanco() {
  // db é o objeto Firestore injetado pelo firebase-init.js (window.__firestoreDb)
  return new Promise((resolve) => {
    const check = () => {
      if (window.__firestoreDb) {
        db = window.__firestoreDb;
        resolve(db);
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

// Helpers que buscam APIs Firestore em tempo de execução
function _api() { return window.__firestoreApi; }
function _col(name) { return _api().collection(db, name); }
function _doc(name, id) { return _api().doc(db, name, String(id)); }

// Shim tx() — retorna objeto com mesma interface do IndexedDB
function tx(storeName, mode = 'readonly') {
  return {
    getAll: () => ({
      _promise: _api().getDocs(_col(storeName)).then(snap =>
        snap.docs.map(d => ({ id: d.id, ...d.data() }))
      )
    }),
    get: (id) => ({
      _promise: _api().getDoc(_doc(storeName, id)).then(d =>
        d.exists() ? { id: d.id, ...d.data() } : undefined
      )
    }),
    add: (data) => ({
      _promise: _api().addDoc(_col(storeName), data).then(ref => ref.id)
    }),
    put: (data) => ({
      _promise: (() => {
        const { id, ...rest } = data;
        return _api().setDoc(_doc(storeName, id), rest).then(() => id);
      })()
    }),
    delete: (id) => ({
      _promise: _api().deleteDoc(_doc(storeName, id)).then(() => undefined)
    }),
    clear: () => ({
      _promise: _api().getDocs(_col(storeName)).then(async snap => {
        for (const d of snap.docs) await _api().deleteDoc(d.ref);
      })
    }),
    index: (field) => ({
      get: (value) => ({
        _promise: _api().getDocs(_api().query(_col(storeName), _api().where(field, '==', value))).then(snap => {
          if (snap.empty) return undefined;
          const d = snap.docs[0];
          return { id: d.id, ...d.data() };
        })
      }),
      getAll: (value) => ({
        _promise: _api().getDocs(_api().query(_col(storeName), _api().where(field, '==', value))).then(snap =>
          snap.docs.map(d => ({ id: d.id, ...d.data() }))
        )
      })
    })
  };
}

function promisify(req) {
  if (req && req._promise) return req._promise;
  return Promise.resolve(req);
}

async function limparDadosExemplo() {
  const jaLimpou = localStorage.getItem("dados_exemplo_removidos_v3");
  if (!jaLimpou) {
    try {
      await promisify(tx('funcionarios', 'readwrite').clear());
      await promisify(tx('vendas', 'readwrite').clear());
      await promisify(tx('passagens', 'readwrite').clear());
      await promisify(tx('aprovacoes', 'readwrite').clear());

      const todosUsuarios = await promisify(tx('usuarios').getAll());
      for (const u of todosUsuarios) {
        if (u.login && u.login.toLowerCase() !== "gabriel.almeida") {
          await promisify(tx('usuarios', 'readwrite').delete(u.id));
        }
      }
      localStorage.setItem("dados_exemplo_removidos_v3", "true");
    } catch (e) {
      console.warn("Erro ao limpar dados de exemplo:", e);
    }
  }
}

async function garantirAdminsPadrao() {
  const usuarios = await promisify(tx('usuarios').getAll());
  for (const admin of ADMINS_PADRAO) {
    const existe = usuarios.find(u => u.login && u.login.toLowerCase() === admin.login.toLowerCase());
    if (!existe) {
      await promisify(tx('usuarios', 'readwrite').add({
        nome: admin.nome,
        login: admin.login,
        senha: admin.senha,
        tipo: 'admin',
        funcionarioId: null,
        ativo: true
      }));
    } else {
      let modificado = false;
      if (existe.senha !== admin.senha) { existe.senha = admin.senha; modificado = true; }
      if (existe.tipo !== 'admin') { existe.tipo = 'admin'; modificado = true; }
      if (!existe.ativo) { existe.ativo = true; modificado = true; }
      if (modificado) {
        await promisify(tx('usuarios', 'readwrite').put(existe));
      }
    }
  }
}

async function carregarConfigPassagem() {
  const configSalva = await promisify(tx("configuracoes").get("passagem"));
  if (configSalva) configPassagem = { metro: configSalva.metro, onibus: configSalva.onibus };
  atualizarValorPassagemLabel(); // Garante que os labels sejam atualizados na carga
}

// ===================== UTILS =====================

function formatarMoeda(valor) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(valor);
}

function formatarCompetencia(competencia) {
  if (!competencia) return "N/A";
  const [ano, mes] = competencia.split("-");
  return `${mes}/${ano}`;
}

function formatarCompetenciaExtenso(competencia) {
  if (!competencia) return "N/A";
  const [ano, mes] = competencia.split("-");
  const meses = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
  return `${meses[parseInt(mes,10)-1]} de ${ano}`;
}

function competenciaAtualDoSistema() {
  const hoje = new Date();
  const ano = hoje.getFullYear();
  const mes = (hoje.getMonth() + 1).toString().padStart(2, '0');
  return `${ano}-${mes}`;
}

function proximaCompetencia(competencia) {
  const [ano, mes] = competencia.split("-").map(Number);
  let proximoMes = mes + 1;
  let proximoAno = ano;
  if (proximoMes > 12) {
    proximoMes = 1;
    proximoAno++;
  }
  return `${proximoAno}-${proximoMes.toString().padStart(2, '0')}`;
}

// ===================== AUTENTICAÇÃO =====================

async function fazerLogin() {
  const login = document.getElementById("input-login").value;
  const senha = document.getElementById("input-senha").value;
  const erroEl = document.getElementById("erro-login");

  const usuario = await promisify(tx("usuarios").index("login").get(login));

  if (usuario && usuario.senha === senha && usuario.ativo) {
    usuarioLogado = usuario;
    sessionStorage.setItem("usuarioLogadoId", usuario.id); // string ID
    erroEl.textContent = "";
    await verificarSessao();
  } else {
    erroEl.textContent = "Login ou senha inválidos, ou usuário inativo.";
  }
}

async function fazerLogout() {
  usuarioLogado = null;
  sessionStorage.removeItem("usuarioLogadoId");
  await verificarSessao();
}

async function verificarSessao() {
  const usuarioId = sessionStorage.getItem("usuarioLogadoId"); // string
  if (usuarioId) {
    usuarioLogado = await promisify(tx("usuarios").get(usuarioId));
    if (!usuarioLogado || !usuarioLogado.ativo) {
      usuarioLogado = null;
      sessionStorage.removeItem("usuarioLogadoId");
    }
  }

  if (usuarioLogado) {
    document.getElementById("tela-login").style.display = "none";
    document.getElementById("app-shell").style.display = "flex";
    document.getElementById("texto-usuario-logado").textContent = `Logado como: ${usuarioLogado.nome} (${usuarioLogado.tipo})`;
    await renderizarMenu();
    mudarAba("view-painel"); // Garante que a primeira aba seja exibida
  } else {
    document.getElementById("tela-login").style.display = "flex";
    document.getElementById("app-shell").style.display = "none";
    document.getElementById("input-login").value = "";
    document.getElementById("input-senha").value = "";
  }
}

// ===================== NAVEGAÇÃO E RENDERIZAÇÃO DE ABAS =====================

async function renderizarMenu() {
  const menuLateral = document.getElementById("menu-lateral");
  menuLateral.innerHTML = "";

  const menuItems = [
    { id: "view-painel", label: "👥 Remuneração", roles: ["admin", "assessor", "sdr"] },
    { id: "view-lancar", label: "📝 Lançar Repasse", roles: ["admin"] },
    { id: "view-calculadora", label: "🧮 Calculadora", roles: ["admin", "assessor"] },
    { id: "view-equipe", label: "👨‍💼 Equipe", roles: ["admin"] },
    { id: "view-regras", label: "📋 Regras de Comissionamento", roles: ["admin", "assessor", "sdr"] },
    { id: "view-importar-exportar", label: "📥 Importar e Exportar", roles: ["admin"] }
  ];

  for (const item of menuItems) {
    if (item.roles.includes(usuarioLogado.tipo)) {
      const button = document.createElement("button");
      button.className = "menu-btn";
      button.textContent = item.label;
      button.dataset.view = item.id;
      button.onclick = () => mudarAba(item.id);
      menuLateral.appendChild(button);
    }
  }
}

async function mudarAba(idAba) {
  document.querySelectorAll(".view").forEach(view => view.classList.remove("ativo"));
  const abaAtiva = document.getElementById(idAba);
  if (abaAtiva) {
    abaAtiva.classList.add("ativo");
  } else {
    console.error("Aba não encontrada:", idAba);
    return;
  }

  document.querySelectorAll(".menu-btn").forEach(btn => btn.classList.remove("ativo"));
  const btnAtivo = document.querySelector(`.menu-btn[data-view="${idAba}"]`);
  if (btnAtivo) {
    btnAtivo.classList.add("ativo");
  } else {
    console.error("Botão de menu não encontrado para aba:", idAba);
  }

  // Funções de renderização específicas para cada aba
  if (idAba === "view-painel") await renderizarPainel();
  else if (idAba === "view-lancar") await renderizarLancarTab();
  else if (idAba === "view-calculadora") await renderizarCalculadoraTab();
  else if (idAba === "view-equipe") await renderizarAssessoresTab();
  else if (idAba === "view-regras") { /* Não precisa de renderização específica */ }
  else if (idAba === "view-importar-exportar") await renderizarImportarExportarTab();
}

// ===================== CÁLCULOS DE REMUNERAÇÃO =====================

async function calcularRemuneracaoVenda(venda, todasVendasDoMes = []) {
  let valorPrincipal = 0; // Valor sobre o qual o percentual é aplicado (investido ou prêmio)
  let percentualAssessor = 0;
  let detalheProduto = "";
  let valorEscritorio = 0;
  let valorLiquido = 0;

  if (venda.produto === "Seguro") {
    valorPrincipal = venda.premio;
    detalheProduto = `Seguradora: ${venda.seguradora}`;

    if (venda.seguradora === "Azos") {
      detalheProduto += `, PJ2: ${venda.pj2Participou === "sim" ? "Sim" : "Não"}`;
      // Para Azos, o cálculo do agenciamento é feito no nível do escritório e rateado.
      // Aqui, calculamos apenas a recorrência individual. O agenciamento será adicionado depois.
      percentualAssessor = venda.pj2Participou === "sim" ? 3 : 4; // Recorrência para o assessor
      valorLiquido = valorPrincipal * (percentualAssessor / 100);
      valorEscritorio = valorPrincipal * (venda.pj2Participou === "sim" ? 22 : 21) / 100; // Recorrência para o escritório
    } else { // Outras seguradoras
      // 50% do prêmio vai para o escritório, 50% disso para o assessor (25% do prêmio total)
      percentualAssessor = 25;
      valorLiquido = valorPrincipal * (percentualAssessor / 100);
      valorEscritorio = valorPrincipal * (50 / 100) - valorLiquido; // 50% do prêmio total - parte do assessor
    }
  } else if (venda.produto === "Consórcio") {
    valorPrincipal = venda.valor;
    percentualAssessor = venda.percentualTitulo / 2; // 50% do percentual do título
    detalheProduto = `Administradora: ${venda.administradoraConsorcio}, %: ${venda.percentualTitulo}%`;
    valorLiquido = valorPrincipal * (percentualAssessor / 100);
    valorEscritorio = valorPrincipal * (venda.percentualTitulo / 100) - valorLiquido;
  } else if (venda.produto === "Renda Variável") {
    valorPrincipal = venda.valor;
    percentualAssessor = venda.percentualTitulo / 2; // 50% do percentual do título
    detalheProduto = `Tipo: ${venda.tipoRendaVariavel}, %: ${venda.percentualTitulo}%`;
    valorLiquido = valorPrincipal * (percentualAssessor / 100);
    valorEscritorio = valorPrincipal * (venda.percentualTitulo / 100) - valorLiquido;
  } else if (venda.produto === "Plano de Saúde") {
    valorPrincipal = venda.premio;
    percentualAssessor = venda.percentualTitulo / 2; // 50% do percentual do título
    detalheProduto = `Empresa: ${venda.empresaPlanoSaude}, %: ${venda.percentualTitulo}%`;
    valorLiquido = valorPrincipal * (percentualAssessor / 100);
    valorEscritorio = valorPrincipal * (venda.percentualTitulo / 100) - valorLiquido;
  } else if (PRODUTOS_GENIAL.includes(venda.produto) || venda.produto === PRODUTO_REPASSE_IMPORTADO) {
    // Comissão já vem pronta da Genial; não há cálculo de percentual aqui.
    valorPrincipal = venda.comissaoAssessor;
    detalheProduto = venda.origem === "genial-import" ? "Importado da planilha da Genial" : `Tipo: ${venda.produto}`;
    valorLiquido = venda.comissaoAssessor;
    valorEscritorio = 0;
  } else { // Renda Fixa, Fundos
    valorPrincipal = venda.valor;
    percentualAssessor = venda.percentualTitulo / 2; // 50% do percentual do título
    detalheProduto = `% do título: ${venda.percentualTitulo}%`;
    valorLiquido = valorPrincipal * (percentualAssessor / 100);
    valorEscritorio = valorPrincipal * (venda.percentualTitulo / 100) - valorLiquido;
  }

  return {
    valorPrincipal,
    detalheProduto,
    valorEscritorio,
    valorLiquido // Este é o valor que o assessor recebe por esta venda individual (sem agenciamento Azos ainda)
  };
}

async function calcularRemuneracaoMensal(funcionario, competencia, todasVendas, todasPassagens) {
  let totalVariavelBruto = 0; // Soma de todas as comissões variáveis antes do piso
  let totalPassagens = 0;
  let vendasCalculadas = [];
  let passagensCalculadas = [];

  // 1. Calcular passagens
  const passagensDoMes = todasPassagens.filter(p => p.funcionarioId === funcionario.id && p.competencia === competencia);
  for (const passagem of passagensDoMes) {
    const valorUnitario = configPassagem[passagem.tipo];
    const valorTotal = valorUnitario * passagem.quantidade;
    totalPassagens += valorTotal;
    passagensCalculadas.push({ ...passagem, valorUnitario, valorTotal });
  }

  // 2. Calcular vendas
  const vendasDoMes = todasVendas.filter(v => v.funcionarioId === funcionario.id && v.competencia === competencia);
  const vendasAzosDoEscritorioNoMes = todasVendas.filter(v => v.produto === "Seguro" && v.seguradora === "Azos" && v.competencia === competencia);
  const vendasAzosDoEscEscritorioMesAnterior = todasVendas.filter(v => v.produto === "Seguro" && v.seguradora === "Azos" && v.competencia === proximaCompetencia(competencia, -1));

  // Calcular total de prêmios Azos do escritório no mês
  const totalPremiosAzosEscritorio = vendasAzosDoEscritorioNoMes.reduce((sum, v) => sum + v.premio, 0);
  const totalPremiosAzosEscritorioMesAnterior = vendasAzosDoEscEscritorioMesAnterior.reduce((sum, v) => sum + v.premio, 0);

  // Determinar o percentual de agenciamento Azos para o escritório
  let percentualAgenciamentoAzosEscritorio = 0;
  if (totalPremiosAzosEscritorio >= 1500 && totalPremiosAzosEscritorioMesAnterior >= 1500) {
    percentualAgenciamentoAzosEscritorio = 275;
  } else if (totalPremiosAzosEscritorio >= 500) {
    percentualAgenciamentoAzosEscritorio = 175;
  } else {
    percentualAgenciamentoAzosEscritorio = 125;
  }

  const valorAgenciamentoAzosEscritorioTotal = totalPremiosAzosEscritorio * (percentualAgenciamentoAzosEscritorio / 100);
  const agenciamentoAzosParaAssessores = valorAgenciamentoAzosEscritorioTotal / 2; // 50% do agenciamento para assessores

  // Calcular o total de prêmios Azos do assessor no mês
  const totalPremiosAzosAssessor = vendasDoMes.filter(v => v.produto === "Seguro" && v.seguradora === "Azos").reduce((sum, v) => sum + v.premio, 0);

  for (const venda of vendasDoMes) {
    const { valorPrincipal, detalheProduto, valorEscritorio, valorLiquido } = await calcularRemuneracaoVenda(venda, todasVendas);

    let valorLiquidoFinalVenda = valorLiquido; // Começa com a recorrência para Azos ou 50% para outros

    if (venda.produto === "Seguro" && venda.seguradora === "Azos") {
      // Adicionar a parte proporcional do agenciamento Azos
      if (totalPremiosAzosEscritorio > 0) {
        const proporcaoAssessor = totalPremiosAzosAssessor > 0 ? (venda.premio / totalPremiosAzosAssessor) : 0;
        valorLiquidoFinalVenda += agenciamentoAzosParaAssessores * proporcaoAssessor;
      }
    }

    totalVariavelBruto += valorLiquidoFinalVenda;
    vendasCalculadas.push({ ...venda, valorPrincipal, detalheProduto, valorEscritorio, valorLiquido: valorLiquidoFinalVenda });
  }

  // Linha d'água: piso de R$2.000 só sobre a comissão variável; passagem sempre some por cima
  const isAssessorNoMes = funcionario.tipo === "assessor" && (!funcionario.mesConversaoAssessor || competencia >= funcionario.mesConversaoAssessor);
  const isSDRNoMes = funcionario.tipo === "sdr" && (!funcionario.mesConversaoAssessor || competencia < funcionario.mesConversaoAssessor);

  let baseRemuneracao = totalVariavelBruto;
  let aplicouPiso = false;
  if (isAssessorNoMes && totalVariavelBruto < PISO_MENSAL_ASSESSOR) {
    baseRemuneracao = PISO_MENSAL_ASSESSOR; // piso cobre só a parte variável
    aplicouPiso = true;
  } else if (isSDRNoMes) {
    baseRemuneracao = VALOR_FIXO_SDR; // R$ 2.000 fixo para SDR
    aplicouPiso = true;
  }
  const totalAssessorMes = baseRemuneracao + totalPassagens; // passagem SEMPRE some por cima

  return {
    totalAssessorMes,
    totalVariavelMes: totalVariavelBruto,
    aplicouPiso,
    vendasCalculadas,
    passagensCalculadas
  };
}

// ===================== RENDERIZAÇÃO DE ABAS =====================

async function renderizarPainel() {
  const filtroMes = document.getElementById("filtro-mes-painel").value;
  const listaFuncionariosPainel = document.getElementById("lista-funcionarios-painel");
  const totalGeralPainel = document.getElementById("total-geral-painel");

  const todosFuncionarios = await promisify(tx("funcionarios").getAll());
  const todosVendas = await promisify(tx("vendas").getAll());
  const todasPassagens = await promisify(tx("passagens").getAll());

  let totalGeral = 0;
  let htmlFuncionarios = "";

  const funcionariosAtivos = todosFuncionarios.filter(f => {
    // Se o usuário logado não é admin, só mostra a si mesmo
    if (usuarioLogado.tipo !== "admin" && f.id !== usuarioLogado.funcionarioId) return false;

    // Se o funcionário foi excluído, só mostra se o filtro de mês for anterior ou igual ao mês de exclusão
    if (f.mesExclusao && (!filtroMes || filtroMes > f.mesExclusao)) return false;

    return true;
  });

  for (const funcionario of funcionariosAtivos) {
    const { totalAssessorMes, totalVariavelMes, aplicouPiso, vendasCalculadas, passagensCalculadas } = await calcularRemuneracaoMensal(funcionario, filtroMes || competenciaAtualDoSistema(), todosVendas, todasPassagens);

    totalGeral += totalAssessorMes;

    const isAssessorNoMes = funcionario.tipo === "assessor" && (!funcionario.mesConversaoAssessor || (filtroMes || competenciaAtualDoSistema()) >= funcionario.mesConversaoAssessor);
    const isSDRNoMes = funcionario.tipo === "sdr" && (!funcionario.mesConversaoAssessor || (filtroMes || competenciaAtualDoSistema()) < funcionario.mesConversaoAssessor);

    let seloFuncao = "";
    if (isSDRNoMes) seloFuncao = `<span class="selo-sdr">SDR</span>`;
    else if (isAssessorNoMes) seloFuncao = `<span class="selo-assessor">Assessor</span>`;

    const seloPiso = aplicouPiso ? `<span class="selo-piso">Piso aplicado</span>` : "";
    const seloExcluido = funcionario.mesExclusao && (filtroMes && filtroMes <= funcionario.mesExclusao) ? `<span class="selo-inativo">Excluído em ${formatarCompetencia(funcionario.mesExclusao)}</span>` : "";

    // Buscar aprovação deste funcionário/mês
    const todasAprovacoes = await promisify(tx("aprovacoes").getAll());
    const competenciaExibida = filtroMes || competenciaAtualDoSistema();
    const aprovacao = todasAprovacoes.find(a => a.funcionarioId === funcionario.id && a.competencia === competenciaExibida);

    const isAdmin = usuarioLogado.tipo === "admin";
    const isMeuCard = usuarioLogado.funcionarioId === funcionario.id;

    const botaoLimparMes = (isAdmin && filtroMes && (vendasCalculadas.length > 0 || passagensCalculadas.length > 0))
      ? `<div class="acoes-mes"><button class="btn-remover" onclick="limparLancamentosDoMes('${funcionario.id}','${filtroMes}')">🗑️ Excluir todos os lançamentos de ${formatarCompetencia(filtroMes)}</button></div>`
      : '';

    const detalhesHtml = [...vendasCalculadas, ...passagensCalculadas].map(item => {
      const tipoItem = item.produto ? 'venda' : 'passagem';
      const botoesAdmin = isAdmin ? `
        <div class="grupo-btns-lancamento">
          <button class="btn-excluir-lancamento" onclick="event.stopPropagation();excluirLancamento('${tipoItem}','${item.id}')" title="Excluir">🗑</button>
          <button class="btn-editar-lancamento" onclick="event.stopPropagation();abrirModalEdicao('${tipoItem}','${item.id}')" title="Editar">✏️</button>
        </div>` : '';

      if (item.produto) { // É uma venda
        const titulo = construirTituloVenda(item);
        const linhas = construirLinhasVenda(item);
        return `
          <div class="item-lancamento" onclick="event.stopPropagation()">
            <div class="lancamento-titulo">
              <span>${titulo} — ${formatarCompetenciaExtenso(item.competencia)}</span>
              ${botoesAdmin}
            </div>
            ${linhas}
            <div class="lancamento-liquido">Valor líquido: ${formatarMoeda(item.valorLiquido)}</div>
          </div>
        `;
      } else { // É uma passagem
        const tipoLabel = item.tipo === 'metro' ? 'Metrô' : 'Ônibus';
        return `
          <div class="item-lancamento" onclick="event.stopPropagation()">
            <div class="lancamento-titulo">
              <span>🚌 Passagem ${tipoLabel} — ${formatarCompetenciaExtenso(item.competencia)}</span>
              ${botoesAdmin}
            </div>
            <div class="lancamento-linha">${item.quantidade}x ${formatarMoeda(item.valorUnitario)} cada</div>
            <div class="lancamento-liquido">Total: ${formatarMoeda(item.valorTotal)}</div>
          </div>
        `;
      }
    }).join("");

    // Bloco de aprovação
    let blocoAprovacao = '';
    if (filtroMes) {
      if (!aprovacao) {
        if (isAdmin) {
          blocoAprovacao = `
            <div class="bloco-aprovacao">
              <button onclick="enviarParaAprovacao('${funcionario.id}','${competenciaExibida}')" style="font-size:0.8rem;padding:7px 14px;">📤 Enviar para Aprovação</button>
            </div>`;
        }
      } else if (aprovacao.status === 'pendente') {
        if (isAdmin) {
          blocoAprovacao = `<div class="bloco-aprovacao"><span class="badge-aprovacao badge-pendente">⏳ Aguardando aprovação do funcionário</span></div>`;
        } else if (isMeuCard) {
          blocoAprovacao = `
            <div class="bloco-aprovacao">
              <span class="badge-aprovacao badge-pendente">⏳ Repasse enviado para sua aprovação</span>
              <div class="btns-resposta-aprovacao">
                <button class="btn-aprovar" onclick="responderAprovacao('${aprovacao.id}','aprovado')">✅ Aprovar</button>
                <button class="btn-contestar" onclick="abrirModalContestacao('${aprovacao.id}')">⚠️ Contestar</button>
              </div>
            </div>`;
        }
      } else if (aprovacao.status === 'aprovado') {
        blocoAprovacao = `<div class="bloco-aprovacao"><span class="badge-aprovacao badge-aprovado">✅ Repasse aprovado</span></div>`;
      } else if (aprovacao.status === 'contestado') {
        blocoAprovacao = `
          <div class="bloco-aprovacao">
            <span class="badge-aprovacao badge-contestado">⚠️ Repasse contestado</span>
            ${aprovacao.mensagemContestacao ? `<div class="msg-contestacao">💬 "${aprovacao.mensagemContestacao}"</div>` : ''}
            ${isAdmin ? `<button style="font-size:0.78rem;margin-top:8px;padding:5px 12px;" onclick="enviarParaAprovacao('${funcionario.id}','${competenciaExibida}')">↩️ Reenviar para Aprovação</button>` : ''}
          </div>`;
      }
    }

    const cargoLabel = isSDRNoMes ? 'SDR' : 'Assessor';

    htmlFuncionarios += `
      <div class="funcionario-wrapper">
        <div class="funcionario-card-painel" id="card-funcionario-${funcionario.id}" onclick="toggleDetalhesFuncionario('${funcionario.id}')">
          <h3>
            <span>
              ${funcionario.nome} ${seloPiso} ${seloExcluido}
              <div class="card-cargo">${cargoLabel}</div>
            </span>
            <span class="total-mes">${formatarMoeda(totalAssessorMes)}</span>
          </h3>
        </div>
        <div class="detalhes-funcionario-painel" id="detalhes-funcionario-${funcionario.id}" onclick="event.stopPropagation()">
          ${detalhesHtml || '<p class="status">Nenhum lançamento para este período.</p>'}
          ${botaoLimparMes}
          ${blocoAprovacao}
        </div>
      </div>
    `;
  }

  listaFuncionariosPainel.innerHTML = htmlFuncionarios;
  totalGeralPainel.innerHTML = `Total Geral (${filtroMes ? formatarCompetencia(filtroMes) : "Todos os períodos"}): ${formatarMoeda(totalGeral)}`;
}

// ---- Helpers de exibição de venda ----
function construirTituloVenda(item) {
  if (item.produto === 'Seguro') return `🛡 Seguro · ${item.seguradora}`;
  if (item.produto === 'Consórcio') return `🤝 Consórcio · ${item.administradoraConsorcio}`;
  if (item.produto === 'Renda Variável') return `📈 Renda Variável · ${item.tipoRendaVariavel}`;
  if (item.produto === 'Plano de Saúde') return `🏥 Plano de Saúde · ${item.empresaPlanoSaude}`;
  if (item.produto === 'Renda Fixa') return `💰 Renda Fixa`;
  if (item.produto === 'Fundos') return `📊 Fundos`;
  if (item.produto === PRODUTO_REPASSE_IMPORTADO) return `📥 Repasse Genial (Importado)`;
  if (PRODUTOS_GENIAL.includes(item.produto)) return `📈 ${item.produto} (Genial)`;
  return item.produto;
}

function construirLinhasVenda(item) {
  let linhas = [];
  if (item.produto === 'Seguro') {
    linhas.push(`<div class="lancamento-linha">Prêmio mensal: ${formatarMoeda(item.valorPrincipal)}</div>`);
    if (item.seguradora === 'Azos') {
      const recorr = item.pj2Participou === 'sim' ? 3 : 4;
      linhas.push(`<div class="lancamento-linha">Recorrência: ${recorr}%${item.pj2Participou === 'sim' ? ' · PJ2 participou' : ''}</div>`);
    } else {
      linhas.push(`<div class="lancamento-linha">Assessor: 25%</div>`);
    }
  } else if (item.produto === 'Consórcio' || item.produto === 'Renda Variável' || item.produto === 'Renda Fixa' || item.produto === 'Fundos') {
    linhas.push(`<div class="lancamento-linha">Valor: ${formatarMoeda(item.valorPrincipal)}</div>`);
    if (item.percentualTitulo) linhas.push(`<div class="lancamento-linha">${item.percentualTitulo}% do título (50% ao assessor)</div>`);
  } else if (item.produto === 'Plano de Saúde') {
    linhas.push(`<div class="lancamento-linha">Prêmio mensal: ${formatarMoeda(item.valorPrincipal)}</div>`);
    if (item.percentualTitulo) linhas.push(`<div class="lancamento-linha">${item.percentualTitulo}% (50% ao assessor)</div>`);
  } else if (PRODUTOS_GENIAL.includes(item.produto) || item.produto === PRODUTO_REPASSE_IMPORTADO) {
    linhas.push(`<div class="lancamento-linha">Comissão do Assessor: ${formatarMoeda(item.valorPrincipal)}</div>`);
  }
  return linhas.join('');
}

// ---- Excluir lançamento ----
async function excluirLancamento(tipo, id) {
  if (!confirm('Excluir este lançamento? Esta ação não pode ser desfeita.')) return;
  const store = tipo === 'venda' ? 'vendas' : 'passagens';
  await promisify(tx(store, 'readwrite').delete(id));
  await renderizarPainel();
}

async function limparLancamentosDoMes(funcionarioId, competencia) {
  if (!confirm(`Excluir TODOS os lançamentos de ${formatarCompetencia(competencia)} deste colaborador? Esta ação não pode ser desfeita.`)) return;

  const todasVendas = await promisify(tx('vendas').getAll());
  const todasPassagens = await promisify(tx('passagens').getAll());
  const vendasDoMes = todasVendas.filter(v => v.funcionarioId === funcionarioId && v.competencia === competencia);
  const passagensDoMes = todasPassagens.filter(p => p.funcionarioId === funcionarioId && p.competencia === competencia);

  for (const v of vendasDoMes) await promisify(tx('vendas', 'readwrite').delete(v.id));
  for (const p of passagensDoMes) await promisify(tx('passagens', 'readwrite').delete(p.id));

  alert('Lançamentos do mês excluídos.');
  await renderizarPainel();
}

// ---- Modal de Edição de Lançamento ----
let _edicaoTipo = null;
let _edicaoId = null;

async function abrirModalEdicao(tipo, id) {
  _edicaoTipo = tipo;
  _edicaoId = id;
  const corpo = document.getElementById('modal-edicao-corpo');

  if (tipo === 'venda') {
    const venda = await promisify(tx('vendas').get(id));
    document.getElementById('modal-edicao-titulo').textContent = '✏️ Editar Venda';

    const seguradoras = ['Azos','Bradesco','Genial','Icatu','MAG','MetLife','Porto'];
    const administradoras = ['HS','Ademicon','Embracon'];
    const tiposRV = ['Ações','Opções'];
    const empresasPS = ['Sul América','Porto','Bradesco','HapVida'];

    const optsSeguradora = seguradoras.map(s => `<option value="${s}" ${venda.seguradora===s?'selected':''}>${s}</option>`).join('');
    const optsAdm = administradoras.map(a => `<option value="${a}" ${venda.administradoraConsorcio===a?'selected':''}>${a}</option>`).join('');
    const optsRV = tiposRV.map(t => `<option value="${t}" ${venda.tipoRendaVariavel===t?'selected':''}>${t}</option>`).join('');
    const optsPS = empresasPS.map(e => `<option value="${e}" ${venda.empresaPlanoSaude===e?'selected':''}>${e}</option>`).join('');
    const optsPJ2 = `<option value="nao" ${venda.pj2Participou!=='sim'?'selected':''}>Não</option><option value="sim" ${venda.pj2Participou==='sim'?'selected':''}>Sim</option>`;

    let camposEspecificos = '';
    if (venda.produto === 'Seguro') {
      camposEspecificos = `
        <div class="form-row">
          <div><label>Prêmio mensal (R$)</label><input type="text" class="input-moeda" id="ed-premio" value="${formatarBR(venda.premio)}"></div>
          <div><label>Seguradora</label><select id="ed-seguradora" onchange="atualizarCampoPJ2Edicao()">${optsSeguradora}</select></div>
        </div>
        <div class="form-row" id="ed-campo-pj2" style="${venda.seguradora==='Azos'?'':'display:none'}">
          <div><label>Mesa PJ2 participou?</label><select id="ed-pj2">${optsPJ2}</select></div>
        </div>`;
    } else if (venda.produto === 'Consórcio') {
      camposEspecificos = `
        <div class="form-row">
          <div><label>Valor do Consórcio (R$)</label><input type="text" class="input-moeda" id="ed-valor" value="${formatarBR(venda.valor)}"></div>
          <div><label>Administradora</label><select id="ed-adm">${optsAdm}</select></div>
          <div><label>Percentual (%)</label><input type="text" class="input-pct" id="ed-percentual" value="${formatarBR(venda.percentualTitulo)}"></div>
        </div>`;
    } else if (venda.produto === 'Renda Variável') {
      camposEspecificos = `
        <div class="form-row">
          <div><label>Valor investido (R$)</label><input type="text" class="input-moeda" id="ed-valor" value="${formatarBR(venda.valor)}"></div>
          <div><label>Tipo</label><select id="ed-tipo-rv">${optsRV}</select></div>
          <div><label>Percentual (%)</label><input type="text" class="input-pct" id="ed-percentual" value="${formatarBR(venda.percentualTitulo)}"></div>
        </div>`;
    } else if (venda.produto === 'Plano de Saúde') {
      camposEspecificos = `
        <div class="form-row">
          <div><label>Prêmio mensal (R$)</label><input type="text" class="input-moeda" id="ed-premio" value="${formatarBR(venda.premio)}"></div>
          <div><label>Empresa</label><select id="ed-empresa-ps">${optsPS}</select></div>
          <div><label>Percentual (%)</label><input type="text" class="input-pct" id="ed-percentual" value="${formatarBR(venda.percentualTitulo)}"></div>
        </div>`;
    } else if (PRODUTOS_GENIAL.includes(venda.produto) || venda.produto === PRODUTO_REPASSE_IMPORTADO) {
      camposEspecificos = `
        <div class="form-row">
          <div><label>Comissão do Assessor (R$)</label><input type="text" class="input-moeda" id="ed-comissao-genial" value="${formatarBR(venda.comissaoAssessor)}"></div>
        </div>`;
    } else { // Renda Fixa, Fundos
      camposEspecificos = `
        <div class="form-row">
          <div><label>Valor investido (R$)</label><input type="text" class="input-moeda" id="ed-valor" value="${formatarBR(venda.valor)}"></div>
          <div><label>Percentual (%)</label><input type="text" class="input-pct" id="ed-percentual" value="${formatarBR(venda.percentualTitulo)}"></div>
        </div>`;
    }

    corpo.innerHTML = `
      <div class="form-row">
        <div><label>Produto</label><input type="text" value="${venda.produto}" disabled style="background:#f3effc;color:var(--primary-dark);font-weight:600"></div>
        <div><label>Mês de referência</label><input type="month" id="ed-competencia" value="${venda.competencia}"></div>
      </div>
      ${camposEspecificos}`;

  } else { // passagem
    const passagem = await promisify(tx('passagens').get(id));
    document.getElementById('modal-edicao-titulo').textContent = '✏️ Editar Passagem';
    corpo.innerHTML = `
      <div class="form-row">
        <div><label>Mês de referência</label><input type="month" id="ed-competencia" value="${passagem.competencia}"></div>
        <div><label>Tipo</label>
          <select id="ed-tipo-passagem">
            <option value="metro" ${passagem.tipo==='metro'?'selected':''}>Metrô</option>
            <option value="onibus" ${passagem.tipo==='onibus'?'selected':''}>Ônibus</option>
          </select>
        </div>
        <div><label>Quantidade</label><input type="number" id="ed-qtd-passagem" value="${passagem.quantidade}" min="1" step="1"></div>
      </div>`;
  }

  // Ativa máscaras nos novos inputs
  document.querySelectorAll('#modal-edicao-corpo .input-moeda').forEach(aplicarMascaraMoeda);
  document.querySelectorAll('#modal-edicao-corpo .input-pct').forEach(aplicarMascaraPercentual);

  document.getElementById('modal-edicao-overlay').classList.add('ativo');
}

function atualizarCampoPJ2Edicao() {
  const seg = document.getElementById('ed-seguradora')?.value;
  const campo = document.getElementById('ed-campo-pj2');
  if (campo) campo.style.display = seg === 'Azos' ? '' : 'none';
}

function fecharModalEdicao() {
  _edicaoTipo = null;
  _edicaoId = null;
  document.getElementById('modal-edicao-overlay').classList.remove('ativo');
}

async function salvarEdicaoLancamento() {
  if (_edicaoTipo === 'venda') {
    const venda = await promisify(tx('vendas').get(_edicaoId));
    venda.competencia = document.getElementById('ed-competencia').value;

    if (venda.produto === 'Seguro') {
      venda.premio = parseBR(document.getElementById('ed-premio').value);
      venda.seguradora = document.getElementById('ed-seguradora').value;
      if (venda.seguradora === 'Azos') venda.pj2Participou = document.getElementById('ed-pj2').value;
      if (!venda.premio || venda.premio <= 0) { alert('Prêmio inválido.'); return; }
    } else if (venda.produto === 'Consórcio') {
      venda.valor = parseBR(document.getElementById('ed-valor').value);
      venda.percentualTitulo = parseBR(document.getElementById('ed-percentual').value);
      venda.administradoraConsorcio = document.getElementById('ed-adm').value;
    } else if (venda.produto === 'Renda Variável') {
      venda.valor = parseBR(document.getElementById('ed-valor').value);
      venda.percentualTitulo = parseBR(document.getElementById('ed-percentual').value);
      venda.tipoRendaVariavel = document.getElementById('ed-tipo-rv').value;
    } else if (venda.produto === 'Plano de Saúde') {
      venda.premio = parseBR(document.getElementById('ed-premio').value);
      venda.percentualTitulo = parseBR(document.getElementById('ed-percentual').value);
      venda.empresaPlanoSaude = document.getElementById('ed-empresa-ps').value;
    } else if (PRODUTOS_GENIAL.includes(venda.produto) || venda.produto === PRODUTO_REPASSE_IMPORTADO) {
      venda.comissaoAssessor = parseBR(document.getElementById('ed-comissao-genial').value);
      if (!venda.comissaoAssessor || venda.comissaoAssessor <= 0) { alert('Comissão inválida.'); return; }
    } else {
      venda.valor = parseBR(document.getElementById('ed-valor').value);
      venda.percentualTitulo = parseBR(document.getElementById('ed-percentual').value);
    }
    if (!venda.competencia) { alert('Mês de referência inválido.'); return; }
    await promisify(tx('vendas', 'readwrite').put(venda));

  } else { // passagem
    const passagem = await promisify(tx('passagens').get(_edicaoId));
    passagem.competencia = document.getElementById('ed-competencia').value;
    passagem.tipo = document.getElementById('ed-tipo-passagem').value;
    passagem.quantidade = parseInt(document.getElementById('ed-qtd-passagem').value) || 1;
    const valorUnitario = configPassagem[passagem.tipo];
    passagem.valorTotal = valorUnitario * passagem.quantidade;
    await promisify(tx('passagens', 'readwrite').put(passagem));
  }

  fecharModalEdicao();
  await renderizarPainel();
}

// ---- Sistema de aprovação ----
async function enviarParaAprovacao(funcionarioId, competencia) {
  // Remove aprovação anterior se existir (para reenvio)
  const todas = await promisify(tx('aprovacoes').getAll());
  const anterior = todas.find(a => a.funcionarioId === funcionarioId && a.competencia === competencia);
  if (anterior) await promisify(tx('aprovacoes', 'readwrite').delete(anterior.id));

  await promisify(tx('aprovacoes', 'readwrite').add({
    funcionarioId,
    competencia,
    status: 'pendente',
    mensagemContestacao: null,
    dataEnvio: new Date().toISOString(),
    dataResposta: null
  }));
  alert('Repasse enviado para aprovação do funcionário!');
  await renderizarPainel();
}

async function responderAprovacao(aprovacaoId, novoStatus) {
  const aprovacao = await promisify(tx('aprovacoes').get(aprovacaoId));
  aprovacao.status = novoStatus;
  aprovacao.dataResposta = new Date().toISOString();
  await promisify(tx('aprovacoes', 'readwrite').put(aprovacao));
  await renderizarPainel();
}

let _aprovacaoIdPendente = null;
function abrirModalContestacao(aprovacaoId) {
  _aprovacaoIdPendente = aprovacaoId;
  document.getElementById('input-msg-contestacao').value = '';
  document.getElementById('modal-contestacao-overlay').classList.add('ativo');
}
function fecharModalContestacao() {
  _aprovacaoIdPendente = null;
  document.getElementById('modal-contestacao-overlay').classList.remove('ativo');
}
async function confirmarContestacao() {
  const msg = document.getElementById('input-msg-contestacao').value.trim();
  if (!msg) { alert('Por favor, explique o motivo da contestação.'); return; }
  const aprovacao = await promisify(tx('aprovacoes').get(_aprovacaoIdPendente));
  aprovacao.status = 'contestado';
  aprovacao.mensagemContestacao = msg;
  aprovacao.dataResposta = new Date().toISOString();
  await promisify(tx('aprovacoes', 'readwrite').put(aprovacao));
  fecharModalContestacao();
  await renderizarPainel();
}

function toggleDetalhesFuncionario(id) {
  const card = document.getElementById(`card-funcionario-${id}`);
  const detalhes = document.getElementById(`detalhes-funcionario-${id}`);
  if (card) card.classList.toggle("expandido");
  if (detalhes) detalhes.classList.toggle("ativo");
}

function limparFiltroMesPainel() {
  document.getElementById("filtro-mes-painel").value = "";
  renderizarPainel();
}

async function renderizarLancarTab() {
  const funcionarios = await promisify(tx("funcionarios").getAll());
  const selectFuncionario = document.getElementById("select-funcionario");
  const selectColaboradorPassagem = document.getElementById("select-colaborador-passagem");

  selectFuncionario.innerHTML = funcionarios
    .filter(f => !f.mesExclusao) // Remove imediatamente funcionários excluídos
    .map(f => `<option value="${f.id}">${f.nome} (${f.tipo === 'sdr' ? 'SDR' : 'Assessor'})</option>`)
    .join("");

  selectColaboradorPassagem.innerHTML = funcionarios
    .filter(f => !f.mesExclusao) // Remove imediatamente funcionários excluídos
    .map(f => `<option value="${f.id}">${f.nome} (${f.tipo === 'sdr' ? 'SDR' : 'Assessor'})</option>`)
    .join("");

  popularSelectProdutos("select-produto");
  document.getElementById("input-competencia").value = competenciaAtualDoSistema();
  document.getElementById("input-competencia-passagem").value = competenciaAtualDoSistema();

  alterarProdutoSelecionado('lancar'); // Renderiza os campos para o produto inicial

  // Mostra/esconde a área de configuração de passagem para admin
  document.getElementById("area-config-passagem-admin").style.display = usuarioLogado.tipo === "admin" ? "block" : "none";
  atualizarValorPassagemLabel();
}

function popularSelectProdutos(selectId) {
  const select = document.getElementById(selectId);
  select.innerHTML = PRODUTOS.map(p => `<option value="${p}">${p}</option>`).join("");
}

function alterarProdutoSelecionado(prefixo) {
  const produto = document.getElementById(`select-produto${prefixo === 'calc' ? '-calc' : ''}`).value;

  // Esconde todos os campos específicos
  document.getElementById(`campos-padrao${prefixo === 'calc' ? '-calc' : ''}`).style.display = 'none';
  document.getElementById(`campos-seguro${prefixo === 'calc' ? '-calc' : ''}`).style.display = 'none';
  document.getElementById(`campos-consorcio${prefixo === 'calc' ? '-calc' : ''}`).style.display = 'none';
  document.getElementById(`campos-renda-variavel${prefixo === 'calc' ? '-calc' : ''}`).style.display = 'none';
  document.getElementById(`campos-plano-saude${prefixo === 'calc' ? '-calc' : ''}`).style.display = 'none';
  document.getElementById(`campos-genial${prefixo === 'calc' ? '-calc' : ''}`).style.display = 'none';

  // Mostra os campos relevantes
  if (produto === "Seguro") {
    document.getElementById(`campos-seguro${prefixo === 'calc' ? '-calc' : ''}`).style.display = 'flex';
    alterarSeguradoraSelecionada(prefixo); // Garante que o campo PJ2 seja atualizado
  } else if (produto === "Consórcio") {
    document.getElementById(`campos-consorcio${prefixo === 'calc' ? '-calc' : ''}`).style.display = 'flex';
    popularSelect(document.getElementById(`select-administradora-consorcio${prefixo === 'calc' ? '-calc' : ''}`), ADMINISTRADORAS_CONSORCIO);
  } else if (produto === "Renda Variável") {
    document.getElementById(`campos-renda-variavel${prefixo === 'calc' ? '-calc' : ''}`).style.display = 'flex';
    popularSelect(document.getElementById(`select-tipo-rv${prefixo === 'calc' ? '-calc' : ''}`), TIPOS_RENDA_VARIAVEL);
  } else if (produto === "Plano de Saúde") {
    document.getElementById(`campos-plano-saude${prefixo === 'calc' ? '-calc' : ''}`).style.display = 'flex';
    popularSelect(document.getElementById(`select-empresa-ps${prefixo === 'calc' ? '-calc' : ''}`), EMPRESAS_PLANO_SAUDE);
  } else if (PRODUTOS_GENIAL.includes(produto)) {
    document.getElementById(`campos-genial${prefixo === 'calc' ? '-calc' : ''}`).style.display = 'flex';
  } else { // Renda Fixa, Fundos
    document.getElementById(`campos-padrao${prefixo === 'calc' ? '-calc' : ''}`).style.display = 'flex';
  }
}

function alterarSeguradoraSelecionada(prefixo) {
  const seguradora = document.getElementById(`select-seguradora${prefixo === 'calc' ? '-calc' : ''}`).value;
  document.getElementById(`campo-pj2${prefixo === 'calc' ? '-calc' : ''}`).style.display = (seguradora === "Azos") ? 'flex' : 'none';
}

function popularSelect(selectElement, optionsArray) {
  selectElement.innerHTML = optionsArray.map(opt => `<option value="${opt}">${opt}</option>`).join("");
}

async function lancarVenda() {
  const funcionarioId = document.getElementById("select-funcionario").value; // string ID
  const produto = document.getElementById("select-produto").value;
  const competencia = document.getElementById("input-competencia").value;

  if (!funcionarioId || !produto || !competencia) { alert("Preencha todos os campos obrigatórios."); return; }

  const funcionario = await promisify(tx("funcionarios").get(funcionarioId));
  if (funcionario.tipo === "sdr" && (!funcionario.mesConversaoAssessor || competencia < funcionario.mesConversaoAssessor)) {
    alert("SDRs não podem ter vendas lançadas. Apenas Assessores.");
    return;
  }

  let venda = { funcionarioId, produto, competencia };

  if (produto === "Seguro") {
    venda.premio = parseBR(document.getElementById("input-premio").value);
    venda.seguradora = document.getElementById("select-seguradora").value;
    if (venda.seguradora === "Azos") {
      venda.pj2Participou = document.getElementById("select-pj2-participou").value;
    }
    if (isNaN(venda.premio) || venda.premio <= 0) { alert("Prêmio mensal inválido."); return; }
  } else if (produto === "Consórcio") {
    venda.valor = parseBR(document.getElementById("input-valor-consorcio").value);
    venda.percentualTitulo = parseBR(document.getElementById("input-percentual-consorcio").value);
    venda.administradoraConsorcio = document.getElementById("select-administradora-consorcio").value;
    if (isNaN(venda.valor) || venda.valor <= 0 || isNaN(venda.percentualTitulo) || venda.percentualTitulo <= 0) { alert("Valor ou percentual inválidos."); return; }
  } else if (produto === "Renda Variável") {
    venda.valor = parseBR(document.getElementById("input-valor-rv").value);
    venda.percentualTitulo = parseBR(document.getElementById("input-percentual-rv").value);
    venda.tipoRendaVariavel = document.getElementById("select-tipo-rv").value;
    if (isNaN(venda.valor) || venda.valor <= 0 || isNaN(venda.percentualTitulo) || venda.percentualTitulo <= 0) { alert("Valor ou percentual inválidos."); return; }
  } else if (produto === "Plano de Saúde") {
    venda.premio = parseBR(document.getElementById("input-premio-ps").value);
    venda.percentualTitulo = parseBR(document.getElementById("input-percentual-ps").value);
    venda.empresaPlanoSaude = document.getElementById("select-empresa-ps").value;
    if (isNaN(venda.premio) || venda.premio <= 0 || isNaN(venda.percentualTitulo) || venda.percentualTitulo <= 0) { alert("Prêmio ou percentual inválidos."); return; }
  } else if (PRODUTOS_GENIAL.includes(produto)) {
    venda.comissaoAssessor = parseBR(document.getElementById("input-comissao-genial").value);
    if (isNaN(venda.comissaoAssessor) || venda.comissaoAssessor <= 0) { alert("Comissão do assessor inválida."); return; }
  } else { // Renda Fixa, Fundos
    venda.valor = parseBR(document.getElementById("input-valor").value);
    venda.percentualTitulo = parseBR(document.getElementById("input-percentual-variavel").value);
    if (isNaN(venda.valor) || venda.valor <= 0 || isNaN(venda.percentualTitulo) || venda.percentualTitulo <= 0) { alert("Valor ou percentual inválidos."); return; }
  }

  await promisify(tx("vendas", "readwrite").add(venda));
  alert("Venda lançada com sucesso!");
  renderizarPainel(); // Atualiza o painel de remuneração
}

async function lancarPassagem() {
  const funcionarioId = document.getElementById("select-colaborador-passagem").value; // string ID
  const competencia = document.getElementById("input-competencia-passagem").value;
  const tipo = document.getElementById("select-tipo-passagem").value;
  const quantidade = parseInt(document.getElementById("input-qtd-passagem").value);

  if (!funcionarioId || !competencia || !tipo || isNaN(quantidade) || quantidade <= 0) { alert("Preencha todos os campos corretamente."); return; }

  const valorUnitario = configPassagem[tipo];
  const valorTotal = valorUnitario * quantidade;

  await promisify(tx("passagens", "readwrite").add({ funcionarioId, competencia, tipo, quantidade, valorTotal }));
  alert("Passagem lançada com sucesso!");
  renderizarPainel(); // Atualiza o painel de remuneração
}

// ---- Importação automática do repasse da Genial ----
async function importarRepasseGenial(event) {
  const arquivo = event.target.files[0];
  if (!arquivo) return;

  const leitor = new FileReader();
  leitor.onload = async function (e) {
    try {
      const dados = new Uint8Array(e.target.result);
      const workbook = XLSX.read(dados, { type: "array", cellDates: true });
      const nomeAba = workbook.SheetNames.includes("Data") ? "Data" : workbook.SheetNames[0];
      const planilha = workbook.Sheets[nomeAba];
      // A planilha da Genial tem uma linha de aviso antes do cabeçalho real; pula a primeira linha.
      const linhas = XLSX.utils.sheet_to_json(planilha, { range: 1, defval: "" });

      const chavesMapeadasNormalizadas = Object.keys(MAPEAMENTO_REPASSE_GENIAL).map(k => ({ chave: k, norm: normalizarNome(k) }));
      const totaisPorFuncionario = {}; // { NOME_NORMALIZADO: { nome, produtos: { "competencia|produto": soma } } }

      for (const linha of linhas) {
        const assessorPlanilha = String(linha["ASSESSOR"] || "").trim();
        if (!assessorPlanilha) continue;

        const normAssessor = normalizarNome(assessorPlanilha);
        const encontrado = chavesMapeadasNormalizadas.find(c => c.norm === normAssessor);
        if (!encontrado) continue; // fora do mapeamento por enquanto — ignora

        const dataReceita = linha["DATA DE RECEITA"];
        if (!(dataReceita instanceof Date) || isNaN(dataReceita.getTime())) continue;
        const competencia = `${dataReceita.getFullYear()}-${String(dataReceita.getMonth() + 1).padStart(2, "0")}`;

        // Usa o valor líquido (já com imposto descontado), não o valor bruto.
        const comissaoLiquida = Number(linha["VALOR LIQUIDO AAI"]) || 0;
        const tipoProdutoPlanilha = String(linha["TIPO PRODUTO"] || "").trim();
        const produto = PRODUTOS_GENIAL.includes(tipoProdutoPlanilha) ? tipoProdutoPlanilha : PRODUTO_REPASSE_IMPORTADO;

        const nomeFuncionario = MAPEAMENTO_REPASSE_GENIAL[encontrado.chave];
        const chaveFuncionario = normalizarNome(nomeFuncionario);
        const chaveProduto = `${competencia}|${produto}`;

        if (!totaisPorFuncionario[chaveFuncionario]) totaisPorFuncionario[chaveFuncionario] = { nome: nomeFuncionario, produtos: {} };
        totaisPorFuncionario[chaveFuncionario].produtos[chaveProduto] = (totaisPorFuncionario[chaveFuncionario].produtos[chaveProduto] || 0) + comissaoLiquida;
      }

      const todosFuncionarios = await promisify(tx("funcionarios").getAll());
      const todasVendas = await promisify(tx("vendas").getAll());
      const resumo = [];
      const naoEncontrados = new Set();

      for (const chave in totaisPorFuncionario) {
        const { nome, produtos } = totaisPorFuncionario[chave];
        const funcionario = todosFuncionarios.find(f => normalizarNome(f.nome) === chave);
        if (!funcionario) { naoEncontrados.add(nome); continue; }

        for (const chaveProduto in produtos) {
          const [competencia, produto] = chaveProduto.split("|");
          const total = produtos[chaveProduto];
          const existente = todasVendas.find(v => v.funcionarioId === funcionario.id && v.competencia === competencia && v.produto === produto && v.origem === "genial-import");
          if (existente) {
            existente.comissaoAssessor = total;
            await promisify(tx("vendas", "readwrite").put(existente));
          } else {
            await promisify(tx("vendas", "readwrite").add({
              funcionarioId: funcionario.id,
              produto,
              competencia,
              comissaoAssessor: total,
              origem: "genial-import"
            }));
          }
          resumo.push(`${funcionario.nome} — ${formatarCompetencia(competencia)} — ${produto}: ${formatarMoeda(total)}`);
        }
      }

      let mensagem = resumo.length
        ? `Importação concluída:\n\n${resumo.join("\n")}`
        : "Nenhum lançamento correspondente ao mapeamento atual foi encontrado nesta planilha.";
      if (naoEncontrados.size > 0) {
        mensagem += `\n\n⚠️ Não encontrei cadastro na aba Equipe para: ${[...naoEncontrados].join(", ")}. Verifique se o nome está exatamente igual.`;
      }
      alert(mensagem);
      event.target.value = "";
      await renderizarPainel();
    } catch (err) {
      console.error("Erro ao importar repasse Genial:", err);
      alert("Erro ao processar o arquivo. Confira se é o modelo correto da Genial (aba 'Data' com as colunas ASSESSOR, TIPO PRODUTO, DATA DE RECEITA, COMISSÃO ASSESSOR).");
    }
  };
  leitor.readAsArrayBuffer(arquivo);
}

function atualizarValorPassagemLabel() {
  document.getElementById("valor-unit-metro-label").textContent = formatarMoeda(configPassagem.metro).replace("R$", "");
  document.getElementById("valor-unit-onibus-label").textContent = formatarMoeda(configPassagem.onibus).replace("R$", "");
}

function alternarConfigPassagem() {
  const cardConfig = document.getElementById("card-config-passagem");
  const btn = document.getElementById("botao-alternar-config-passagem");
  if (cardConfig.style.display === 'none') {
    cardConfig.style.display = 'flex';
    document.getElementById("input-valor-metro").value = formatarBR(configPassagem.metro);
    document.getElementById("input-valor-onibus").value = formatarBR(configPassagem.onibus);
    btn.textContent = "Esconder ajustes";
  } else {
    cardConfig.style.display = 'none';
    btn.textContent = "Ajustar valores da passagem";
  }
}

async function salvarConfigPassagem() {
  const metro = parseBR(document.getElementById("input-valor-metro").value);
  const onibus = parseBR(document.getElementById("input-valor-onibus").value);

  if (isNaN(metro) || metro <= 0 || isNaN(onibus) || onibus <= 0) { alert("Valores de passagem inválidos."); return; }

  configPassagem = { metro, onibus };
  await promisify(tx("configuracoes", "readwrite").put({ chave: "passagem", metro, onibus }));
  atualizarValorPassagemLabel();
  alert("Valores de passagem salvos!");
  alternarConfigPassagem(); // Esconde o card após salvar
}

// ===================== CALCULADORA =====================

async function renderizarCalculadoraTab() {
  popularSelectProdutos("select-produto-calc");
  alterarProdutoSelecionado('calc'); // Renderiza os campos para o produto inicial
  document.getElementById("resultado-simulacao").innerHTML = "<p class='status'>Nenhum item na simulação.</p>";
  simulacaoAtual = []; // Limpa a simulação ao entrar na aba
}

async function adicionarSimulacao() {
  const produto = document.getElementById("select-produto-calc").value;
  let simulacaoItem = { produto: produto, funcionarioId: 0, competencia: competenciaAtualDoSistema() }; // Dummy funcionarioId e competencia

  if (produto === "Seguro") {
    simulacaoItem.premio = parseBR(document.getElementById("input-premio-calc").value);
    simulacaoItem.seguradora = document.getElementById("select-seguradora-calc").value;
    if (simulacaoItem.seguradora === "Azos") {
      simulacaoItem.pj2Participou = document.getElementById("select-pj2-calc").value;
    }
    if (isNaN(simulacaoItem.premio) || simulacaoItem.premio <= 0) { alert("Prêmio mensal inválido."); return; }
  } else if (produto === "Consórcio") {
    simulacaoItem.valor = parseBR(document.getElementById("input-valor-consorcio-calc").value);
    simulacaoItem.percentualTitulo = parseBR(document.getElementById("input-percentual-consorcio-calc").value);
    simulacaoItem.administradoraConsorcio = document.getElementById("select-administradora-consorcio-calc").value;
    if (isNaN(simulacaoItem.valor) || simulacaoItem.valor <= 0 || isNaN(simulacaoItem.percentualTitulo) || simulacaoItem.percentualTitulo <= 0) { alert("Valor ou percentual inválidos."); return; }
  } else if (produto === "Renda Variável") {
    simulacaoItem.valor = parseBR(document.getElementById("input-valor-rv-calc").value);
    simulacaoItem.percentualTitulo = parseBR(document.getElementById("input-percentual-rv-calc").value);
    simulacaoItem.tipoRendaVariavel = document.getElementById("select-tipo-rv-calc").value;
    if (isNaN(simulacaoItem.valor) || simulacaoItem.valor <= 0 || isNaN(simulacaoItem.percentualTitulo) || simulacaoItem.percentualTitulo <= 0) { alert("Valor ou percentual inválidos."); return; }
  } else if (produto === "Plano de Saúde") {
    simulacaoItem.premio = parseBR(document.getElementById("input-premio-ps-calc").value);
    simulacaoItem.percentualTitulo = parseBR(document.getElementById("input-percentual-ps-calc").value);
    simulacaoItem.empresaPlanoSaude = document.getElementById("select-empresa-ps-calc").value;
    if (isNaN(simulacaoItem.premio) || simulacaoItem.premio <= 0 || isNaN(simulacaoItem.percentualTitulo) || simulacaoItem.percentualTitulo <= 0) { alert("Prêmio ou percentual inválidos."); return; }
  } else if (PRODUTOS_GENIAL.includes(produto)) {
    simulacaoItem.comissaoAssessor = parseBR(document.getElementById("input-comissao-genial-calc").value);
    if (isNaN(simulacaoItem.comissaoAssessor) || simulacaoItem.comissaoAssessor <= 0) { alert("Comissão do assessor inválida."); return; }
  } else { // Renda Fixa, Fundos
    simulacaoItem.valor = parseBR(document.getElementById("input-valor-calc").value);
    simulacaoItem.percentualTitulo = parseBR(document.getElementById("input-percentual-variavel-calc").value);
    if (isNaN(simulacaoItem.valor) || simulacaoItem.valor <= 0 || isNaN(simulacaoItem.percentualTitulo) || simulacaoItem.percentualTitulo <= 0) { alert("Valor ou percentual inválidos."); return; }
  }

  simulacaoAtual.push(simulacaoItem);
  renderizarSimulacao();
}

async function renderizarSimulacao() {
  const resultadoEl = document.getElementById("resultado-simulacao");
  if (simulacaoAtual.length === 0) {
    resultadoEl.innerHTML = "<p class='status'>Nenhum item na simulação.</p>";
    return;
  }

  let html = "<h4>Itens simulados:</h4>";

  // Para a simulação, precisamos de um funcionário dummy para o cálculo de Azos
  const dummyFuncionario = { id: 0, nome: "Simulação", tipo: "assessor", mesExclusao: null, mesConversaoAssessor: null };
  const { totalAssessorMes, vendasCalculadas } = await calcularRemuneracaoMensal(dummyFuncionario, competenciaAtualDoSistema(), simulacaoAtual, []);

  for (const venda of vendasCalculadas) {
    html += `
      <div class="item-remuneracao">
        <h4>${venda.produto} - ${formatarMoeda(venda.valorLiquido)}</h4>
        <div class="detalhe-expandido ativo">
          Valor/Prêmio: ${formatarMoeda(venda.valorPrincipal)}<br>
          Detalhe: ${venda.detalheProduto}<br>
          Repasse Escritório: ${formatarMoeda(venda.valorEscritorio)}
        </div>
      </div>
    `;
  }
  html += `<div class="total-geral">Total Simulado: ${formatarMoeda(totalAssessorMes)}</div>`;
  resultadoEl.innerHTML = html;
}

function limparSimulacao() {
  simulacaoAtual = [];
  renderizarSimulacao();
}

// ===================== EQUIPE =====================

async function adicionarAssessor() {
  const nome = document.getElementById("input-novo-assessor-nome").value.trim();
  const login = document.getElementById("input-novo-assessor-login").value.trim();
  const senha = document.getElementById("input-novo-assessor-senha").value.trim();
  const tipo = document.getElementById("select-novo-tipo-funcionario").value;

  if (!nome || !login || !senha) { alert("Preencha nome, login e senha."); return; }

  const usuarios = await promisify(tx("usuarios").getAll());
  if (usuarios.some(u => u.login.toLowerCase() === login.toLowerCase())) { alert("Este login já está em uso."); return; }

  const funcionarioId = await promisify(tx("funcionarios", "readwrite").add({ nome, tipo, mesExclusao: null, mesConversaoAssessor: null }));
  await promisify(tx("usuarios", "readwrite").add({ nome, login, senha, tipo: "assessor", funcionarioId, ativo: true }));

  alert("Colaborador adicionado!");
  document.getElementById("input-novo-assessor-nome").value = "";
  document.getElementById("input-novo-assessor-login").value = "";
  document.getElementById("input-novo-assessor-senha").value = "";

  await renderizarAssessoresTab();
}

async function adicionarAdmin() {
  const nome = document.getElementById("input-novo-admin-nome").value.trim();
  const login = document.getElementById("input-novo-admin-login").value.trim();
  const senha = document.getElementById("input-novo-admin-senha").value.trim();

  if (!nome || !login || !senha) { alert("Preencha nome, login e senha."); return; }

  const usuarios = await promisify(tx("usuarios").getAll());
  if (usuarios.some(u => u.login.toLowerCase() === login.toLowerCase())) { alert("Este login já está em uso."); return; }

  await promisify(tx("usuarios", "readwrite").add({ nome, login, senha, tipo: "admin", funcionarioId: null, ativo: true }));

  alert("Administrador adicionado!");
  document.getElementById("input-novo-admin-nome").value = "";
  document.getElementById("input-novo-admin-login").value = "";
  document.getElementById("input-novo-admin-senha").value = "";

  await renderizarAssessoresTab();
}

async function alterarSenhaUsuario(usuarioId) {
  const novaSenha = prompt("Digite a nova senha:");
  if (!novaSenha) return;
  const usuario = await promisify(tx("usuarios").get(usuarioId));
  usuario.senha = novaSenha;
  await promisify(tx("usuarios", "readwrite").put(usuario));
  alert("Senha atualizada.");
}

async function excluirColaborador(usuarioId, funcionarioId) {
  if (!confirm("Excluir este colaborador? O login será bloqueado imediatamente. Ele deixará de aparecer na Remuneração a partir do mês seguinte, mas o histórico de meses anteriores será mantido para consulta.")) return;

  const usuario = await promisify(tx("usuarios").get(usuarioId));
  usuario.ativo = false;
  await promisify(tx("usuarios", "readwrite").put(usuario));

  if (funcionarioId) {
    const funcionario = await promisify(tx("funcionarios").get(funcionarioId));
    funcionario.mesExclusao = competenciaAtualDoSistema(); // Marca o mês atual como mês de exclusão
    await promisify(tx("funcionarios", "readwrite").put(funcionario));
  }

  alert("Colaborador excluído.");
  await renderizarAssessoresTab();
  await renderizarPainel(); // Atualiza o painel de remuneração
}

async function converterSdrParaAssessor(funcionarioId, usuarioId) {
  if (!confirm("Converter este SDR para Assessor? Ele passará a ser remunerado como assessor a partir do próximo mês. O histórico como SDR será preservado.")) return;

  const funcionario = await promisify(tx("funcionarios").get(funcionarioId));
  funcionario.tipo = "assessor";
  funcionario.mesConversaoAssessor = proximaCompetencia(competenciaAtualDoSistema()); // Marca o próximo mês como início da vigência de assessor
  await promisify(tx("funcionarios", "readwrite").put(funcionario));

  const usuario = await promisify(tx("usuarios").get(usuarioId));
  usuario.ativo = true; // Garante que o usuário esteja ativo
  await promisify(tx("usuarios", "readwrite").put(usuario));

  alert(`SDR ${funcionario.nome} convertido para Assessor. A nova regra de remuneração valerá a partir de ${formatarCompetencia(funcionario.mesConversaoAssessor)}.`);
  await renderizarAssessoresTab();
  await renderizarPainel(); // Atualiza o painel de remuneração
}

async function removerAdmin(usuarioId) {
  const usuario = await promisify(tx("usuarios").get(usuarioId));
  if (usuario.id === usuarioLogado.id) { alert("Você não pode remover seu próprio usuário."); return; }
  const todos = await promisify(tx("usuarios").getAll());
  if (todos.filter(u => u.tipo === "admin").length <= 1) { alert("Não é possível remover o último administrador."); return; }
  if (!confirm(`Remover o administrador "${usuario.nome}"?`)) return;
  await promisify(tx("usuarios", "readwrite").delete(usuarioId));
  await renderizarAssessoresTab();
}

async function renderizarAssessoresTab() {
  const usuarios = await promisify(tx("usuarios").getAll());
  const funcionarios = await promisify(tx("funcionarios").getAll());
  const tbody = document.getElementById("tabela-assessores");

  const usuariosVisiveis = usuarios.filter(u => {
    if (u.tipo === "admin") return true;
    const funcionario = funcionarios.find(f => f.id === u.funcionarioId);
    return funcionario && !funcionario.mesExclusao; // Só mostra se o funcionário não foi excluído
  });

  tbody.innerHTML = usuariosVisiveis.map(u => {
    const isAdmin = u.tipo === "admin";
    const funcionario = funcionarios.find(f => f.id === u.funcionarioId);
    const rotuloFuncao = isAdmin ? "Administrador" : (funcionario?.tipo === "sdr" ? "SDR" : "Assessor");
    let acoesHtml = "";

    if (isAdmin) {
      acoesHtml = `<button class="btn-remover" onclick="removerAdmin('${u.id}')">Remover</button>`;
    } else {
      acoesHtml = `<button class="btn-remover" onclick="excluirColaborador('${u.id}', '${u.funcionarioId || ''}')">Excluir</button>`;
      if (funcionario && funcionario.tipo === "sdr") {
        acoesHtml += ` <button class="btn-converter" onclick="converterSdrParaAssessor('${u.funcionarioId}', '${u.id}')">Converter para Assessor</button>`;
      }
    }

    return `
      <tr>
        <td>${u.nome}</td><td>${u.login}</td><td>${rotuloFuncao}</td>
        <td><button class="btn-editar" onclick="alterarSenhaUsuario('${u.id}')">Alterar senha</button> ${acoesHtml}</td>
      </tr>`;
  }).join("");
}

// ===================== IMPORTAR E EXPORTAR =====================

async function renderizarImportarExportarTab() {
  const funcionarios = await promisify(tx("funcionarios").getAll());
  const selectExportarFuncionario = document.getElementById("select-exportar-funcionario");
  selectExportarFuncionario.innerHTML = funcionarios.map(f => `<option value="${f.id}">${f.nome}${f.tipo === "sdr" ? " (SDR)" : ""}${f.mesExclusao ? ` (Excluído em ${formatarCompetencia(f.mesExclusao)})` : ""}</option>`).join("");

  document.getElementById("linha-selecionar-funcionario-pdf").style.display = usuarioLogado.tipo === "admin" ? "flex" : "none";
}

function baixarModeloPlanilha() {
  const dadosModelo = [
    ["Login do Assessor","Produto","Mês de Referência","Valor Investido","Percentual (%)","Prêmio Mensal","Seguradora","PJ2 Participou (sim/nao)", "Administradora Consórcio", "Tipo Renda Variável", "Empresa Plano Saúde"],
    ["ana.souza","Renda Fixa","2026-08",20000,1.5,"","","","","",""],
    ["ana.souza","Seguro","2026-08","","",300,"Genial","","","",""],
    ["diego.alves","Seguro","2026-08","","",250,"Azos","sim","","",""],
    ["bruno.lima","Consórcio","2026-08",10000,"",10,"","","HS","",""],
    ["carla.mendes","Renda Variável","2026-08",5000,"",2,"","","","Ações",""],
    ["elaine.costa","Plano de Saúde","2026-08","","",1500,"","","","","Sul América"]
  ];
  const ws = XLSX.utils.aoa_to_sheet(dadosModelo);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Vendas");
  XLSX.writeFile(wb, "modelo-importacao-remuneracao.xlsx");
}

async function validarLinhaImportacao(linha, usuariosPorLogin, todosFuncionarios) {
  const erros = [];
  const login = String(linha["Login do Assessor"] || "").trim();
  const produto = String(linha["Produto"] || "").trim();
  const competencia = String(linha["Mês de Referência"] || "").trim();

  if (!login) erros.push("login não informado");
  if (!PRODUTOS.includes(produto)) erros.push("produto inválido");
  if (!/^\d{4}-\d{2}$/.test(competencia)) erros.push("competência inválida (use AAAA-MM)");

  const usuario = login ? usuariosPorLogin[login.toLowerCase()] : null;
  if (login && !usuario) erros.push("login não encontrado ou colaborador excluído/inativo");

  let venda = null;
  if (erros.length === 0) {
    venda = { funcionarioId: usuario.funcionarioId, produto, competencia };
    if (produto === "Seguro") {
      const premio = parseFloat(linha["Prêmio Mensal"]);
      const seguradora = String(linha["Seguradora"] || "").trim();
      if (!premio || premio <= 0) erros.push("prêmio inválido");
      if (!SEGURADORAS.includes(seguradora)) erros.push("seguradora inválida");
      if (erros.length === 0) {
        venda.premio = premio; venda.seguradora = seguradora;
        if (seguradora === "Azos") {
          const pj2 = String(linha["PJ2 Participou (sim/nao)"] || "nao").trim().toLowerCase();
          venda.pj2Participou = pj2 === "sim" ? "sim" : "nao";
        }
      }
    } else if (produto === "Consórcio") {
      const valor = parseFloat(linha["Valor Investido"]);
      const percentual = parseFloat(linha["Percentual (%)"]);
      const administradoraConsorcio = String(linha["Administradora Consórcio"] || "").trim();
      if (!valor || valor <= 0) erros.push("valor investido inválido");
      if (isNaN(percentual) || percentual < 0 || percentual > 100) erros.push("percentual inválido");
      if (!ADMINISTRADORAS_CONSORCIO.includes(administradoraConsorcio)) erros.push("administradora de consórcio inválida");
      if (erros.length === 0) { venda.valor = valor; venda.percentualTitulo = percentual; venda.administradoraConsorcio = administradoraConsorcio; }
    } else if (produto === "Renda Variável") {
      const valor = parseFloat(linha["Valor Investido"]);
      const percentual = parseFloat(linha["Percentual (%)"]);
      const tipoRendaVariavel = String(linha["Tipo Renda Variável"] || "").trim();
      if (!valor || valor <= 0) erros.push("valor investido inválido");
      if (isNaN(percentual) || percentual < 0 || percentual > 100) erros.push("percentual inválido");
      if (!TIPOS_RENDA_VARIAVEL.includes(tipoRendaVariavel)) erros.push("tipo de renda variável inválido");
      if (erros.length === 0) { venda.valor = valor; venda.percentualTitulo = percentual; venda.tipoRendaVariavel = tipoRendaVariavel; }
    } else if (produto === "Plano de Saúde") {
      const premio = parseFloat(linha["Prêmio Mensal"]);
      const percentual = parseFloat(linha["Percentual (%)"]);
      const empresaPlanoSaude = String(linha["Empresa Plano Saúde"] || "").trim();
      if (!premio || premio <= 0) erros.push("prêmio mensal inválido");
      if (isNaN(percentual) || percentual < 0 || percentual > 100) erros.push("percentual inválido");
      if (!EMPRESAS_PLANO_SAUDE.includes(empresaPlanoSaude)) erros.push("empresa de plano de saúde inválida");
      if (erros.length === 0) { venda.premio = premio; venda.percentualTitulo = percentual; venda.empresaPlanoSaude = empresaPlanoSaude; }
    }
    else { // Renda Fixa, Fundos
      const valor = parseFloat(linha["Valor Investido"]);
      const percentual = parseFloat(linha["Percentual (%)"]);
      if (!valor || valor <= 0) erros.push("valor investido inválido");
      if (isNaN(percentual) || percentual < 0 || percentual > 100) erros.push("percentual inválido");
      if (erros.length === 0) { venda.valor = valor; venda.percentualTitulo = percentual; }
    }
  }
  return { venda, erros };
}

async function processarArquivoExcel(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: "array" });
      const planilha = workbook.Sheets[workbook.SheetNames[0]];
      const linhas = XLSX.utils.sheet_to_json(planilha, { defval: "" });

      const usuarios = await promisify(tx("usuarios").getAll());
      const funcionarios = await promisify(tx("funcionarios").getAll());
      const usuariosPorLogin = {};
      for (const u of usuarios) {
        if (u.tipo === "assessor" && u.ativo !== false) {
          const funcionario = funcionarios.find(f => f.id === u.funcionarioId);
          if (funcionario && !funcionario.mesExclusao) {
            usuariosPorLogin[u.login.toLowerCase()] = u;
          }
        }
      }

      let sucesso = 0;
      const erros = [];

      for (const [index, linha] of linhas.entries()) {
        const { venda, erros: errosLinha } = await validarLinhaImportacao(linha, usuariosPorLogin, funcionarios);
        if (errosLinha.length > 0) {
          erros.push(`Linha ${index + 2}: ${errosLinha.join(", ")}`);
        } else {
          const funcionario = funcionarios.find(f => f.id === venda.funcionarioId);
          if (funcionario && funcionario.tipo === "sdr" && (!funcionario.mesConversaoAssessor || venda.competencia < funcionario.mesConversaoAssessor)) {
            erros.push(`Linha ${index + 2}: SDR não pode ter vendas lançadas para este mês (${venda.competencia})`);
          } else {
            await promisify(tx("vendas", "readwrite").add(venda));
            sucesso++;
          }
        }
      }

      let mensagem = `${sucesso} venda(s) importada(s) com sucesso.`;
      if (erros.length > 0) mensagem += `\n\n${erros.length} linha(s) com erro:\n` + erros.join("\n");
      document.getElementById("resultado-importacao").innerText = mensagem;
    } catch (err) {
      document.getElementById("resultado-importacao").innerText = "Erro ao processar o arquivo.";
      console.error(err);
    }
    event.target.value = "";
  };
  reader.readAsArrayBuffer(file);
}

async function exportarFuncionarioPDF() {
  const funcionarioId = usuarioLogado.tipo === "admin" ? document.getElementById("select-exportar-funcionario").value : usuarioLogado.funcionarioId;
  const competenciaFiltro = document.getElementById("input-mes-exportar").value;
  if (!funcionarioId) { alert("Selecione um colaborador."); return; }

  const funcionario = await promisify(tx("funcionarios").get(funcionarioId));
  if (!funcionario) { alert("Colaborador não encontrado."); return; }

  let vendas = await promisify(tx("vendas").index("funcionarioId").getAll(funcionarioId));
  let passagens = await promisify(tx("passagens").index("funcionarioId").getAll(funcionarioId));

  if (competenciaFiltro) {
    vendas = vendas.filter(v => v.competencia === competenciaFiltro);
    passagens = passagens.filter(p => p.competencia === competenciaFiltro);
  }
  if (funcionario.mesExclusao) {
    vendas = vendas.filter(v => v.competencia <= funcionario.mesExclusao);
    passagens = passagens.filter(p => p.competencia <= funcionario.mesExclusao);
  }

  vendas.sort((a, b) => (a.competencia || "").localeCompare(b.competencia || ""));
  passagens.sort((a, b) => (a.competencia || "").localeCompare(b.competencia || ""));

  const todosVendas = await promisify(tx("vendas").getAll()); // Para o cálculo Azos
  const { totalAssessorMes, totalVariavelMes, aplicouPiso, vendasCalculadas, passagensCalculadas } = await calcularRemuneracaoMensal(funcionario, competenciaFiltro || competenciaAtualDoSistema(), todosVendas, passagens);

  const linhasVendasArr = vendasCalculadas.map(v => `<tr><td>${formatarCompetencia(v.competencia)}</td><td>${v.produto}</td><td>${formatarMoeda(v.valorPrincipal)}</td><td>${v.detalheProduto}</td><td>${formatarMoeda(v.valorEscritorio)}</td><td>${formatarMoeda(v.valorLiquido)}</td></tr>`);
  const linhasPassagensArr = passagensCalculadas.map(p => `<tr><td>${formatarCompetencia(p.competencia)}</td><td>Passagem ${p.tipo}</td><td>${p.quantidade}x ${formatarMoeda(p.valorUnitario)}</td><td></td><td></td><td>${formatarMoeda(p.valorTotal)}</td></tr>`);

  const linhas = [...linhasVendasArr, ...linhasPassagensArr].join("");

  const dataAtual = new Date().toLocaleDateString("pt-BR");
  const periodoTexto = competenciaFiltro ? formatarCompetencia(competenciaFiltro) : "Todos os períodos";
  const notaPiso = funcionario.tipo !== "sdr" ? `<p class="status">Observação: o total pago pode ser maior que a soma variável acima, pois o assessor tem piso mensal garantido de R$ ${formatarMoeda(PISO_MENSAL_ASSESSOR).replace("R$", "")} quando o variável do mês não atinge esse valor.</p>` : "";

  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Relatório - ${funcionario.nome}</title>
    <style>* { box-sizing:border-box; } body { margin:0; font-family:Arial, sans-serif; color:#111827; } .relatorio-pdf { padding:30px; } h1 { text-align:center; color:#5b21b6; } h2 { color:#5b21b6; border-bottom:2px solid #7c3aed; padding-bottom:8px; } table { width:100%; border-collapse:collapse; } th, td { border:1px solid #ddd; padding:6px; font-size:10px; } th { background:#f3effc; } .totais { margin-top:20px; padding:14px; background:#f0fdf4; border:1px solid #86efac; border-radius:8px; } .botao-imprimir { text-align:center; margin:20px 0; } @media print { .botao-imprimir { display:none; } }</style>
    </head><body>
    <div class="botao-imprimir"><button onclick="window.print()">Imprimir / Salvar PDF</button></div>
    <main class="relatorio-pdf">
      <h1>Relatório de Remuneração — Ritmo Investimentos</h1>
      <p><strong>Colaborador:</strong> ${funcionario.nome}${funcionario.tipo === "sdr" ? " (SDR)" : ""}${funcionario.mesExclusao ? ` (Excluído em ${formatarCompetencia(funcionario.mesExclusao)})` : ""}<br><strong>Período:</strong> ${periodoTexto}<br><strong>Emitido em:</strong> ${dataAtual}</p>
      <h2>Detalhes</h2>
      ${(vendas.length || passagens.length) ? `<table><thead><tr><th>Mês</th><th>Item</th><th>Valor/Prêmio</th><th>Detalhe</th><th>Escritório</th><th>Líquido</th></tr></thead><tbody>${linhas}</tbody></table>` : "<p>Nenhum item no período.</p>"}
      <div class="totais"><strong>Total líquido: ${formatarMoeda(totalAssessorMes)}</strong><br>Total variável bruto: ${formatarMoeda(totalVariavelMes)}</div>
      ${notaPiso}
    </main></body></html>`;

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `relatorio-${funcionario.nome.replace(/\s+/g, "-").toLowerCase()}-${competenciaFiltro || "todos"}.html`;
  a.click();
  URL.revokeObjectURL(url);
  alert("Relatório baixado. Abra o arquivo .html e use Ctrl+P para salvar como PDF.");
}

async function exportarBackup() {
  const backup = {
    funcionarios: await promisify(tx("funcionarios").getAll()),
    vendas: await promisify(tx("vendas").getAll()),
    usuarios: await promisify(tx("usuarios").getAll()),
    passagens: await promisify(tx("passagens").getAll()),
    configuracoes: await promisify(tx("configuracoes").getAll())
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `backup-ritmo-${new Date().toISOString().slice(0,10)}.json`;
  a.click(); URL.revokeObjectURL(url);
}

function importarBackup(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const backup = JSON.parse(e.target.result);
      if (!confirm("Isso substitui todos os dados atuais. Continuar?")) return;

      for (const nome of ["funcionarios","vendas","usuarios","passagens","configuracoes"]) {
        await promisify(tx(nome, "readwrite").clear());
      }
      for (const f of backup.funcionarios || []) { const { id, ...rest } = f; await promisify(tx("funcionarios","readwrite").add(rest)); }
      for (const v of backup.vendas || []) { const { id, ...rest } = v; await promisify(tx("vendas","readwrite").add(rest)); }
      for (const u of backup.usuarios || []) { const { id, ...rest } = u; await promisify(tx("usuarios","readwrite").add(rest)); }
      for (const p of backup.passagens || []) { const { id, ...rest } = p; await promisify(tx("passagens","readwrite").add(rest)); }
      for (const c of backup.configuracoes || []) { await promisify(tx("configuracoes","readwrite").add(c)); }

      alert("Backup importado! Recarregando...");
      sessionStorage.removeItem("usuarioLogadoId");
      location.reload();
    } catch (err) { alert("Arquivo inválido."); console.error(err); }
  };
  reader.readAsText(file);
  event.target.value = "";
}

// ===================== INICIALIZAÇÃO =====================

(async () => {
  await abrirBanco();
  await limparDadosExemplo();
  await garantirAdminsPadrao();
  await carregarConfigPassagem();
  await verificarSessao();
})();
