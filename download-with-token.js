const path = require('path');
require('dotenv').config();

const VideoManager = require('./src/videoManager');
const VideoDownloader = require('./src/videoDownloader');
const config = require('./src/config');

const videoManager = new VideoManager(path.join(__dirname, 'data/videos'));
const videoDownloader = new VideoDownloader(config.TWITCH_CLIENT_ID, config.TWITCH_TOKEN);

// URL COMPLETA com token (extraída do DevTools)
const VIDEO_URL = 'https://production.assets.clips.twitchcdn.net/5Oo6BW383olhDkuMttLVeA/AT-cm%7C5Oo6BW383olhDkuMttLVeA.mp4?token=%7B%22authorization%22%3A%7B%22forbidden%22%3Afalse%2C%22reason%22%3A%22%22%7D%2C%22clip_uri%22%3A%22https%3A%2F%2Fproduction.assets.clips.twitchcdn.net%2F5Oo6BW383olhDkuMttLVeA%2FAT-cm%257C5Oo6BW383olhDkuMttLVeA.mp4%22%2C%22clip_slug%22%3A%22HotVivaciousSnailCopyThis-bfzeiWEOS4y20tV4%22%2C%22device_id%22%3A%2206f351fdccf54aaf9355ad7a79921db3%22%2C%22expires%22%3A1775138503%2C%22user_id%22%3A%22792098619%22%2C%22version%22%3A3%7D&sig=411e9ed3567783a8e2577059c304ba2d458792da';

const CLIP_SLUG = 'HotVivaciousSnailCopyThis-bfzeiWEOS4y20tV4';
const STREAMER = 'rafael020703';

(async () => {
  console.log('\n' + '='.repeat(70));
  console.log('🎬 DOWNLOAD COM URL COMPLETA (TOKEN INCLUÍDO)');
  console.log('='.repeat(70));
  
  try {
    console.log(`\n📊 Informações:`);
    console.log(`   Streamer: ${STREAMER}`);
    console.log(`   Clip: ${CLIP_SLUG}`);
    console.log(`   Tamanho esperado: ~20.3 MB`);
    console.log(`   URL: ${VIDEO_URL.substring(0, 80)}...`);
    
    console.log(`\n⬇️ INICIANDO DOWNLOAD...`);
    console.log(`   Timestamp: ${new Date().toLocaleString('pt-BR')}\n`);
    
    let lastProgress = 0;
    const startTime = Date.now();
    
    const res = await videoDownloader.download(VIDEO_URL, {
      maxRetries: 3,
      timeout: 300000,
      onProgress: (progress) => {
        const percent = Math.round(progress.percent || 0);
        const downloaded = Math.round(progress.downloaded / 1024 / 1024 * 100) / 100;
        const total = Math.round(progress.total / 1024 / 1024 * 100) / 100;
        const speed = progress.speed ? (progress.speed / 1024 / 1024).toFixed(2) : '?';
        
        if (percent >= lastProgress + 5 || percent === 100) {
          console.log(`   [${percent.toString().padStart(3)}%] ${downloaded.toFixed(1)}MB / ${total.toFixed(1)}MB | ${speed}MB/s`);
          lastProgress = percent;
        }
      }
    });
    
    if (!res || !res.stream) {
      throw new Error('Falha ao obter stream de download');
    }
    
    console.log(`\n💾 SALVANDO ARQUIVO...`);
    
    const result = await videoManager.saveVideo(
      CLIP_SLUG,
      STREAMER,
      res.stream,
      {
        title: `${CLIP_SLUG}.mp4`,
        metadata: {
          streamer: STREAMER,
          slug: CLIP_SLUG,
          downloadedAt: new Date().toISOString(),
          extractedVia: 'devtools-token',
          fileSize: res.size,
          downloadTime: Date.now() - startTime
        }
      }
    );
    
    const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
    const avgSpeed = (result.size / 1024 / 1024 / (elapsedSeconds || 1)).toFixed(2);
    
    console.log(`\n${'='.repeat(70)}`);
    console.log('✅ DOWNLOAD CONCLUÍDO COM SUCESSO!');
    console.log('='.repeat(70));
    console.log(`\n📁 Informações do arquivo:`);
    console.log(`   Caminho: ${result.videoPath}`);
    console.log(`   Tamanho: ${videoManager.formatBytes(result.size)}`);
    console.log(`   Tempo: ${elapsedSeconds}s | Velocidade média: ${avgSpeed}MB/s`);
    console.log(`   URL de acesso: /videos/${STREAMER}/${CLIP_SLUG}/clip.mp4`);
    console.log(`\n🎉 Pronto para reproduzir no overlay!\n`);
    
  } catch (err) {
    console.error(`\n❌ ERRO:`, err.message);
    if (err.code) console.error(`   Código: ${err.code}`);
    process.exit(1);
  }
})();
