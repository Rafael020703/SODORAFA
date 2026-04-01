#!/usr/bin/env node
/**
 * test-clip-download.js
 * Script interativo para testar download de clipes
 * 
 * Uso: node test-clip-download.js
 * Depois coloque o link ou slug do clipe
 */

const readline = require('readline');
const path = require('path');
const fs = require('fs');
const clipTokenExtractor = require('./src/clipTokenExtractor');
const VideoManager = require('./src/videoManager');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const videoManager = new VideoManager(path.join(__dirname, 'data/videos'));

function extractSlugFromUrl(input) {
  // Se for uma URL, extrai o slug
  try {
    const url = new URL(input);
    if (url.hostname.includes('clips.twitch.tv')) {
      return url.pathname.slice(1); // Remove a barra inicial
    }
    if (url.hostname.includes('twitch.tv') && url.pathname.includes('/clip/')) {
      return url.pathname.split('/clip/')[1];
    }
  } catch (e) {
    // Não é URL, assume que é slug direto
  }
  return input.trim();
}

async function testDownload() {
  console.log('\n🎬 ════════════════════════════════════════');
  console.log('🎬 Testador de Download de Clipes Twitch 🎬');
  console.log('🎬 ════════════════════════════════════════\n');
  console.log('Cole o link do clipe ou o slug e pressione Enter');
  console.log('Ex: HotVivaciousSnailCopyThis-bfzeiWEOS4y20tV4');
  console.log('Ex: https://clips.twitch.tv/HotVivaciousSnailCopyThis-bfzeiWEOS4y20tV4');
  console.log('Ex: sair (para encerrar)\n');

  const promptUser = () => {
    rl.question('\n📥 Cole o link/slug do clipe: ', async (input) => {
      try {
        if (input.toLowerCase() === 'sair' || input.toLowerCase() === 'exit') {
          console.log('\n👋 Até logo!\n');
          rl.close();
          return;
        }

        if (!input.trim()) {
          console.log('⚠️  Por favor, insira um link ou slug válido');
          promptUser();
          return;
        }

        const clipSlug = extractSlugFromUrl(input);
        console.log(`\n🔍 Slug do clipe: ${clipSlug}`);
        console.log('⏳ Tentando extrair token...\n');

        // Extrair token
        const tokenData = await clipTokenExtractor.extractClipTokenViaHeadless(clipSlug);
        
        if (!tokenData || !tokenData.url) {
          console.log('❌ Erro: Não foi possível extrair o token do clipe');
          promptUser();
          return;
        }

        console.log(`✅ Token extraído com sucesso!`);
        console.log(`   Método: ${tokenData.method}`);
        console.log(`   URL: ${tokenData.url.substring(0, 80)}...`);
        console.log(`   Válido até: ${new Date(tokenData.expires).toLocaleString()}\n`);

        // Fazer download
        console.log('⏳ Baixando clipe...\n');
        
        const outputPath = path.join(__dirname, 'data/videos', 'test-download', `${clipSlug}.mp4`);
        
        const result = await clipTokenExtractor.downloadClipWithToken(tokenData.url, outputPath);

        if (result.success) {
          console.log(`\n✅ Clipe baixado com sucesso!`);
          console.log(`   Arquivo: ${result.path}`);
          console.log(`   Tamanho: ${(result.size / 1024 / 1024).toFixed(2)} MB\n`);
        } else {
          console.log(`\n❌ Erro ao baixar: ${result.error}`);
        }

        promptUser();
      } catch (error) {
        console.error(`\n❌ Erro: ${error.message}`);
        console.error(error.stack);
        promptUser();
      }
    });
  };

  promptUser();
}

// Iniciar
testDownload().catch(err => {
  console.error('❌ Erro fatal:', err);
  process.exit(1);
});
