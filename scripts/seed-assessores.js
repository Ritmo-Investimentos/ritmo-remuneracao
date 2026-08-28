// Script utilitário de uso único: cadastra funcionários (assessores) e seus
// logins diretamente no Firestore, replicando exatamente o que
// adicionarAssessor() faz na aplicação. Roda via GitHub Actions
// (workflow seed-assessores.yml) usando a mesma credencial de deploy.
const admin = require("firebase-admin");

admin.initializeApp({ projectId: "remuneracao-ritmo" });
const db = admin.firestore();

const ASSESSORES = [
  { nome: "Wagner Pinheiro de Barros", login: "wagner.pinheiro" },
  { nome: "Cauã Barqueta", login: "caua.barqueta" },
  { nome: "Pablo Henrique", login: "pablo.henrique" },
  { nome: "Gabriel Almeida de Sousa", login: "gabriel.sousa" },
  { nome: "Lucas de Araújo Felizardo da Silva", login: "lucas.araujo" },
  { nome: "Davi da Silva Faria", login: "davi.silva" }
];
const SENHA = "1234";

async function main() {
  const usuariosSnap = await db.collection("usuarios").get();
  const loginsExistentes = new Set(usuariosSnap.docs.map(d => (d.data().login || "").toLowerCase()));

  for (const { nome, login } of ASSESSORES) {
    if (loginsExistentes.has(login.toLowerCase())) {
      console.log(`PULADO (login já existe): ${nome} (${login})`);
      continue;
    }

    const funcionarioRef = await db.collection("funcionarios").add({
      nome,
      tipo: "assessor",
      mesExclusao: null,
      mesConversaoAssessor: null
    });

    await db.collection("usuarios").add({
      nome,
      login,
      senha: SENHA,
      tipo: "assessor",
      funcionarioId: funcionarioRef.id,
      ativo: true
    });

    console.log(`CRIADO: ${nome} (login: ${login}, funcionarioId: ${funcionarioRef.id})`);
  }
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
