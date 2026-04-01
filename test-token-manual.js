const cli = require('./src/clipTokenExtractor');

// Teste manual - simula o user colocando um token válido
// Você pode colar aqui um token recente de um clipe
const testClip = async () => {
  console.log('🔍 Teste de download com token manual');
  console.log('====================================\n');
  
  // Teste 1: Tenta extrair pelo clipe
  const clipSlug = 'RockyPeacefulNostrilBabyRage-7dsOMou1B_bFk7Su';
  
  try {
    console.log('Uma janela DevTools será pedida se necessário.');
    console.log('Você pode pegar um token válido de qualquer clipe recente.\n');
    
    const result = await cli.extractClipTokenViaHeadless(clipSlug);
    
    if (result && result.url) {
      console.log('✅ Token extraído com sucesso!');
      console.log(`📹 URL do clipe: ${result.url}\n`);
      
      // Testa download
      const outputPath = `/workspaces/SODORAFA/data/videos/manual-test-${Date.now()}.mp4`;
      console.log(`⬇️  Iniciando download para: ${outputPath}\n`);
      
      await cli.downloadClipWithToken(result.url, outputPath);
      console.log('✅ Download concluído!');
    }
  } catch (error) {
    console.error('❌ Erro:', error.message);
  }
};

testClip();
