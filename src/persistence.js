const fs = require('fs');
const path = require('path');

/**
 * ============================================
 * DATA PERSISTENCE LAYER
 * Salva UserProfiles e StreamersMonitored em arquivos JSON
 * ============================================
 */

const DATA_DIR = path.join(__dirname, '..', 'data');
const USER_PROFILES_FILE = path.join(DATA_DIR, 'userProfiles.json');
const STREAMERS_FILE = path.join(DATA_DIR, 'streamersMonitored.json');

// Criar diretório de dados se não existir
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`📁 Diretório de dados criado: ${DATA_DIR}`);
}

/**
 * Carrega UserProfiles do arquivo
 * @returns {Map} Map de UserProfiles
 */
function loadUserProfiles() {
  try {
    if (fs.existsSync(USER_PROFILES_FILE)) {
      const data = fs.readFileSync(USER_PROFILES_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      const map = new Map(parsed);
      console.log(`✅ UserProfiles carregados: ${map.size} usuários`);
      return map;
    }
  } catch (err) {
    console.error('❌ Erro ao carregar UserProfiles:', err.message);
  }
  return new Map();
}

/**
 * Carrega StreamersMonitored do arquivo
 * @returns {Map} Map de streamers monitorados
 */
function loadStreamersMonitored() {
  try {
    if (fs.existsSync(STREAMERS_FILE)) {
      const data = fs.readFileSync(STREAMERS_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      const map = new Map(parsed);
      console.log(`✅ StreamersMonitored carregados: ${map.size} usuários`);
      return map;
    }
  } catch (err) {
    console.error('❌ Erro ao carregar StreamersMonitored:', err.message);
  }
  return new Map();
}

/**
 * Salva UserProfiles em arquivo
 * @param {Map} map - Map de UserProfiles
 */
function saveUserProfiles(map) {
  try {
    const data = JSON.stringify(Array.from(map.entries()), null, 2);
    fs.writeFileSync(USER_PROFILES_FILE, data, 'utf-8');
  } catch (err) {
    console.error('❌ Erro ao salvar UserProfiles:', err.message);
  }
}

/**
 * Salva StreamersMonitored em arquivo
 * @param {Map} map - Map de streamers
 */
function saveStreamersMonitored(map) {
  try {
    const data = JSON.stringify(Array.from(map.entries()), null, 2);
    fs.writeFileSync(STREAMERS_FILE, data, 'utf-8');
  } catch (err) {
    console.error('❌ Erro ao salvar StreamersMonitored:', err.message);
  }
}

module.exports = {
  loadUserProfiles,
  loadStreamersMonitored,
  saveUserProfiles,
  saveStreamersMonitored,
  DATA_DIR,
  USER_PROFILES_FILE,
  STREAMERS_FILE
};
