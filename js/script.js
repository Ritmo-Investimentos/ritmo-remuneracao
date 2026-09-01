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
const IMPOSTO_REPASSE_GENIAL = 0.1903; // 19,03% sobre a parte do escritório no repasse da Genial
const IRFF_GENIAL_NORMAL = 0.015; // 1,5% de IRFF retido pela Genial (fase 1), igual para todos os produtos

let configPassagem = {
  metro: 7.90,
  onibus: 5.00,
  vlt: 5.00,
  barca: 5.00,
  trem: 7.60
};

const ROTULOS_TIPO_PASSAGEM = { metro: 'Metrô', onibus: 'Ônibus', vlt: 'VLT', barca: 'Barca', trem: 'Trem' };
function rotuloTipoPassagem(tipo) {
  return ROTULOS_TIPO_PASSAGEM[tipo] || tipo;
}

const PRODUTOS_GENIAL = ["BTC", "Bmf", "Bovespa", "CRI/CRA", "Clubes", "Debênture", "Fundos C.O", "Mercado Secundário", "IPO Bovespa", "Outros", "Previdência"];
const PRODUTOS_GENIAL_DEDUCAO = ["Taxa de Performance", "Custo de Plataforma"]; // descontam do assessor, não somam
const PRODUTOS_GENIAL_TODOS = [...PRODUTOS_GENIAL, ...PRODUTOS_GENIAL_DEDUCAO];
const PRODUTO_REPASSE_IMPORTADO = "Repasse Genial (Importado)";
const PRODUTOS = ["Renda Fixa", "Fundos", "Seguro", "Consórcio", "Renda Variável", "Plano de Saúde", ...PRODUTOS_GENIAL_TODOS];
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

function distanciaEdicao(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// Algumas planilhas da Genial chegam com um caractere corrompido no lugar de uma
// letra acentuada (ex.: "Mercado Secund¿rio" em vez de "Mercado Secundário").
// Tolera até 1 caractere de diferença para não jogar esses casos no "Repasse
// Genial (Importado)" só por causa de um erro de codificação da própria planilha.
function identificarProdutoGenial(tipoProdutoPlanilha) {
  const alvo = normalizarNome(tipoProdutoPlanilha);
  if (!alvo) return null;
  let melhor = null, menorDistancia = Infinity;
  for (const produto of PRODUTOS_GENIAL_TODOS) {
    const d = distanciaEdicao(alvo, normalizarNome(produto));
    if (d < menorDistancia) { menorDistancia = d; melhor = produto; }
  }
  return menorDistancia <= 1 ? melhor : null;
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
  if (configSalva) {
    configPassagem = {
      metro: configSalva.metro ?? configPassagem.metro,
      onibus: configSalva.onibus ?? configPassagem.onibus,
      vlt: configSalva.vlt ?? configPassagem.vlt,
      barca: configSalva.barca ?? configPassagem.barca,
      trem: configSalva.trem ?? configPassagem.trem
    };
  }
  atualizarValorPassagemLabel(); // Garante que os labels sejam atualizados na carga
}

// ===================== UTILS =====================

function formatarMoeda(valor) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(valor);
}

function formatarMoedaColorida(valor) {
  const texto = formatarMoeda(valor);
  return valor < 0 ? `<span class="valor-negativo">${texto}</span>` : texto;
}

function formatarMoedaSinalizada(valor) {
  const texto = formatarMoeda(valor);
  if (valor > 0) return `<span class="valor-positivo">${texto}</span>`;
  if (valor < 0) return `<span class="valor-negativo">${texto}</span>`;
  return texto;
}

function formatarPercentual(valor) {
  return `${(valor * 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function toggleSidebar() {
  const fechada = document.getElementById("app-shell").classList.toggle("sidebar-fechada");
  localStorage.setItem("sidebarFechada", fechada);
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
    document.getElementById("app-shell").classList.toggle("sidebar-fechada", localStorage.getItem("sidebarFechada") === "true");
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
  } else if (venda.valorLiquidoPlanilhaFinal !== undefined) {
    // Extrato novo da Genial: Valor Bruto e Valor Líquido já vêm calculados linha a
    // linha pela própria planilha (bruto = repasse÷2, líquido = bruto − imposto da
    // linha). Usamos direto, sem reaplicar ÷2/19,03% por cima.
    valorPrincipal = venda.valorBrutoPlanilha;
    detalheProduto = `Tipo: ${venda.produto}`;
    valorEscritorio = venda.valorBrutoPlanilha;
    valorLiquido = venda.valorLiquidoPlanilhaFinal;
  } else if (PRODUTOS_GENIAL_TODOS.includes(venda.produto) || venda.produto === PRODUTO_REPASSE_IMPORTADO) {
    // Repasse da Genial em 2 fases:
    // Fase 1 (Genial -> Ritmo): a Genial retém 1,5% de IRFF sobre a comissão líquida
    // de cada produto (mesma alíquota para todos) e repassa o líquido à Ritmo. Só se
    // aplica a lançamentos importados da planilha — o valor lá é a "Comissão Líquida"
    // de Genial, antes desse IRFF. No lançamento manual, o admin já digita a comissão
    // líquida pronta (depois desse IRFF), então essa fase é pulada.
    // Fase 2 (Ritmo -> assessor): a Ritmo fica com 50% dessa comissão líquida,
    // desconta 19,03% de imposto sobre a sua parte e paga o assessor — sempre,
    // independente do sinal (produtos negativos reduzem o total normalmente).
    const comissaoLiquidaRitmo = venda.origem === "genial-import"
      ? venda.comissaoAssessor * (1 - IRFF_GENIAL_NORMAL)
      : venda.comissaoAssessor;
    valorPrincipal = venda.comissaoAssessor;
    detalheProduto = venda.origem === "genial-import" ? "Importado da planilha da Genial" : `Tipo: ${venda.produto}`;
    valorEscritorio = comissaoLiquidaRitmo / 2;
    valorLiquido = valorEscritorio * (1 - IMPOSTO_REPASSE_GENIAL);
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

  // Repasse da Genial: cada lançamento (por produto/mês) já calcula seu próprio líquido
  // final em calcularRemuneracaoVenda (fase 1: IRFF da Genial; fase 2: ÷2 e 19,03% da
  // Ritmo), então soma direto, sem rateio agregado.
  for (const venda of vendasDoMes) {
    const { valorPrincipal, detalheProduto, valorEscritorio, valorLiquido } = await calcularRemuneracaoVenda(venda, todasVendas);

    let valorLiquidoFinalVenda = valorLiquido; // Começa com a recorrência para Azos ou o líquido já calculado para os demais

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

  const botaoLimparMesTodos = document.getElementById("botao-limpar-mes-todos");
  if (botaoLimparMesTodos) {
    botaoLimparMesTodos.style.display = (usuarioLogado.tipo === "admin" && filtroMes) ? "inline-block" : "none";
  }

  const todosFuncionarios = await promisify(tx("funcionarios").getAll());
  const todosVendas = await promisify(tx("vendas").getAll());
  const todasPassagens = await promisify(tx("passagens").getAll());
  await garantirPassagensRecorrentes(filtroMes || competenciaAtualDoSistema(), todosFuncionarios, todasPassagens);

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
            ${(item.valorLiquidoPlanilhaFinal === undefined && !PRODUTOS_GENIAL_TODOS.includes(item.produto) && item.produto !== PRODUTO_REPASSE_IMPORTADO) ? `<div class="lancamento-liquido">Valor líquido: ${formatarMoedaColorida(item.valorLiquido)}</div>` : ''}
          </div>
        `;
      } else { // É uma passagem
        const tipoLabel = rotuloTipoPassagem(item.tipo);
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

    // Bloco de aprovação: o selo de status e o botão de Enviar/Reenviar já aparecem
    // no cabeçalho do card (sem precisar expandir) — aqui, ao expandir, mostra só o
    // histórico salvo da conversa (chat) e as ações que só cabem aqui (Aprovar/Contestar
    // do funcionário), sem repetir a mesma informação de status.
    let blocoAprovacao = '';
    if (filtroMes && aprovacao) {
      const chatHtml = construirChatAprovacao(aprovacao.historico, funcionario, isAdmin);
      if (aprovacao.status === 'pendente' && isMeuCard) {
        blocoAprovacao = `
          <div class="bloco-aprovacao">
            ${chatHtml}
            <div class="btns-resposta-aprovacao">
              <button class="btn-aprovar" onclick="responderAprovacao('${aprovacao.id}','aprovado')">✅ Aprovar</button>
              <button class="btn-contestar" onclick="abrirModalContestacao('${aprovacao.id}')">⚠️ Contestar</button>
            </div>
          </div>`;
      } else if (chatHtml) {
        blocoAprovacao = `<div class="bloco-aprovacao">${chatHtml}</div>`;
      }
    }

    const cargoLabel = isSDRNoMes ? 'SDR' : 'Assessor';

    // Resumo do status de aprovação, visível direto na caixa do funcionário (sem
    // precisar expandir), para o admin acompanhar de forma rápida. As mensagens
    // (do admin ou do funcionário) continuam só dentro do card expandido.
    let resumoAprovacaoHeader = '';
    if (filtroMes) {
      if (!aprovacao) {
        if (isAdmin) {
          resumoAprovacaoHeader = `<button class="badge-aprovacao-btn" onclick="event.stopPropagation();abrirModalEnvioAprovacao('${funcionario.id}','${competenciaExibida}')">📤 Enviar p/ Aprovação</button>`;
        }
      } else if (aprovacao.status === 'pendente') {
        resumoAprovacaoHeader = `<span class="badge-aprovacao badge-pendente">⏳ Pendente</span>`;
      } else if (aprovacao.status === 'aprovado') {
        resumoAprovacaoHeader = `<span class="badge-aprovacao badge-aprovado">✅ Aprovado</span>`;
      } else if (aprovacao.status === 'contestado') {
        resumoAprovacaoHeader = `<span class="badge-aprovacao badge-contestado">⚠️ Contestado</span>${isAdmin ? `<button class="badge-aprovacao-btn" onclick="event.stopPropagation();abrirModalEnvioAprovacao('${funcionario.id}','${competenciaExibida}')">↩️ Reenviar</button>` : ''}`;
      }
    }

    htmlFuncionarios += `
      <div class="funcionario-wrapper">
        <div class="funcionario-card-painel" id="card-funcionario-${funcionario.id}" onclick="toggleDetalhesFuncionario('${funcionario.id}')">
          <h3>
            <span>
              ${funcionario.nome} ${seloExcluido} ${resumoAprovacaoHeader}
            </span>
            <span class="total-mes">${formatarMoedaColorida(totalAssessorMes)}</span>
          </h3>
        </div>
        <div class="detalhes-funcionario-painel" id="detalhes-funcionario-${funcionario.id}" onclick="event.stopPropagation()">
          <div class="card-info-expandida">${seloPiso} <span class="card-cargo">${cargoLabel}</span></div>
          ${detalhesHtml || '<p class="status">Nenhum lançamento para este período.</p>'}
          ${botaoLimparMes}
          ${blocoAprovacao}
        </div>
      </div>
    `;
  }

  listaFuncionariosPainel.innerHTML = htmlFuncionarios;
  totalGeralPainel.innerHTML = `Total Geral (${filtroMes ? formatarCompetencia(filtroMes) : "Todos os períodos"}): ${formatarMoedaColorida(totalGeral)}`;
}

// ---- Helpers de exibição de venda ----
// Monta o histórico salvo (chat) de envios/respostas de aprovação, rotulando cada
// mensagem como "Você" ou o nome de quem enviou, conforme quem está olhando.
function construirChatAprovacao(historico, funcionario, isAdmin) {
  if (!historico || historico.length === 0) return '';
  const linhas = historico.map(h => {
    const souEu = (h.autor === 'admin' && isAdmin) || (h.autor === 'funcionario' && !isAdmin);
    const quem = souEu ? 'Você' : (h.autor === 'admin' ? 'Administração' : funcionario.nome);
    const dataFormatada = new Date(h.data).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const acao = { envio: 'enviou para aprovação', aprovacao: 'aprovou o repasse', contestacao: 'contestou o repasse' }[h.tipo] || '';
    const textoMsg = h.mensagem ? `: "${h.mensagem}"` : '';
    return `<div class="chat-aprovacao-item"><strong>${quem}</strong> ${acao}${textoMsg}<span class="chat-aprovacao-data">${dataFormatada}</span></div>`;
  }).join('');
  return `<div class="chat-aprovacao">${linhas}</div>`;
}

function construirTituloVenda(item) {
  if (item.produto === 'Seguro') return `🛡 Seguro · ${item.seguradora}`;
  if (item.produto === 'Consórcio') return `🤝 Consórcio · ${item.administradoraConsorcio}`;
  if (item.produto === 'Renda Variável') return `📈 Renda Variável · ${item.tipoRendaVariavel}`;
  if (item.produto === 'Plano de Saúde') return `🏥 Plano de Saúde · ${item.empresaPlanoSaude}`;
  if (item.produto === 'Renda Fixa') return `💰 Renda Fixa`;
  if (item.produto === 'Fundos') return `📊 Fundos`;
  if (item.produto === PRODUTO_REPASSE_IMPORTADO) return `📥 Repasse Genial (Importado)`;
  if (PRODUTOS_GENIAL_DEDUCAO.includes(item.produto)) return `💸 ${item.produto} (Dedução)`;
  if (PRODUTOS_GENIAL.includes(item.produto)) return `📈 ${item.produto}`;
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
  } else if (item.valorLiquidoPlanilhaFinal !== undefined) {
    linhas.push(`<div class="lancamento-linha">Valor Bruto: ${formatarMoedaColorida(item.valorBrutoPlanilha)}</div>`);
    linhas.push(`<div class="lancamento-linha">Tipo Produto: ${item.produto}</div>`);
    linhas.push(`<div class="lancamento-linha">Imposto (da planilha, não é o imposto de 19,03% do escritório): ${formatarPercentual(item.impostoPercentualPlanilha)}</div>`);
    linhas.push(`<div class="lancamento-linha">Valor Líquido: ${formatarMoedaColorida(item.valorLiquidoPlanilhaFinal)}</div>`);
  } else if (PRODUTOS_GENIAL_TODOS.includes(item.produto) || item.produto === PRODUTO_REPASSE_IMPORTADO) {
    // Nomes propositalmente diferentes dos usados na planilha da Genial, para não
    // confundir: "Comissão bruta" aqui é o valor que a planilha chama de "Comissão
    // Assessor"; "Imposto 19,03%" é o valor em R$ que o escritório retira antes de
    // pagar o assessor; "Comissão líquida" é o valor final após ÷2 e -19,03% do
    // escritório — não tem relação com a "Comissão Líquida" que aparece na planilha.
    const impostoEscritorio = item.valorEscritorio - item.valorLiquido;
    linhas.push(`<div class="lancamento-linha">Comissão bruta: ${formatarMoedaColorida(item.valorPrincipal)}</div>`);
    linhas.push(`<div class="lancamento-linha">Imposto 19,03%: ${formatarMoedaColorida(impostoEscritorio)}</div>`);
    linhas.push(`<div class="lancamento-linha">Comissão líquida: ${formatarMoedaSinalizada(item.valorLiquido)}</div>`);
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

async function limparRemuneracoesDoMesTodos() {
  const competencia = document.getElementById("filtro-mes-painel").value;
  if (!competencia) { alert("Selecione um mês no filtro antes de usar essa opção."); return; }
  if (!confirm(`Excluir TODOS os lançamentos (vendas e passagens) de TODOS os colaboradores em ${formatarCompetencia(competencia)}? Esta ação não pode ser desfeita.`)) return;

  const todasVendas = await promisify(tx('vendas').getAll());
  const todasPassagens = await promisify(tx('passagens').getAll());
  const vendasDoMes = todasVendas.filter(v => v.competencia === competencia);
  const passagensDoMes = todasPassagens.filter(p => p.competencia === competencia);

  for (const v of vendasDoMes) await promisify(tx('vendas', 'readwrite').delete(v.id));
  for (const p of passagensDoMes) await promisify(tx('passagens', 'readwrite').delete(p.id));

  alert(`Lançamentos de ${formatarCompetencia(competencia)} excluídos para todos os colaboradores.`);
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
    } else if (PRODUTOS_GENIAL_TODOS.includes(venda.produto) || venda.produto === PRODUTO_REPASSE_IMPORTADO) {
      camposEspecificos = `
        <div class="form-row">
          <div><label>Comissão bruta (R$)</label><input type="text" class="input-moeda" id="ed-comissao-genial" value="${formatarBR(venda.comissaoAssessor)}"></div>
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
            <option value="vlt" ${passagem.tipo==='vlt'?'selected':''}>VLT</option>
            <option value="barca" ${passagem.tipo==='barca'?'selected':''}>Barca</option>
            <option value="trem" ${passagem.tipo==='trem'?'selected':''}>Trem</option>
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
    } else if (PRODUTOS_GENIAL_TODOS.includes(venda.produto) || venda.produto === PRODUTO_REPASSE_IMPORTADO) {
      const valorDigitado = parseBR(document.getElementById('ed-comissao-genial').value);
      if (!valorDigitado) { alert('Comissão inválida.'); return; }
      venda.comissaoAssessor = PRODUTOS_GENIAL_DEDUCAO.includes(venda.produto) ? -Math.abs(valorDigitado) : valorDigitado;
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
async function enviarParaAprovacao(funcionarioId, competencia, mensagemAdmin = null) {
  // Reaproveita a aprovação anterior (se existir) para manter o histórico de
  // mensagens salvo — reenviar não apaga a conversa, só reabre o status.
  const todas = await promisify(tx('aprovacoes').getAll());
  const anterior = todas.find(a => a.funcionarioId === funcionarioId && a.competencia === competencia);
  const historico = (anterior && anterior.historico) || [];
  historico.push({ autor: 'admin', mensagem: mensagemAdmin || null, data: new Date().toISOString(), tipo: 'envio' });

  const dados = {
    funcionarioId,
    competencia,
    status: 'pendente',
    mensagemContestacao: null,
    mensagemAdmin: mensagemAdmin || null,
    dataEnvio: new Date().toISOString(),
    dataResposta: null,
    historico
  };
  if (anterior) {
    await promisify(tx('aprovacoes', 'readwrite').put({ id: anterior.id, ...dados }));
  } else {
    await promisify(tx('aprovacoes', 'readwrite').add(dados));
  }
  alert('Repasse enviado para aprovação do funcionário!');
  await renderizarPainel();
}

let _envioAprovacaoPendente = null;
function abrirModalEnvioAprovacao(funcionarioId, competencia) {
  _envioAprovacaoPendente = { funcionarioId, competencia };
  document.getElementById('input-msg-envio-aprovacao').value = '';
  document.getElementById('modal-envio-aprovacao-overlay').classList.add('ativo');
}
function fecharModalEnvioAprovacao() {
  _envioAprovacaoPendente = null;
  document.getElementById('modal-envio-aprovacao-overlay').classList.remove('ativo');
}
async function confirmarEnvioAprovacao() {
  const msg = document.getElementById('input-msg-envio-aprovacao').value.trim();
  const { funcionarioId, competencia } = _envioAprovacaoPendente;
  fecharModalEnvioAprovacao();
  await enviarParaAprovacao(funcionarioId, competencia, msg || null);
}

async function responderAprovacao(aprovacaoId, novoStatus) {
  const aprovacao = await promisify(tx('aprovacoes').get(aprovacaoId));
  aprovacao.status = novoStatus;
  aprovacao.dataResposta = new Date().toISOString();
  if (!aprovacao.historico) aprovacao.historico = [];
  aprovacao.historico.push({ autor: 'funcionario', mensagem: null, data: aprovacao.dataResposta, tipo: 'aprovacao' });
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
  if (!aprovacao.historico) aprovacao.historico = [];
  aprovacao.historico.push({ autor: 'funcionario', mensagem: msg, data: aprovacao.dataResposta, tipo: 'contestacao' });
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
    .filter(f => !f.mesExclusao && f.tipo !== 'sdr') // Só assessores; SDR não lança venda/produto
    .map(f => `<option value="${f.id}">${f.nome}</option>`)
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
  const sufixo = prefixo === 'calc' ? '-calc' : '';
  const produto = document.getElementById(`select-produto${sufixo}`).value;
  // Na calculadora os grupos de campos ficam no mesmo form-row do Produto;
  // "contents" faz os filhos do grupo virarem itens do flex do form-row, em vez de uma linha própria.
  const modoExibicao = prefixo === 'calc' ? 'contents' : 'flex';

  // Esconde todos os campos específicos
  document.getElementById(`campos-padrao${sufixo}`).style.display = 'none';
  document.getElementById(`campos-seguro${sufixo}`).style.display = 'none';
  document.getElementById(`campos-consorcio${sufixo}`).style.display = 'none';
  document.getElementById(`campos-renda-variavel${sufixo}`).style.display = 'none';
  document.getElementById(`campos-plano-saude${sufixo}`).style.display = 'none';
  document.getElementById(`campos-genial${sufixo}`).style.display = 'none';

  // Mostra os campos relevantes
  if (produto === "Seguro") {
    document.getElementById(`campos-seguro${sufixo}`).style.display = modoExibicao;
    alterarSeguradoraSelecionada(prefixo); // Garante que o campo PJ2 seja atualizado
  } else if (produto === "Consórcio") {
    document.getElementById(`campos-consorcio${sufixo}`).style.display = modoExibicao;
    popularSelect(document.getElementById(`select-administradora-consorcio${sufixo}`), ADMINISTRADORAS_CONSORCIO);
  } else if (produto === "Renda Variável") {
    document.getElementById(`campos-renda-variavel${sufixo}`).style.display = modoExibicao;
    popularSelect(document.getElementById(`select-tipo-rv${sufixo}`), TIPOS_RENDA_VARIAVEL);
  } else if (produto === "Plano de Saúde") {
    document.getElementById(`campos-plano-saude${sufixo}`).style.display = modoExibicao;
    popularSelect(document.getElementById(`select-empresa-ps${sufixo}`), EMPRESAS_PLANO_SAUDE);
  } else if (PRODUTOS_GENIAL_TODOS.includes(produto)) {
    document.getElementById(`campos-genial${sufixo}`).style.display = modoExibicao;
  } else { // Renda Fixa, Fundos
    document.getElementById(`campos-padrao${sufixo}`).style.display = modoExibicao;
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
  } else if (PRODUTOS_GENIAL_TODOS.includes(produto)) {
    venda.comissaoAssessor = parseBR(document.getElementById("input-comissao-genial").value);
    if (isNaN(venda.comissaoAssessor) || venda.comissaoAssessor <= 0) { alert("Comissão do assessor inválida."); return; }
    if (PRODUTOS_GENIAL_DEDUCAO.includes(produto)) venda.comissaoAssessor = -venda.comissaoAssessor;
  } else { // Renda Fixa, Fundos
    venda.valor = parseBR(document.getElementById("input-valor").value);
    venda.percentualTitulo = parseBR(document.getElementById("input-percentual-variavel").value);
    if (isNaN(venda.valor) || venda.valor <= 0 || isNaN(venda.percentualTitulo) || venda.percentualTitulo <= 0) { alert("Valor ou percentual inválidos."); return; }
  }

  await promisify(tx("vendas", "readwrite").add(venda));
  alert("Venda lançada com sucesso!");
  renderizarPainel(); // Atualiza o painel de remuneração
}

// Garante que colaboradores com passagem recorrente configurada (ver lancarPassagem)
// tenham o lançamento do mês consultado já criado, sem precisar relançar manualmente
// todo mês. Cada colaborador mantém sua própria regra (tipo/quantidade) de forma
// independente, e só passa a valer a partir do mês em que foi configurada pela
// primeira vez — meses anteriores a isso, ou após a exclusão do colaborador, não são
// preenchidos automaticamente. Passagens já lançadas (manual ou recorrente) nunca são
// duplicadas nem sobrescritas.
async function garantirPassagensRecorrentes(competencia, funcionarios, passagensExistentes) {
  for (const funcionario of funcionarios) {
    const regra = funcionario.passagemRecorrente;
    if (!regra || !regra.tipo || !regra.quantidade) continue;
    if (funcionario.passagemRecorrenteDesde && competencia < funcionario.passagemRecorrenteDesde) continue;
    if (funcionario.mesExclusao && competencia >= funcionario.mesExclusao) continue;

    const jaExiste = passagensExistentes.some(p => p.funcionarioId === funcionario.id && p.competencia === competencia && p.tipo === regra.tipo);
    if (jaExiste) continue;

    const valorUnitario = configPassagem[regra.tipo];
    const valorTotal = valorUnitario * regra.quantidade;
    const dadosPassagem = { funcionarioId: funcionario.id, competencia, tipo: regra.tipo, quantidade: regra.quantidade, valorTotal, origem: "recorrente" };
    const novoId = await promisify(tx("passagens", "readwrite").add(dadosPassagem));
    passagensExistentes.push({ id: novoId, ...dadosPassagem });
  }
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

  // A partir deste lançamento, essa mesma passagem (tipo e quantidade) passa a ser
  // considerada automaticamente nos meses seguintes deste colaborador especificamente
  // (cada um com sua própria regra), sem precisar lançar de novo todo mês.
  const funcionario = await promisify(tx("funcionarios").get(funcionarioId));
  if (funcionario) {
    funcionario.passagemRecorrente = { tipo, quantidade };
    if (!funcionario.passagemRecorrenteDesde) funcionario.passagemRecorrenteDesde = competencia;
    await promisify(tx("funcionarios", "readwrite").put(funcionario));
  }

  alert("Passagem lançada com sucesso!");
  renderizarPainel(); // Atualiza o painel de remuneração
}

// ---- Importação automática do repasse da Genial ----
async function importarRepasseGenial(event) {
  const arquivo = event.target.files[0];
  if (!arquivo) return;

  const competenciaManual = document.getElementById("input-competencia-importacao-genial").value; // usada só se a planilha não tiver coluna de data

  const leitor = new FileReader();
  leitor.onload = async function (e) {
    try {
      const dados = new Uint8Array(e.target.result);
      const workbook = XLSX.read(dados, { type: "array", cellDates: true });
      const nomeAba = workbook.SheetNames.includes("Data") ? "Data" : workbook.SheetNames[0];
      const planilha = workbook.Sheets[nomeAba];

      // Alguns extratos vêm com espaço sobrando no nome da coluna ("REPASSE ", "IMPOSTO ") — remove.
      const semEspacoNasChaves = linhasBrutas => linhasBrutas.map(linha => {
        const nova = {};
        for (const chave in linha) nova[chave.trim()] = linha[chave];
        return nova;
      });

      // A planilha da Genial às vezes tem uma linha de aviso antes do cabeçalho,
      // e às vezes não — detecta automaticamente onde está o cabeçalho real.
      let linhas = semEspacoNasChaves(XLSX.utils.sheet_to_json(planilha, { range: 0, defval: "" }));
      if (!(linhas.length && "ASSESSOR" in linhas[0])) {
        linhas = semEspacoNasChaves(XLSX.utils.sheet_to_json(planilha, { range: 1, defval: "" }));
      }
      if (!(linhas.length && "ASSESSOR" in linhas[0])) {
        alert("Não encontrei a coluna 'ASSESSOR' nesta planilha. Confira se é o modelo correto da Genial.");
        return;
      }

      const chavesMapeadasNormalizadas = Object.keys(MAPEAMENTO_REPASSE_GENIAL).map(k => ({ chave: k, norm: normalizarNome(k) }));

      // Formato novo (extrato "07RITMO"): já vem com o cálculo pronto linha a linha —
      // VALOR BRUTO (metade do repasse) e VALOR LÍQUIDO (bruto menos o % de IMPOSTO da
      // própria linha, que varia por produto). Usamos os valores exatamente como vêm,
      // sem reaplicar ÷2/19,03% por cima — evita reconciliar manualmente com o extrato da Genial.
      const formatoNovo = "VALOR LÍQUIDO" in linhas[0] && "VALOR BRUTO" in linhas[0] && "REPASSE" in linhas[0];
      const temColunasBrutoImposto = "VALOR BRUTO AAI" in linhas[0] && "IMPOSTO" in linhas[0];
      const totaisPorFuncionario = {}; // { NOME_NORMALIZADO: { nome, produtos: { "competencia|produto": { comissao, bruto, imposto, valorLiquidoFinal } } } }
      let linhasSemCompetencia = 0;

      for (const linha of linhas) {
        const assessorPlanilha = String(linha["ASSESSOR"] || "").trim();
        if (!assessorPlanilha) continue;

        const normAssessor = normalizarNome(assessorPlanilha);
        const encontrado = chavesMapeadasNormalizadas.find(c => c.norm === normAssessor);
        if (!encontrado) continue; // fora do mapeamento por enquanto — ignora

        let competencia;
        const dataReceita = linha["DATA DE RECEITA"];
        if (dataReceita instanceof Date && !isNaN(dataReceita.getTime())) {
          competencia = `${dataReceita.getFullYear()}-${String(dataReceita.getMonth() + 1).padStart(2, "0")}`;
        } else if (competenciaManual) {
          competencia = competenciaManual;
        } else {
          linhasSemCompetencia++;
          continue;
        }

        const tipoProdutoPlanilha = String(linha["TIPO PRODUTO"] || "").trim();
        const produto = identificarProdutoGenial(tipoProdutoPlanilha) || PRODUTO_REPASSE_IMPORTADO;

        const nomeFuncionario = MAPEAMENTO_REPASSE_GENIAL[encontrado.chave];
        const chaveFuncionario = normalizarNome(nomeFuncionario);
        const chaveProduto = `${competencia}|${produto}`;

        if (!totaisPorFuncionario[chaveFuncionario]) totaisPorFuncionario[chaveFuncionario] = { nome: nomeFuncionario, produtos: {} };
        const acumulado = totaisPorFuncionario[chaveFuncionario].produtos[chaveProduto] || { comissao: 0, bruto: 0, imposto: 0, valorLiquidoFinal: 0, receitaBruta: 0 };

        if (formatoNovo) {
          acumulado.bruto += Number(linha["VALOR BRUTO"]) || 0;
          acumulado.valorLiquidoFinal += Number(linha["VALOR LÍQUIDO"]) || 0;
        } else {
          // Prioriza a coluna "COMISSÃO ASSESSOR"; usa "VALOR LIQUIDO AAI" como alternativa
          // em planilhas que não tenham essa coluna. O sinal vindo da planilha é sempre
          // respeitado tal como está — mesmo em Custo de Plataforma/Taxa de Performance,
          // que costumam vir negativos, mas podem ter linhas positivas legítimas
          // (estornos/créditos). Não forçamos o sinal aqui para não corromper esses casos.
          const valorComissaoBruto = linha["COMISSÃO ASSESSOR"] !== undefined && linha["COMISSÃO ASSESSOR"] !== ""
            ? linha["COMISSÃO ASSESSOR"]
            : linha["VALOR LIQUIDO AAI"];
          acumulado.comissao += Number(valorComissaoBruto) || 0;
          if (temColunasBrutoImposto) {
            acumulado.bruto += Number(linha["VALOR BRUTO AAI"]) || 0;
            acumulado.imposto += Number(linha["IMPOSTO"]) || 0;
          }
          if (linha["RECEITA GENIAL (*)"] !== undefined) {
            acumulado.receitaBruta += Number(linha["RECEITA GENIAL (*)"]) || 0;
          }
        }
        totaisPorFuncionario[chaveFuncionario].produtos[chaveProduto] = acumulado;
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
          const { comissao, bruto, imposto, valorLiquidoFinal, receitaBruta } = produtos[chaveProduto];
          let dadosVenda;

          if (formatoNovo) {
            dadosVenda = {
              funcionarioId: funcionario.id,
              produto,
              competencia,
              comissaoAssessor: valorLiquidoFinal,
              origem: "genial-import",
              valorBrutoPlanilha: bruto,
              valorLiquidoPlanilhaFinal: valorLiquidoFinal,
              impostoPercentualPlanilha: bruto !== 0 ? (1 - valorLiquidoFinal / bruto) : 0
            };
          } else {
            dadosVenda = {
              funcionarioId: funcionario.id,
              produto,
              competencia,
              comissaoAssessor: comissao,
              origem: "genial-import"
            };
            if (temColunasBrutoImposto) {
              dadosVenda.valorBrutoPlanilha = bruto;
              dadosVenda.impostoPlanilha = imposto;
            }
            if (receitaBruta) {
              dadosVenda.receitaBrutaPlanilha = receitaBruta;
            }
          }

          const existente = todasVendas.find(v => v.funcionarioId === funcionario.id && v.competencia === competencia && v.produto === produto && v.origem === "genial-import");
          if (existente) {
            await promisify(tx("vendas", "readwrite").put({ ...existente, ...dadosVenda }));
          } else {
            await promisify(tx("vendas", "readwrite").add(dadosVenda));
          }
          resumo.push(`${funcionario.nome} — ${formatarCompetencia(competencia)} — ${produto}: ${formatarMoeda(dadosVenda.comissaoAssessor)}`);
        }
      }

      let mensagem = resumo.length
        ? `Importação concluída:\n\n${resumo.join("\n")}`
        : "Nenhum lançamento correspondente ao mapeamento atual foi encontrado nesta planilha.";
      if (naoEncontrados.size > 0) {
        mensagem += `\n\n⚠️ Não encontrei cadastro na aba Equipe para: ${[...naoEncontrados].join(", ")}. Verifique se o nome está exatamente igual.`;
      }
      if (linhasSemCompetencia > 0) {
        mensagem += `\n\n⚠️ ${linhasSemCompetencia} linha(s) foram ignoradas por não terem data de receita nem um mês de referência selecionado antes de importar.`;
      }
      alert(mensagem);
      event.target.value = "";
      await renderizarPainel();
    } catch (err) {
      console.error("Erro ao importar repasse Genial:", err);
      alert("Erro ao processar o arquivo. Confira se é o modelo correto da Genial (colunas ASSESSOR, TIPO PRODUTO, COMISSÃO ASSESSOR).");
    }
  };
  leitor.readAsArrayBuffer(arquivo);
}

function atualizarValorPassagemLabel() {
  document.getElementById("valor-unit-metro-label").textContent = formatarMoeda(configPassagem.metro).replace("R$", "");
  document.getElementById("valor-unit-onibus-label").textContent = formatarMoeda(configPassagem.onibus).replace("R$", "");
  document.getElementById("valor-unit-vlt-label").textContent = formatarMoeda(configPassagem.vlt).replace("R$", "");
  document.getElementById("valor-unit-barca-label").textContent = formatarMoeda(configPassagem.barca).replace("R$", "");
  document.getElementById("valor-unit-trem-label").textContent = formatarMoeda(configPassagem.trem).replace("R$", "");
}

function alternarConfigPassagem() {
  const cardConfig = document.getElementById("card-config-passagem");
  const btn = document.getElementById("botao-alternar-config-passagem");
  if (cardConfig.style.display === 'none') {
    cardConfig.style.display = 'flex';
    document.getElementById("input-valor-metro").value = formatarBR(configPassagem.metro);
    document.getElementById("input-valor-onibus").value = formatarBR(configPassagem.onibus);
    document.getElementById("input-valor-vlt").value = formatarBR(configPassagem.vlt);
    document.getElementById("input-valor-barca").value = formatarBR(configPassagem.barca);
    document.getElementById("input-valor-trem").value = formatarBR(configPassagem.trem);
    btn.textContent = "Esconder ajustes";
  } else {
    cardConfig.style.display = 'none';
    btn.textContent = "Ajustar valores da passagem";
  }
}

async function salvarConfigPassagem() {
  const metro = parseBR(document.getElementById("input-valor-metro").value);
  const onibus = parseBR(document.getElementById("input-valor-onibus").value);
  const vlt = parseBR(document.getElementById("input-valor-vlt").value);
  const barca = parseBR(document.getElementById("input-valor-barca").value);
  const trem = parseBR(document.getElementById("input-valor-trem").value);

  if ([metro, onibus, vlt, barca, trem].some(v => isNaN(v) || v <= 0)) { alert("Valores de passagem inválidos."); return; }

  configPassagem = { metro, onibus, vlt, barca, trem };
  await promisify(tx("configuracoes", "readwrite").put({ chave: "passagem", metro, onibus, vlt, barca, trem }));
  atualizarValorPassagemLabel();
  alert("Valores de passagem salvos!");
  alternarConfigPassagem(); // Esconde o card após salvar
}

// ===================== CALCULADORA =====================

async function renderizarCalculadoraTab() {
  popularSelectProdutos("select-produto-calc");
  alterarProdutoSelecionado('calc'); // Renderiza os campos para o produto inicial
  document.getElementById("resultado-simulacao").innerHTML = "";
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
  } else if (PRODUTOS_GENIAL_TODOS.includes(produto)) {
    simulacaoItem.comissaoAssessor = parseBR(document.getElementById("input-comissao-genial-calc").value);
    if (isNaN(simulacaoItem.comissaoAssessor) || simulacaoItem.comissaoAssessor <= 0) { alert("Comissão do assessor inválida."); return; }
    if (PRODUTOS_GENIAL_DEDUCAO.includes(produto)) simulacaoItem.comissaoAssessor = -simulacaoItem.comissaoAssessor;
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
    resultadoEl.innerHTML = "";
    return;
  }

  let html = "<h4>Itens simulados:</h4>";

  // Para a simulação, precisamos de um funcionário dummy para o cálculo de Azos
  const dummyFuncionario = { id: 0, nome: "Simulação", tipo: "assessor", mesExclusao: null, mesConversaoAssessor: null };
  const { totalAssessorMes, vendasCalculadas } = await calcularRemuneracaoMensal(dummyFuncionario, competenciaAtualDoSistema(), simulacaoAtual, []);

  for (const venda of vendasCalculadas) {
    html += `
      <div class="item-remuneracao">
        <h4>${venda.produto} - ${formatarMoedaColorida(venda.valorLiquido)}</h4>
        <div class="detalhe-expandido ativo">
          Valor/Prêmio: ${formatarMoedaColorida(venda.valorPrincipal)}<br>
          Detalhe: ${venda.detalheProduto}<br>
          Repasse Escritório: ${formatarMoedaColorida(venda.valorEscritorio)}
        </div>
      </div>
    `;
  }
  html += `<div class="total-geral">Total Simulado: ${formatarMoedaColorida(totalAssessorMes)}</div>`;
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
  await renderizarAssessoresTab();
}

async function alterarNomeUsuario(usuarioId, funcionarioId) {
  const usuario = await promisify(tx("usuarios").get(usuarioId));
  const novoNome = prompt("Digite o novo nome:", usuario.nome);
  if (!novoNome || !novoNome.trim()) return;
  const nome = novoNome.trim();

  usuario.nome = nome;
  await promisify(tx("usuarios", "readwrite").put(usuario));

  if (funcionarioId) {
    const funcionario = await promisify(tx("funcionarios").get(funcionarioId));
    if (funcionario) {
      funcionario.nome = nome;
      await promisify(tx("funcionarios", "readwrite").put(funcionario));
    }
  }

  alert("Nome atualizado.");
  await renderizarAssessoresTab();
  await renderizarPainel();
}

async function alterarLoginUsuario(usuarioId) {
  const usuario = await promisify(tx("usuarios").get(usuarioId));
  const novoLogin = prompt("Digite o novo login:", usuario.login);
  if (!novoLogin || !novoLogin.trim()) return;
  const login = novoLogin.trim();

  const usuarios = await promisify(tx("usuarios").getAll());
  if (usuarios.some(u => u.id !== usuarioId && u.login.toLowerCase() === login.toLowerCase())) {
    alert("Este login já está em uso.");
    return;
  }

  usuario.login = login;
  await promisify(tx("usuarios", "readwrite").put(usuario));
  alert("Login atualizado.");
  await renderizarAssessoresTab();
}

const senhasVisiveis = new Set();
function alternarSenhaVisivel(usuarioId) {
  if (senhasVisiveis.has(usuarioId)) senhasVisiveis.delete(usuarioId);
  else senhasVisiveis.add(usuarioId);
  renderizarAssessoresTab();
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

    const senhaVisivel = senhasVisiveis.has(u.id);
    return `
      <tr>
        <td>${u.nome}</td><td>${u.login}</td>
        <td>${senhaVisivel ? u.senha : '••••••••'} <button class="link-discreto" onclick="alternarSenhaVisivel('${u.id}')">${senhaVisivel ? 'Ocultar' : 'Mostrar'}</button></td>
        <td>${rotuloFuncao}</td>
        <td>
          <button class="btn-editar" onclick="alterarNomeUsuario('${u.id}','${u.funcionarioId || ''}')">Alterar nome</button>
          <button class="btn-editar" onclick="alterarLoginUsuario('${u.id}')">Alterar login</button>
          <button class="btn-editar" onclick="alterarSenhaUsuario('${u.id}')">Alterar senha</button>
          ${acoesHtml}
        </td>
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
    await garantirPassagensRecorrentes(competenciaFiltro, [funcionario], passagens);
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

  const linhasVendasArr = vendasCalculadas.map(v => `<tr><td>${formatarCompetencia(v.competencia)}</td><td>${v.produto}</td><td>${formatarMoedaColorida(v.valorPrincipal)}</td><td>${v.detalheProduto}</td><td>${formatarMoedaColorida(v.valorEscritorio)}</td><td>${formatarMoedaColorida(v.valorLiquido)}</td></tr>`);
  const linhasPassagensArr = passagensCalculadas.map(p => `<tr><td>${formatarCompetencia(p.competencia)}</td><td>Passagem ${rotuloTipoPassagem(p.tipo)}</td><td>${p.quantidade}x ${formatarMoeda(p.valorUnitario)}</td><td></td><td></td><td>${formatarMoeda(p.valorTotal)}</td></tr>`);

  const linhas = [...linhasVendasArr, ...linhasPassagensArr].join("");

  const dataAtual = new Date().toLocaleDateString("pt-BR");
  const periodoTexto = competenciaFiltro ? formatarCompetencia(competenciaFiltro) : "Todos os períodos";
  const notaPiso = funcionario.tipo !== "sdr" ? `<p class="status">Observação: o total pago pode ser maior que a soma variável acima, pois o assessor tem piso mensal garantido de R$ ${formatarMoeda(PISO_MENSAL_ASSESSOR).replace("R$", "")} quando o variável do mês não atinge esse valor.</p>` : "";

  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Relatório - ${funcionario.nome}</title>
    <style>* { box-sizing:border-box; } body { margin:0; font-family:Arial, sans-serif; color:#111827; } .relatorio-pdf { padding:30px; } h1 { text-align:center; color:#5b21b6; } h2 { color:#5b21b6; border-bottom:2px solid #7c3aed; padding-bottom:8px; } table { width:100%; border-collapse:collapse; } th, td { border:1px solid #ddd; padding:6px; font-size:10px; } th { background:#f3effc; } .totais { margin-top:20px; padding:14px; background:#f0fdf4; border:1px solid #86efac; border-radius:8px; } .botao-imprimir { text-align:center; margin:20px 0; } @media print { .botao-imprimir { display:none; } } .valor-negativo { color:#dc2626; font-weight:700; }</style>
    </head><body>
    <div class="botao-imprimir"><button onclick="window.print()">Imprimir / Salvar PDF</button></div>
    <main class="relatorio-pdf">
      <h1>Relatório de Remuneração — Ritmo Investimentos</h1>
      <p><strong>Colaborador:</strong> ${funcionario.nome}${funcionario.tipo === "sdr" ? " (SDR)" : ""}${funcionario.mesExclusao ? ` (Excluído em ${formatarCompetencia(funcionario.mesExclusao)})` : ""}<br><strong>Período:</strong> ${periodoTexto}<br><strong>Emitido em:</strong> ${dataAtual}</p>
      <h2>Detalhes</h2>
      ${(vendas.length || passagens.length) ? `<table><thead><tr><th>Mês</th><th>Item</th><th>Valor/Prêmio</th><th>Detalhe</th><th>Escritório</th><th>Líquido</th></tr></thead><tbody>${linhas}</tbody></table>` : "<p>Nenhum item no período.</p>"}
      <div class="totais"><strong>Total líquido: ${formatarMoedaColorida(totalAssessorMes)}</strong><br>Total variável bruto: ${formatarMoedaColorida(totalVariavelMes)}</div>
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
      // Mantém o id original de cada documento (via put), preservando as referências
      // cruzadas entre coleções (venda.funcionarioId, usuario.funcionarioId etc.) —
      // usar add() aqui geraria ids novos e quebraria esses vínculos.
      for (const f of backup.funcionarios || []) { await promisify(tx("funcionarios","readwrite").put(f)); }
      for (const v of backup.vendas || []) { await promisify(tx("vendas","readwrite").put(v)); }
      for (const u of backup.usuarios || []) { await promisify(tx("usuarios","readwrite").put(u)); }
      for (const p of backup.passagens || []) { await promisify(tx("passagens","readwrite").put(p)); }
      for (const c of backup.configuracoes || []) { await promisify(tx("configuracoes","readwrite").add(c)); }

      alert("Backup importado! Recarregando...");
      sessionStorage.removeItem("usuarioLogadoId");
      location.reload();
    } catch (err) { alert("Arquivo inválido."); console.error(err); }
  };
  reader.readAsText(file);
  event.target.value = "";
}

// ---- Exportação/importação completa em Excel (.xlsx) ----
const ABAS_DADOS_EXCEL = {
  "Equipe": "funcionarios",
  "Remuneração": "vendas",
  "Passagens": "passagens",
  "Aprovações": "aprovacoes",
  "Usuários": "usuarios"
};

// Calcula o cabeçalho como a união de todas as chaves usadas em qualquer item da
// lista (registros de venda têm campos diferentes conforme o produto), sempre com
// "id" na primeira coluna.
function cabecalhoUniao(lista) {
  const header = ["id"];
  for (const item of lista) {
    for (const chave in item) {
      if (chave !== "id" && !header.includes(chave)) header.push(chave);
    }
  }
  return header;
}

async function exportarDadosExcel() {
  const wb = XLSX.utils.book_new();
  for (const nomeAba in ABAS_DADOS_EXCEL) {
    const lista = await promisify(tx(ABAS_DADOS_EXCEL[nomeAba]).getAll());
    const sheet = XLSX.utils.json_to_sheet(lista, { header: cabecalhoUniao(lista) });
    XLSX.utils.book_append_sheet(wb, sheet, nomeAba);
  }
  XLSX.writeFile(wb, `dados-ritmo-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

async function importarDadosExcel(event) {
  const arquivo = event.target.files[0];
  if (!arquivo) return;

  const leitor = new FileReader();
  leitor.onload = async function (e) {
    try {
      const dados = new Uint8Array(e.target.result);
      const workbook = XLSX.read(dados, { type: "array" });

      const registrosPorColecao = {};
      for (const nomeAba in ABAS_DADOS_EXCEL) {
        const sheet = workbook.Sheets[nomeAba];
        registrosPorColecao[ABAS_DADOS_EXCEL[nomeAba]] = sheet ? XLSX.utils.sheet_to_json(sheet) : [];
      }

      if (!confirm("Isso substitui todos os dados atuais (Equipe, Remuneração, Passagens, Aprovações e Usuários) pelos do arquivo. Continuar?")) {
        event.target.value = "";
        return;
      }

      for (const colecao of Object.values(ABAS_DADOS_EXCEL)) {
        await promisify(tx(colecao, "readwrite").clear());
      }
      // Preserva o id original de cada linha (via put) para manter as referências
      // cruzadas entre abas (ex.: funcionarioId em Remuneração/Passagens/Usuários).
      for (const colecao in registrosPorColecao) {
        for (const item of registrosPorColecao[colecao]) {
          if (item.id === undefined || item.id === "") {
            const { id, ...resto } = item;
            await promisify(tx(colecao, "readwrite").add(resto));
          } else {
            await promisify(tx(colecao, "readwrite").put({ ...item, id: String(item.id) }));
          }
        }
      }

      alert("Dados importados com sucesso! Recarregando...");
      sessionStorage.removeItem("usuarioLogadoId");
      location.reload();
    } catch (err) {
      console.error("Erro ao importar dados:", err);
      alert("Erro ao processar o arquivo. Confira se é um arquivo exportado por este sistema (use \"Exportar Dados (.xlsx)\").");
    }
  };
  leitor.readAsArrayBuffer(arquivo);
  event.target.value = "";
}

// ===================== INICIALIZAÇÃO =====================

(async () => {
  await abrirBanco();
  await garantirAdminsPadrao();
  await carregarConfigPassagem();
  await verificarSessao();
})();
