/**
 * clipTokenExtractor.js
 * Extrai automaticamente tokens JWT de clipes Twitch
 * 
 * Estratégias (em ordem):
 * 1. Busca HTML da página e extrai URL do link de download
 * 2. Fallback: Puppeteer (se disponível)
 * 3. Fallback final: Solicita token manual
 */

const fetch = require('node-fetch').default || require('node-fetch');
const puppeteer = require('puppeteer');
const https = require('https');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

/**
 * Cache de tokens para reutilização (válidos por 6h)
 */
const tokenCache = {};

/**
 * Extrai URL do clipe diretamente do HTML da página
 * MÉTODO MAIS RÁPIDO E CONFIÁVEL!
 * @param {string} clipSlug - Slug do clipe
 * @returns {Promise<string>} URL com token
 */
async function extractUrlViaHtmlParsing(clipSlug) {
  try {
    console.log(`[HTML Parser] Buscando página do clipe...`);
    
    const clipUrl = `https://www.twitch.tv/user/clip/${clipSlug}`;
    const response = await fetch(clipUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 30000
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    
    // Procurar por URL no href do link de download
    // Padrão: href="https://production.assets.clips.twitchcdn.net/...mp4?...sig=...&token=..."
    const urlRegex = /href="(https:\/\/production\.assets\.clips\.twitchcdn\.net[^"]*\.mp4[^"]*)"/g;
    const match = urlRegex.exec(html);
    
    if (match && match[1]) {
      const extractedUrl = match[1];
      
      // Decodificar HTML entities (&amp; → &, etc)
      const decodedUrl = extractedUrl
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
      
      console.log(`[HTML Parser] ✅ URL extraída do HTML com sucesso!`);
      return decodedUrl;
    }

    throw new Error('URL não encontrada no HTML');

  } catch (error) {
    console.log(`[HTML Parser] ⚠️ Parser HTML falhou: ${error.message}`);
    return null;
  }
}

/**
 * Extrai URL do clipe com token JWT do Twitch
 * Tenta múltiplos métodos automaticamente
 * @param {string} clipSlug - Slug do clipe (ex: HotVivaciousSnailCopyThis-bfzeiWEOS4y20tV4)
 * @returns {Promise<{url: string, expires: number}>} URL com token + timestamp expiração
 */
async function extractClipTokenViaHeadless(clipSlug) {
  console.log(`[Token Extractor] Processando clipe: ${clipSlug}`);
  
  // MÉTODO 1: Puppeteer (NECESSÁRIO porque o MP4 link é renderizado dinamicamente via JavaScript)
  let browser;
  try {
    console.log(`[Token Extractor] Tentando Puppeteer...`);
    
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
      ],
      timeout: 30000
    });

    const page = await browser.newPage();
    
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    );

    let clipDownloadUrl = null;
    
    // Capturar respostas de rede para encontrar o MP4
    page.on('response', async (response) => {
      try {
        const url = response.url();
        if (url.includes('production.assets.clips.twitchcdn.net') && url.includes('.mp4')) {
          clipDownloadUrl = url;
          console.log(`[Token Extractor] ✅ Token extraído via Playwright!`);
        }
      } catch (e) {
        // Ignorar erros
      }
    });

    const clipUrl = `https://www.twitch.tv/user/clip/${clipSlug}`;
    
    try {
      await page.goto(clipUrl, {
        waitUntil: 'networkidle2',
        timeout: 45000
      });
    } catch (e) {
      console.log(`[Token Extractor] ⚠️ Timeout Puppeteer (pode estar OK)`);
    }

    if (!clipDownloadUrl) {
      const htmlContent = await page.content();
      const videoMatch = htmlContent.match(/https:\/\/production\.assets\.clips\.twitchcdn\.net[^"'<>]*\.mp4[^"'<>]*/);
      if (videoMatch) {
        clipDownloadUrl = videoMatch[0];
      }
    }

    await page.close();

    if (clipDownloadUrl) {
      const expiresAt = Date.now() + (6 * 60 * 60 * 1000);
      return {
        url: clipDownloadUrl,
        expires: expiresAt,
        extractedAt: new Date().toISOString(),
        method: 'puppeteer'
      };
    }

  } catch (error) {
    console.log(`[Token Extractor] ⚠️ Puppeteer falhou: ${error.message}`);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        // Ignorar
      }
    }
  }

  // MÉTODO 2: Fallback para HTML Parsing
  try {
    console.log(`[Token Extractor] Tentando HTML Parser como fallback...`);
    const htmlUrl = await extractUrlViaHtmlParsing(clipSlug);
    if (htmlUrl) {
      const expiresAt = Date.now() + (6 * 60 * 60 * 1000);
      console.log(`[Token Extractor] ✅ Token extraído via HTML Parser!`);
      return {
        url: htmlUrl,
        expires: expiresAt,
        extractedAt: new Date().toISOString(),
        method: 'html-parser'
      };
    }
  } catch (e) {
    console.log(`[Token Extractor] HTML Parser também falhou: ${e.message}`);
  }

  // MÉTODO 3: Fallback - Solicitar token manual
  console.log(`[Token Extractor] Usando fallback manual...\n`);
  return await extractClipTokenViaManualFallback(clipSlug);
}

/**
 * Fallback: Solicita token manualmente via interface interativa
 * @param {string} clipSlug - Slug do clipe
 * @returns {Promise<{url: string, expires: number}>}
 */
async function extractClipTokenViaManualFallback(clipSlug) {
  // Se já temos um token em cache válido, usa
  const now = Date.now();
  for (const [slug, tokenData] of Object.entries(tokenCache)) {
    if (tokenData.expires > now) {
      console.log(`\n[Token Cache] ✅ Usando token em cache válido até ${new Date(tokenData.expires).toLocaleTimeString()}`);
      return {
        url: tokenData.url,
        expires: tokenData.expires,
        extractedAt: new Date().toISOString(),
        method: 'cached'
      };
    }
  }

  console.log(`\n╔════════════════════════════════════════════════════════════╗`);
  console.log(`║          TOKEN MANUAL - EXTRAÇÃO NECESSÁRIA               ║`);
  console.log(`╚════════════════════════════════════════════════════════════╝`);
  console.log(`\n[⚠️] Métodos automáticos não funcionaram neste ambiente.`);
  console.log(`[💡] Você precisa extrair o token manualmente (10 segundos).\n`);
  console.log(`INSTRUÇÕES:`);
  console.log(`  1. Abra: https://www.twitch.tv/user/clip/${clipSlug}`);
  console.log(`  2. Pressione F12 (DevTools)`);
  console.log(`  3. Vá à aba "Network"`);
  console.log(`  4. Procure por: production.assets.clips.twitchcdn.net...mp4`);
  console.log(`  5. Clique na requisição e copie A URL COMPLETA (com token e sig)\n`);
  console.log(`[ℹ️] Este token é VÁLIDO POR 6 HORAS e pode ser reutilizado.\n`);
  
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('[PASTE] Cole a URL completa aqui:\n> ', (urlInput) => {
      rl.close();
      
      if (!urlInput || !urlInput.includes('.mp4')) {
        reject(new Error('URL inválida. Deve conter .mp4'));
        return;
      }
      
      if (!urlInput.includes('token=') || !urlInput.includes('sig=')) {
        reject(new Error('URL não contém token ou signature'));
        return;
      }

      const expiresAt = Date.now() + (6 * 60 * 60 * 1000);
      tokenCache[clipSlug] = {
        url: urlInput,
        expires: expiresAt
      };

      console.log(`\n✅ Token armazenado em cache\n`);
      
      resolve({
        url: urlInput,
        expires: expiresAt,
        extractedAt: new Date().toISOString(),
        method: 'manual-fallback'
      });
    });
  });
}

/**
 * Faz download do clipe usando URL com token
 * @param {string} url - URL do clipe com token
 * @param {string} outputPath - Caminho completo do arquivo de saída
 * @returns {Promise<{success: boolean, size: number}>}
 */
async function downloadClipWithToken(url, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`[Download] Iniciando: ${path.basename(outputPath)}`);
    
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const file = fs.createWriteStream(outputPath);
    let downloadedBytes = 0;

    https.get(url, (response) => {
      const totalBytes = parseInt(response.headers['content-length'], 10);

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        const percent = ((downloadedBytes / totalBytes) * 100).toFixed(1);
        process.stdout.write(`\r[Download] ${percent}% (${(downloadedBytes / 1024 / 1024).toFixed(2)} MB)`);
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        console.log(`\n[Download] ✅ Concluído! (${(downloadedBytes / 1024 / 1024).toFixed(2)} MB)`);
        resolve({
          success: true,
          size: downloadedBytes,
          path: outputPath
        });
      });
    }).on('error', (err) => {
      fs.unlink(outputPath, () => {});
      console.error(`\n[Download] ❌ Erro: ${err.message}`);
      reject(err);
    });

    file.on('error', (err) => {
      fs.unlink(outputPath, () => {});
      reject(err);
    });
  });
}

/**
 * Busca todos os clipes de um canal via Twitch API
 * @param {string} broadcasterId - ID do canal na Twitch
 * @returns {Promise<Array>} Lista de clipes
 */
async function getAllClipsFromChannel(broadcasterId) {
  const token = process.env.TWITCH_ACCESS_TOKEN;
  if (!token) {
    throw new Error('TWITCH_ACCESS_TOKEN não definido');
  }

  const options = {
    method: 'GET',
    hostname: 'api.twitch.tv',
    path: `/helix/clips?broadcaster_id=${broadcasterId}&first=100`,
    headers: {
      'Client-ID': process.env.TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${token}`
    }
  };

  return new Promise((resolve, reject) => {
    https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode === 200) {
            resolve(json.data || []);
          } else {
            reject(new Error(`API Error: ${json.error || res.statusCode}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject).end();
  });
}

module.exports = {
  extractClipTokenViaHeadless,
  downloadClipWithToken,
  getAllClipsFromChannel
};
