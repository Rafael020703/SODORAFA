/**
 * videoManager.js - Gerenciador de vídeos baixados localmente
 * Responsabilidades:
 * - Cache local de vídeos (verificar existência)
 * - Salvar novos vídeos com metadata
 * - Limpeza automática de vídeos antigos
 * - Gerenciar espaço em disco
 */

const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');

class VideoManager {
  constructor(baseDir = './data/videos') {
    this.baseDir = baseDir;
    this.initializeDirectory();
  }

  /**
   * Inicializa pasta de vídeos se não existir
   */
  async initializeDirectory() {
    try {
      await fsPromises.mkdir(this.baseDir, { recursive: true });
      console.log(`✅ Diretório de vídeos inicializado: ${this.baseDir}`);
    } catch (err) {
      console.error(`❌ Erro ao inicializar diretório de vídeos:`, err);
    }
  }

  /**
   * Obtém caminho do vídeo se ele existe localmente
   * @param {string} slug - Slug único do clipe
   * @param {string} streamerName - Nome do streamer (username)
   * @returns {Promise<string|null>} - Caminho do vídeo ou null
   */
  async getVideoPath(slug, streamerName) {
    try {
      const dir = path.join(this.baseDir, streamerName, slug);
      const videoPath = path.join(dir, 'clip.mp4');

      if (await this.fileExists(videoPath)) {
        return videoPath;
      }
      return null;
    } catch (err) {
      console.error(`❌ Erro ao verificar vídeo ${streamerName}/${slug}:`, err);
      return null;
    }
  }

  /**
   * Obtém metadata do vídeo
   * @param {string} slug - Slug do clipe
   * @param {string} streamerName - Nome do streamer
   * @returns {Promise<object|null>} - Metadata ou null
   */
  async getVideoMetadata(slug, streamerName) {
    try {
      const metadataPath = path.join(this.baseDir, streamerName, slug, 'metadata.json');

      if (await this.fileExists(metadataPath)) {
        const content = await fsPromises.readFile(metadataPath, 'utf-8');
        return JSON.parse(content);
      }
      return null;
    } catch (err) {
      console.error(`❌ Erro ao ler metadata de ${streamerName}/${slug}:`, err);
      return null;
    }
  }

  /**
   * Salva vídeo e metadata localmente
   * @param {string} slug - Slug único do clipe
   * @param {string} streamerName - Nome do streamer
   * @param {Stream} videoStream - Stream do vídeo
   * @param {object} metadata - Informações do clipe
   * @returns {Promise<object>} - {videoPath, metadataPath, size}
   */
  async saveVideo(slug, streamerName, videoStream, metadata = {}) {
    try {
      const dir = path.join(this.baseDir, streamerName, slug);
      await fsPromises.mkdir(dir, { recursive: true });

      const videoPath = path.join(dir, 'clip.mp4');
      const metadataPath = path.join(dir, 'metadata.json');
      const thumbnailPath = path.join(dir, 'thumbnail.jpg');

      // Escreve vídeo do stream
      let size = 0;
      await new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(videoPath);
        
        videoStream.on('data', (chunk) => {
          size += chunk.length;
        });

        videoStream
          .pipe(writeStream)
          .on('finish', resolve)
          .on('error', (err) => {
            writeStream.destroy();
            reject(err);
          });

        writeStream.on('error', reject);
      });

      // Salva metadata completa
      const fullMetadata = {
        slug,
        streamer: streamerName,
        downloadedAt: new Date().toISOString(),
        size,
        ...metadata
      };

      await fsPromises.writeFile(metadataPath, JSON.stringify(fullMetadata, null, 2));

      console.log(`✅ Vídeo salvo: ${streamerName}/${slug} (${this.formatBytes(size)})`);
      return { videoPath, metadataPath, thumbnailPath, size };
    } catch (err) {
      console.error(`❌ Erro ao salvar vídeo ${streamerName}/${slug}:`, err);
      throw err;
    }
  }

  /**
   * Obtém ou baixa vídeo (com cache automático)
   * @param {string} slug - Slug do clipe
   * @param {string} streamerName - Nome do streamer
   * @param {function} downloadFn - Função callback para baixar se não existe
   * @returns {Promise<string>} - Caminho do vídeo
   */
  async getOrDownload(slug, streamerName, downloadFn) {
    try {
      // Verifica cache local
      const existing = await this.getVideoPath(slug, streamerName);
      if (existing) {
        console.log(`✅ Vídeo encontrado no cache: ${streamerName}/${slug}`);
        return existing;
      }

      // Precisa baixar
      console.log(`📥 Baixando novo vídeo: ${streamerName}/${slug}`);
      const { stream, metadata } = await downloadFn(slug);
      const result = await this.saveVideo(slug, streamerName, stream, metadata);
      return result.videoPath;
    } catch (err) {
      console.error(`❌ Erro em getOrDownload para ${streamerName}/${slug}:`, err);
      throw err;
    }
  }

  /**
   * Remove vídeos antigos (limpeza automática)
   * @param {number} maxAge - Idade máxima em ms (padrão: 7 dias)
   * @returns {Promise<number>} - Quantidade de vídeos removidos
   */
  async cleanupOldVideos(maxAge = 7 * 24 * 60 * 60 * 1000) {
    try {
      const now = Date.now();
      const streamers = await fsPromises.readdir(this.baseDir);
      let removedCount = 0;

      for (const streamer of streamers) {
        const streamerPath = path.join(this.baseDir, streamer);
        const streamerStats = await fsPromises.stat(streamerPath);

        // Pula se for arquivo, não pasta
        if (!streamerStats.isDirectory()) continue;

        const clips = await fsPromises.readdir(streamerPath);

        for (const clipSlug of clips) {
          const clipPath = path.join(streamerPath, clipSlug);
          const clipStats = await fsPromises.stat(clipPath);

          if (now - clipStats.mtimeMs > maxAge) {
            await fsPromises.rm(clipPath, { recursive: true, force: true });
            console.log(`🗑️ Removido vídeo antigo: ${streamer}/${clipSlug}`);
            removedCount++;
          }
        }
      }

      if (removedCount > 0) {
        console.log(`✅ Limpeza concluída: ${removedCount} vídeos removidos`);
      }

      return removedCount;
    } catch (err) {
      console.error(`❌ Erro na limpeza de vídeos antigos:`, err);
      return 0;
    }
  }

  /**
   * Obtém espaço total ocupado por vídeos
   * @returns {Promise<number>} - Tamanho total em bytes
   */
  async getTotalSize() {
    try {
      const streamers = await fsPromises.readdir(this.baseDir);
      let totalSize = 0;

      for (const streamer of streamers) {
        const streamerPath = path.join(this.baseDir, streamer);
        const streamerStats = await fsPromises.stat(streamerPath);

        // Pula se for arquivo, não pasta
        if (!streamerStats.isDirectory()) continue;

        const clips = await fsPromises.readdir(streamerPath);

        for (const clipSlug of clips) {
          const metadata = await this.getVideoMetadata(clipSlug, streamer);
          if (metadata && metadata.size) {
            totalSize += metadata.size;
          }
        }
      }

      return totalSize;
    } catch (err) {
      console.error(`❌ Erro ao calcular tamanho total:`, err);
      return 0;
    }
  }

  /**
   * Força remoção de vídeo específico
   * @param {string} slug - Slug do vídeo
   * @param {string} streamerName - Nome do streamer
   * @returns {Promise<boolean>} - Sucesso
   */
  async deleteVideo(slug, streamerName) {
    try {
      const dir = path.join(this.baseDir, streamerName, slug);
      await fsPromises.rm(dir, { recursive: true, force: true });
      console.log(`🗑️ Vídeo removido: ${streamerName}/${slug}`);
      return true;
    } catch (err) {
      console.error(`❌ Erro ao remover vídeo ${streamerName}/${slug}:`, err);
      return false;
    }
  }

  /**
   * Lista todos os vídeos armazenados (organizado por streamer)
   * @returns {Promise<array>} - Array de vídeos com streamer
   */
  async listVideos() {
    try {
      const streamers = await fsPromises.readdir(this.baseDir);
      const videos = [];

      for (const streamer of streamers) {
        const streamerPath = path.join(this.baseDir, streamer);
        const streamerStats = await fsPromises.stat(streamerPath);

        // Pula se for arquivo, não pasta
        if (!streamerStats.isDirectory()) continue;

        const clips = await fsPromises.readdir(streamerPath);

        for (const clipSlug of clips) {
          const metadata = await this.getVideoMetadata(clipSlug, streamer);
          if (metadata) {
            videos.push({
              streamer,
              slug: clipSlug,
              ...metadata
            });
          }
        }
      }

      return videos;
    } catch (err) {
      console.error(`❌ Erro ao listar vídeos:`, err);
      return [];
    }
  }

  /**
   * Lista todos os clipes baixados
   * @returns {Promise<array>} - Array com todos os clipes
   */
  async getAllClips() {
    try {
      const allClips = [];
      const streamers = await fsPromises.readdir(this.baseDir);

      for (const streamer of streamers) {
        const streamerPath = path.join(this.baseDir, streamer);
        const streamerStats = await fsPromises.stat(streamerPath);
        
        if (!streamerStats.isDirectory()) continue;

        const clips = await fsPromises.readdir(streamerPath);

        for (const clip of clips) {
          const clipPath = path.join(streamerPath, clip);
          const clipStats = await fsPromises.stat(clipPath);
          
          if (!clipStats.isDirectory()) continue;

          const videoPath = path.join(clipPath, 'clip.mp4');
          const metadataPath = path.join(clipPath, 'metadata.json');

          if (await this.fileExists(videoPath)) {
            let metadata = { slug: clip, streamer };
            
            // Tenta ler metadata se existir
            if (await this.fileExists(metadataPath)) {
              try {
                const content = await fsPromises.readFile(metadataPath, 'utf-8');
                metadata = JSON.parse(content);
              } catch (err) {
                console.warn(`⚠️ Erro ao ler metadata de ${streamer}/${clip}`);
              }
            }

            // Adiciona informações de arquivo
            const stats = await fsPromises.stat(videoPath);
            allClips.push({
              slug: clip,
              streamer,
              size: stats.size,
              downloadedAt: metadata.downloadedAt || stats.mtime.toISOString(),
              title: metadata.title || clip,
              duration: metadata.duration || null
            });
          }
        }
      }

      return allClips;
    } catch (err) {
      console.error(`❌ Erro ao listar clipes:`, err);
      return [];
    }
  }

  /**
   * Deleta um clipe e sua pasta
   * @param {string} slug - Slug do clipe
   * @param {string} streamerName - Nome do streamer
   * @returns {Promise<boolean>} - true se deletado, false se não encontrado
   */
  async deleteVideo(slug, streamerName) {
    try {
      const dir = path.join(this.baseDir, streamerName, slug);
      
      // Verifica se folder exists
      const exists = await this.fileExists(dir);
      if (!exists) {
        console.warn(`⚠️ Clipe não encontrado: ${streamerName}/${slug}`);
        return false;
      }

      // Deleta recursivamente
      const files = await fsPromises.readdir(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stats = await fsPromises.stat(filePath);
        
        if (stats.isDirectory()) {
          // Se houver subpastas, deleta recursivamente
          await this.deleteVideoDirRecursive(filePath);
        } else {
          await fsPromises.unlink(filePath);
        }
      }

      // Deleta pasta vazia
      await fsPromises.rmdir(dir);
      
      console.log(`✅ Clipe deletado: ${streamerName}/${slug}`);
      return true;
    } catch (err) {
      console.error(`❌ Erro ao deletar clipe ${streamerName}/${slug}:`, err);
      return false;
    }
  }

  /**
   * Deleta diretório recursivamente
   * @private
   */
  async deleteVideoDirRecursive(dirPath) {
    try {
      const files = await fsPromises.readdir(dirPath);
      
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stats = await fsPromises.stat(filePath);
        
        if (stats.isDirectory()) {
          await this.deleteVideoDirRecursive(filePath);
        } else {
          await fsPromises.unlink(filePath);
        }
      }
      
      await fsPromises.rmdir(dirPath);
    } catch (err) {
      console.error(`❌ Erro ao deletar recursivamente:`, err);
      throw err;
    }
  }

  /**
   * Converte bytes para formato legível
   * @param {number} bytes - Quantidade em bytes
   * @returns {string} - Formato legível
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Verifica se arquivo existe
   * @private
   */
  async fileExists(filePath) {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = VideoManager;
