const fetch = require('node-fetch').default || require('node-fetch');

async function testGraphQL() {
  const clipSlug = 'RockyPeacefulNostrilBabyRage-7dsOMou1B_bFk7Su';
  
  const query = `
    query {
      clip(slug: "${clipSlug}") {
        videoQualities {
          frameRate
          quality
          sourceURL
        }
      }
    }
  `;

  console.log('📡 Testando GraphQL da Twitch...');
  console.log(`🎬 Slug: ${clipSlug}\n`);

  try {
    const response = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: {
        'Client-ID': 'hsziksnh5mqsq2kvpqfp3m8x42up82',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query }),
      timeout: 15000
    });

    console.log(`📊 Status HTTP: ${response.status}`);

    const data = await response.json();
    
    if (data.errors) {
      console.log('❌ GraphQL Error:', data.errors[0].message);
      return;
    }

    const clip = data.data?.clip;
    if (!clip) {
      console.log('❌ Clip não encontrado');
      return;
    }

    if (clip.videoQualities && clip.videoQualities.length > 0) {
      console.log('✅ Clip encontrado!');
      console.log(`📹 Qualidades: ${clip.videoQualities.length}`);
      
      clip.videoQualities.forEach((q, i) => {
        console.log(`  [${i}] ${q.quality}p @ ${q.frameRate}fps`);
        if (i === 0 && q.sourceURL) {
          console.log(`      URL válida: ${q.sourceURL.includes('.mp4') ? '✅' : '❌'}`);
        }
      });
    }
  } catch (error) {
    console.log(`❌ Erro: ${error.message}`);
  }
}

testGraphQL();
