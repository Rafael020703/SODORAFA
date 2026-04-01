/**
 * test-puppeteer-extraction.js
 * Testa extração de token via Puppeteer
 */

const clipTokenExtractor = require('./src/clipTokenExtractor');

async function testExtraction() {
  console.log('🧪 Testando extração de token via Puppeteer...\n');
  
  // Teste com um clipe real (se disponível)
  const testClipSlugs = [
    'HotVivaciousSnailCopyThis-bfzeiWEOS4y20tV4'
  ];
  
  for (const slug of testClipSlugs) {
    try {
      console.log(`\n📝 Testando: ${slug}`);
      console.log('⏳ Aguardando Puppeteer carregar página...');
      
      const result = await clipTokenExtractor.extractClipTokenViaHeadless(slug);
      
      console.log(`✅ Sucesso!`);
      console.log(`   URL extraída: ${result.url.substring(0, 80)}...`);
      console.log(`   Válido até: ${new Date(result.expires).toLocaleString()}`);
      console.log(`   Extraído em: ${result.extractedAt}`);
      
    } catch (error) {
      console.error(`❌ Erro: ${error.message}`);
    }
  }
}

testExtraction().then(() => {
  console.log('\n✅ Teste finalizado');
  process.exit(0);
}).catch(err => {
  console.error('❌ Erro no teste:', err);
  process.exit(1);
});
