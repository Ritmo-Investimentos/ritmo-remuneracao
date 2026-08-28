// firebase-init.js — Inicializa Firebase e expõe Firestore globalmente
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  getDocs,
  getDoc,
  addDoc,
  setDoc,
  deleteDoc,
  query,
  where
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDtY-ftesVOgJWL1oXiwbjrFC_jlO2jMIA",
  authDomain: "remuneracao-ritmo.firebaseapp.com",
  databaseURL: "https://remuneracao-ritmo-default-rtdb.firebaseio.com",
  projectId: "remuneracao-ritmo",
  storageBucket: "remuneracao-ritmo.firebasestorage.app",
  messagingSenderId: "923670741677",
  appId: "1:923670741677:web:4d7b6c89c2dbff64597c24",
  measurementId: "G-LP0FHNQVKW"
};

const app = initializeApp(firebaseConfig);
const firestoreDb = getFirestore(app);

// Expõe globalmente para o script principal (não-module)
window.__firestoreDb = firestoreDb;
window.__firestoreApi = {
  collection, doc, getDocs, getDoc, addDoc, setDoc, deleteDoc, query, where
};
