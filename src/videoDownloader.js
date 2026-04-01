/**
 * videoDownloader.js - Downloader de vídeos de clipes Twitch
 * Responsabilidades:
 * - Buscar URL real do MP4 (via GraphQL ou alternativas)
 * - Download com retry automático
 * - Progress tracking
 * - Tratamento de erros
 */

const fetch = require('node-fetch').default;
const https = require('https');
const http = require('http');
const { Readable } = require('stream');

class VideoDownloader {
  constructor(twitchClientId, twitchToken) {
    this.clientId = twitchClientId;
    this.token = twitchToken;
    this.maxRetries = 3;
    this.downloadTimeout = 60000; // 60 segundos
  }

  /**
   * Obtém URL real do vídeo do clipe
   * Tenta múltiplas estratégias:
   * 1. GraphQL Query (mais direto)
   * 2. Interceptar resposta da página
   * 
   * @param {string} clipSlug - Slug único do clipe
   * @param {string} channel - Nome do canal (username) para HTML parsing
   * @returns {Promise<string>} - URL do vídeo MP4
   */
  async getClipVideoURL(clipSlug, channel = null) {
    try {
      console.log(`\n  🎬 [DOWNLOADER] Obtendo URL para clip: ${clipSlug}`);
      console.log(`     ClientID: ${this.clientId}`);
      console.log(`     Token disponível: ${this.token ? 'SIM (' + this.token.substring(0, 20) + '...)' : 'NÃO'}`);
      
      // Estratégia 1: Tentar GraphQL (melhor performance)
      try {
        console.log(`     📡 Tentando estratégia 1: GraphQL...`);
        const url = await this.getVideoUrlViaGraphQL(clipSlug);
        if (url) {
          console.log(`     ✅ GraphQL sucesso!`);
          return url;
        }
        console.log(`     ⚠️ GraphQL retornou vazio`);
      } catch (err) {
        console.warn(`     ⚠️ GraphQL falhou:`, err.message);
      }

      // Estratégia 2: Extrair de metadados da página HTML
      try {
        console.log(`     🌐 Tentando estratégia 2: HTML Parse...`);
        const url = await this.getVideoUrlFromHTML(clipSlug, channel);
        if (url) {
          console.log(`     ✅ HTML Parse sucesso!`);
          return url;
        }
        console.log(`     ⚠️ HTML Parse retornou vazio`);
      } catch (err) {
        console.warn(`     ⚠️ HTML Parse falhou:`, err.message);
      }

      console.error(`  🔴 [DOWNLOADER] FALHA TOTAL: não foi possível obter URL para ${clipSlug}`);
      throw new Error(`Não foi possível obter URL do vídeo para ${clipSlug}`);
    } catch (err) {
      console.error(`  🔴 [DOWNLOADER] Erro fatal:`, err.message);
      throw err;
    }
  }

  /**
   * Obtém URL via GraphQL Query
   * @private
   */
  async getVideoUrlViaGraphQL(clipSlug) {
    const query = {
      operationName: 'GetClip',
      extensions: { persistedQuery: { version: 1, sha256Hash: 'preSS7p7qXD8A3oHr8KBPb2RrLF8O5L7HBzPjSbdzCU' } },
      variables: { slug: clipSlug }
    };

    try {
      console.log(`       └─ GraphQL: enviando query...`);
      const resp = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: {
          'Client-ID': this.clientId,
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
          'User-Agent': 'Mozilla/5.0'
        },
        body: JSON.stringify(query)
      });

      console.log(`       └─ GraphQL: HTTP ${resp.status}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = await resp.json();

      // Verifica por erros na resposta GraphQL
      if (data.errors && data.errors.length > 0) {
        console.log(`       └─ GraphQL error:`, data.errors[0].message);
        return null;
      }

      // Navega na resposta GraphQL
      const videoQualities = data?.data?.clip?.videoQualities;
      if (!videoQualities || !videoQualities.length) {
        console.log(`       └─ GraphQL: clip não tem videoQualities`);
        return null;
      }

      // Retorna a qualidade mais alta
      const url = videoQualities[0].sourceURL;
      console.log(`       └─ GraphQL: URL encontrada (${url.substring(0, 60)}...)`);
      return url;
    } catch (err) {
      console.log(`       └─ GraphQL exception:`, err.message);
      return null;
    }
  }

  /**
   * Extrai URL do vídeo do HTML da página
   * @private
   * @param {string} clipSlug - Slug do clip
   * @param {string} channel - Nome do canal para construir URL correta
   */
  async getVideoUrlFromHTML(clipSlug, channel) {
    try {
      // Tenta múltiplas URLs possíveis
      const baseUrls = [
        // URL correta com channel (recomendado)
        channel ? `https://www.twitch.tv/${channel}/clip/${clipSlug}` : null,
        // Fallbacks
        `https://clips.twitch.tv/${clipSlug}`,
        `https://www.twitch.tv/${clipSlug}`,
        `https://twitch.tv/${clipSlug}`
      ].filter(Boolean); // Remove null

      for (const clipUrl of baseUrls) {
        try {
          console.log(`🔍 Tentando extrair URL de: ${clipUrl}`);
          const resp = await fetch(clipUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 10000
          });

          if (resp.status === 404) continue;
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

          const html = await resp.text();
          const url = this.extractVideoUrlFromHTML(html);
          
          if (url) {
            console.log(`✅ URL extraída de ${clipUrl}`);
            return url;
          }
        } catch (err) {
          console.warn(`⚠️ Erro ao tentar ${clipUrl}:`, err.message);
          continue;
        }
      }

      return null;
    } catch (err) {
      console.warn(`⚠️ HTML parse error:`, err.message);
      return null;
    }
  }

  /**
   * Extrai URL de vídeo do código HTML
   * Estratégia: Multi-padrão com fallbacks progressivos
   * @private
   */
  extractVideoUrlFromHTML(html) {
    if (!html || html.length === 0) return null;

    console.log(`   📊 Tamanho do HTML: ${html.length} bytes`);

    // PADRÃO 1: production.assets.clips.twitchcdn.net com query string completa
    console.log(`     📋 Padrão 1: production.assets.clips.twitchcdn.net...`);
    let match = html.match(/(https:\/\/production\.assets\.clips\.twitchcdn\.net\/v2\/media\/[^"'<>\s]+\/[^"'<>\s]+\/video-\d+\.mp4[^"'<>\s]*)/gi);
    if (match && match.length > 0) {
      const url = match[0];
      console.log(`     ✅ Encontrada! ${url.substring(0, 100)}...`);
      return url;
    }
    console.log(`     ⚠️ Não encontrado`);

    // PADRÃO 2: twitchcdn genérico (v1 ou v2)
    console.log(`     📋 Padrão 2: qualquer .twitchcdn.net...`);
    match = html.match(/(https:\/\/[^\s"'<>]*\.twitchcdn\.net\/[^\s"'<>]*\/video[^\s"'<>]*\.mp4[^\s"'<>]*)/gi);
    if (match && match.length > 0) {
      const url = match[0];
      console.log(`     ✅ Encontrada! ${url.substring(0, 100)}...`);
      return url;
    }
    console.log(`     ⚠️ Não encontrado`);

    // PADRÃO 3: sourceURL em JSON
    console.log(`     📋 Padrão 3: sourceURL JSON...`);
    match = html.match(/"sourceURL"\s*:\s*"([^"]+mp4[^"]*?)"/i);
    if (match && match[1]) {
      const url = match[1].replace(/\\\//g, '/');
      console.log(`     ✅ Encontrada! ${url.substring(0, 100)}...`);
      return url;
    }
    console.log(`     ⚠️ Não encontrado`);

    // PADRÃO 4: Atributo src em tags
    console.log(`     📋 Padrão 4: atributo src em tags...`);
    match = html.match(/<(?:video|source)[^>]*src=["']([^"']+\.mp4[^"']*?)["']/i);
    if (match && match[1]) {
      console.log(`     ✅ Encontrada! ${match[1].substring(0, 100)}...`);
      return match[1];
    }
    console.log(`     ⚠️ Não encontrado`);

    // PADRÃO 5: streamURL JSON
    console.log(`     📋 Padrão 5: streamURL JSON...`);
    match = html.match(/"streamURL"\s*:\s*"([^"]+)"/i);
    if (match && match[1]) {
      console.log(`     ✅ Encontrada! ${match[1].substring(0, 100)}...`);
      return match[1];
    }
    console.log(`     ⚠️ Não encontrado`);

    // PADRÃO 6: https://*.mp4 genérico
    console.log(`     📋 Padrão 6: qualquer https://*.mp4...`);
    match = html.match(/(https:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*)/i);
    if (match && match[1]) {
      const url = match[1];
      if (!url.includes('thumbnail') && !url.includes('preview') && !url.includes('ad') && url.length > 30) {
        console.log(`     ✅ Encontrada! ${url.substring(0, 100)}...`);
        return url;
      }
    }
    console.log(`     ⚠️ Não encontrado`);

    console.log(`   ❌ Nenhuma URL de MP4 encontrada`);
    return null;
  }

  /**
   * Baixa vídeo com retry automático
   * @param {string} videoUrl - URL do vídeo
   * @param {object} options - {maxRetries, timeout, onProgress}
   * @returns {Promise<Stream>} - Stream do vídeo
   */
  async download(videoUrl, options = {}) {
    const { maxRetries = this.maxRetries, timeout = this.downloadTimeout, onProgress } = options;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`📥 Download tentativa ${attempt}/${maxRetries}: ${videoUrl.substring(0, 60)}...`);
        return await this.downloadWithStream(videoUrl, { timeout, onProgress });
      } catch (err) {
        console.warn(`⚠️ Download tentativa ${attempt} falhou:`, err.message);

        if (attempt === maxRetries) {
          throw new Error(`Falha após ${maxRetries} tentativas: ${err.message}`);
        }

        // Espera exponencial: 1s, 2s, 4s
        const delay = Math.pow(2, attempt - 1) * 1000;
        console.log(`⏳ Aguardando ${delay}ms antes de retry...`);
        await this.sleep(delay);
      }
    }
  }

  /**
   * Download real - tenta Fetch primeiro, HTTPS depois
   * USA ESTRATÉGIA SIMPLES: Buffer de chunks + conversion to stream
   * Evita problemas com piping e stream corruption
   * @private
   */
  async downloadWithStream(videoUrl, { timeout, onProgress } = {}) {
    // Prioritiza fetch (node-fetch é mais confiável)
    try {
      return await this.downloadWithFetchBuffer(videoUrl, { timeout, onProgress });
    } catch (err) {
      console.warn(`   ⚠️ Fetch method failed, trying HTTPS...`);
      return await this.downloadWithHttpsStream(videoUrl, { timeout, onProgress });
    }
  }

  /**
   * Download usando Fetch + coleta em buffer
   * SEGURO: Coleta dados em buffer, depois converte para stream
   * Evita problemas com piping de response direto
   * @private
   */
  async downloadWithFetchBuffer(videoUrl, { timeout, onProgress } = {}) {
    const res = await fetch(videoUrl, {
      timeout: timeout || 60000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const contentLength = parseInt(res.headers.get('content-length'), 10) || 0;
    const chunks = [];
    let downloaded = 0;

    console.log(`   📦 Coletando dados em buffer...`);
    
    // Tenta usar diferentes métodos de leitura dependendo da versão de fetch
    let reader;
    if (res.body && typeof res.body.getReader === 'function') {
      // Node-fetch v3+ com ReadableStream
      reader = res.body.getReader();
    } else if (typeof res.body.on === 'function') {
      // Node-fetch v2 com eventos
      return new Promise((resolve, reject) => {
        res.body.on('data', chunk => {
          chunks.push(chunk);
          downloaded += chunk.length;
          if (onProgress && contentLength > 0) {
            const percent = Math.round((downloaded / contentLength) * 100);
            onProgress({ downloaded, total: contentLength, percent });
          }
        });
        res.body.on('end', () => {
          const buffer = Buffer.concat(chunks);
          console.log(`   ✅ Buffer coletado: ${this.formatBytes(buffer.length)}`);
          const stream = Readable.from(buffer);
          resolve({
            stream,
            size: buffer.length,
            headers: res.headers
          });
        });
        res.body.on('error', reject);
      });
    } else {
      throw new Error('Unable to read response body');
    }

    // Fallback para ReadableStream (Node-fetch v3+)
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) break;

      chunks.push(value);
      downloaded += value.length;

      if (onProgress && contentLength > 0) {
        const percent = Math.round((downloaded / contentLength) * 100);
        onProgress({ downloaded, total: contentLength, percent });
      }
    }

    // Converte chunks para buffer único
    const buffer = Buffer.concat(chunks);
    console.log(`   ✅ Buffer coletado: ${this.formatBytes(buffer.length)}`);

    // Converte buffer para stream (stream readable é confiável)
    const stream = Readable.from(buffer);

    return {
      stream,
      size: buffer.length,
      headers: res.headers
    };
  }

  /**
   * Download usando HTTPS nativo + piping direto
   * Fallback quando fetch falha
   * @private
   */
  async downloadWithHttpsStream(videoUrl, { timeout, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const protocol = videoUrl.startsWith('https') ? https : http;
      let timeoutHandle;

      const makeRequest = (url) => {
        timeoutHandle = setTimeout(() => {
          req.destroy();
          reject(new Error('Download timeout'));
        }, timeout || 60000);

        const req = protocol.get(url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: timeout || 60000
        }, (res) => {
          clearTimeout(timeoutHandle);

          // Segue redirects
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            res.destroy();
            console.log(`   📍 Redirect ${res.statusCode}`);
            makeRequest(res.headers.location);
            return;
          }

          if (res.statusCode !== 200) {
            res.destroy();
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }

          const contentLength = parseInt(res.headers['content-length'], 10) || 0;
          let downloaded = 0;

          res.on('data', (chunk) => {
            downloaded += chunk.length;
            if (onProgress && contentLength > 0) {
              const percent = Math.round((downloaded / contentLength) * 100);
              onProgress({ downloaded, total: contentLength, percent });
            }
          });

          res.on('error', (err) => {
            clearTimeout(timeoutHandle);
            reject(err);
          });

          resolve({
            stream: res,
            size: contentLength,
            headers: res.headers
          });
        });

        req.on('error', (err) => {
          clearTimeout(timeoutHandle);
          reject(err);
        });

        req.on('timeout', () => {
          req.destroy();
          clearTimeout(timeoutHandle);
          reject(new Error('Request timeout'));
        });
      };

      makeRequest(videoUrl);
    });
  }

  /**
   * Formata bytes para string legível
   * @private
   */
  formatBytes(bytes) {
    const sizes = ['B', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Sleep helper
   * @private
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = VideoDownloader;
