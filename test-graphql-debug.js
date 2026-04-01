const fetch = require('node-fetch').default || require('node-fetch');

async function testGraphQL() {
  const clipSlug = 'RockyPeacefulNostrilBabyRage-7dsOMou1B_bFk7Su';
  
  const query = `query { clip(slug: "${clipSlug}") { videoQualities { sourceURL } } }`;

  console.log('📡 Testando GraphQL...');
  console.log(`Query: ${query}\n`);

  try {
    const response = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: {
        'Client-ID': 'hsziksnh5mqsq2kvpqfp3m8x42up82',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query })
    });

    console.log(`Status: ${response.status}`);
    const text = await response.text();
    console.log(`Response: ${text.substring(0, 200)}`);
    
    try {
      const data = JSON.parse(text);
      console.log(JSON.stringify(data, null, 2));
    } catch(e) {
      console.log('Não é JSON');
    }
  } catch (error) {
    console.log(`Error: ${error.message}`);
  }
}

testGraphQL();
