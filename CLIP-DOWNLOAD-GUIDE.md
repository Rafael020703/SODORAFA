# 🎬 Sistema de Download e Reprodução de Clipes

## 📋 Visão Geral

O sistema foi simplificado para usar **apenas download direto via HTTPS** com tokens extraídos manualmente do DevTools da Twitch.

### Método de Download
- ✅ **HTTPS direto** (nativo do Node.js)
- ❌ ~~GraphQL (HTTP 400)~~
- ❌ ~~Puppeteer (sem dependências do sistema)~~
- ❌ ~~HTML Parsing (conteúdo dinâmico)~~

---

## 🚀 Como Usar

### 1️⃣ Download Manual de Clipes

**Passo 1: Extrair Token do DevTools**

Abra https://www.twitch.tv/USERNAME/clip/CLIP-SLUG no seu navegador e:

1. Pressione `F12` para abrir DevTools
2. Vá para a aba **Network**
3. Procure por requisições para `production.assets.clips.twitchcdn.net`
4. Clique em uma requisição que termina em `.mp4`
5. Copie a URL completa da coluna **Request URL**

**Exemplo de URL:**
```
https://production.assets.clips.twitchcdn.net/5Oo6BW383olhDkuMttLVeA/AT-cm%7C5Oo6BW383olhDkuMttLVeA.mp4?token={...}&sig={...}
```

**Passo 2: Fazer Download**

```bash
node download-with-token.js
```

O script pedirá a URL e baixará o clipe automaticamente.

### 2️⃣ Comandos no Chat

#### `!so @username` ou `!so username`

Procura clipes locais do usuário e reproduz um aleatoriamente.

```
Rafael: !so joão
Bot: 🎬 Procurando clipes de joão...
     ✅ Encontrados 3 clipe(s)
     📺 Clip selecionado: SomeAwesomeClip-abc123
     [Overlay exibe o clipe]
```

**Se nenhum clipe local for encontrado:**
```
Bot: ⚠️ Nenhum clip encontrado para joão
     💡 Dica: Use 'node download-with-token.js' para baixar clipes
```

#### `!repeat @username` ou `!repeat username`

Ativa modo de reprodução contínua de clipes aleatórios do usuário.

```
Rafael: !repeat joão
Bot: 🔁 Repeat ativado para joão! Clipes aleatórios em loop.
     [Inicia primeiro clipe]
     [Quando termina, automaticamente busca o próximo]
```

**Para desativar:**
```
Rafael: !repeat joão
Bot: 🔁 Repeat desativado
```

---

## 📁 Estrutura de Pastas

Clipes são organizados assim:

```
/data/videos/
├── rafael020703/
│   └── HotVivaciousSnailCopyThis-bfzeiWEOS4y20tV4/
│       ├── clip.mp4 (20.28 MB)
│       └── metadata.json
│
├── joao/
│   └── SomeAwesomeClip-xyz789/
│       ├── clip.mp4
│       └── metadata.json
```

---

## 🔍 Gerenciar Clipes

### Ver Clipes Disponíveis

```bash
node test-so-command.js
```

Mostra:
- ✅ Total de clipes baixados
- 📹 Clipes por streamer
- 💾 Tamanho de cada clipe

### Deletar Clipes

Via API HTTP:
```bash
curl -X POST http://localhost:3000/api/clips-delete \
  -H "Content-Type: application/json" \
  -d '{
    "clip_slug": "HotVivaciousSnailCopyThis-bfzeiWEOS4y20tV4",
    "streamer": "rafael020703"
  }'
```

Via Web UI:
- Acesse `/public/clips-manager.html`
- Clique no botão delete de cada clipe

---

## ⚡ Fluxo Automático

### Quando alguém digita `!so joão`:

1. **Bot procura** → Busca clipes de "joão" em `/data/videos/joao/`
2. **Bot seleciona** → Escolhe um aleatoriamente (não repetido)
3. **Bot enfileira** → Adiciona à fila de reprodução
4. **Overlay recebe** → Socket.IO envia dados do clipe
5. **Clipe reproduz** → Overlay exibe o vídeo

### Quando clipe termina (evento `clipFinalizado`):

|  | **Repeat OFF** | **Repeat ON** |
|---|---|---|
| Próximo na fila? | Reproduz | Procura clipe aleatório do mesmo user e reproduz |
| Sem elementos? | Para | Busca clipe aleatório |

---

## 🛠️ Arquivos Principais

### 📄 `download-with-token.js`
Script para fazer download manual de clipes com token.

**Uso:**
```bash
node download-with-token.js "URL_COMPLETA_COM_TOKEN"
```

### 📄 `index.js` - Funções principais

- `queueUserClip(channel, username)` - Procura e enfileira clipe
- `playNext(channel)` - Reproduz próximo da fila
- Socket listener `clipFinalizado` - Trata fim do clipe

### 📁 `src/videoManager.js`

- `getAllClips()` - Lista todos os clipes
- `saveVideo()` - Salva novo clipe
- `deleteVideo()` - Remove clipe

### 📁 `src/twitchApi.js`

- `getAllUserClips(userId)` - Busca clipes de usuário (API Helix)
- `getUserData(username)` - Resolve username para ID

---

## ⚙️ Configurações

### Maximum History (MAX_HISTORY)

Quantos clipes podem ser marcados como "já reproduzido" antes de resetar:

```js
const MAX_HISTORY = 50;
```

Se houver menos de 50 clipes, esse valor é irrelevante.

### Timeout de Reprodução

Tempo máximo para reproduzir um clipe:

```js
duration: 15 // segundos
```

---

## 🐛 Troubleshooting

**Problema:** Comando `!so` não funciona
- ✅ Verifique se clipes estão em `/data/videos/username/`
- ✅ Verifique permissões de comando no `channelsConfigs.json`

**Problema:** Clipe não baixa
- ✅ URL expirou (tokens válidos por ~6 horas)
- ✅ Extraia novo token do DevTools

**Problema:** "Nenhum clip encontrado"
- ✅ Não há clips locais salvos
- ✅ Use `node download-with-token.js` para baixar

---

## 📊 Monitoramento

Ver logs em tempo real:

```bash
# Terminal 1: Inicia servidor
node index.js

# Terminal 2: Monitora logs
tail -f server.log
```

---

## 🎯 Próximas Melhorias

- [ ] Auto-download quando alguem pede `!so` e nenhum clips existe
- [ ] Interface web para extrair token automaticamente  
- [ ] Suporte a múltiplos tokens para refresh automático
- [ ] Ranking de clipes mais reproduzidos
- [ ] Integração com Discord para notificar downloads
