const path = require('path');
require('dotenv').config();

const VideoManager = require('./src/videoManager');
const videoManager = new VideoManager(path.join(__dirname, 'data/videos'));

(async () => {
  try {
    console.log('\n' + '='.repeat(70));
    console.log('🔍 TESTANDO BUSCA DE CLIPES');
    console.log('='.repeat(70));
    
    // Lista todos os clipes
    console.log(`\n📋 Listando todos os clipes...`);
    const allClips = await videoManager.getAllClips();
    console.log(`   ✅ Total: ${allClips.length} clipe(s)`);
    
    allClips.forEach(clip => {
      console.log(`\n   📹 ${clip.slug}`);
      console.log(`      Streamer: ${clip.streamer}`);
      console.log(`      Tamanho: ${videoManager.formatBytes(clip.size)}`);
      console.log(`      Baixado: ${clip.downloadedAt}`);
    });
    
    // Busca clipes específicos do usuario
    console.log(`\n\n🎯 Buscando clipes de: rafael020703`);
    const userClips = allClips.filter(c => c.streamer === 'rafael020703');
    console.log(`   ✅ Encontrados: ${userClips.length} clipe(s)`);
    
    userClips.forEach(clip => {
      console.log(`   ✨ ${clip.slug} - ${videoManager.formatBytes(clip.size)}`);
    });
    
    if (userClips.length > 0) {
      console.log(`\n✅ Pronto para usar comando: !so rafael020703`);
      console.log(`   Será reproduzido: ${userClips[0].slug}`);
      console.log(`   URL de acesso: /videos/rafael020703/${userClips[0].slug}/clip.mp4`);
    } else {
      console.log(`   ⚠️ Nenhum clipe encontrado`);
    }
    
    console.log('\n' + '='.repeat(70) + '\n');
    
  } catch (err) {
    console.error('❌ Erro:', err.message);
  }
})();
