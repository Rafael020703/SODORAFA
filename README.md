# SODORAFA - Sistema de Overlay & Monitoramento para Twitch

Um sistema completo de overlay, bot de chat, monitoramento de streamers e integração Discord com autenticação OAuth, dashboard moderno e painel administrativo.

## 🎯 Funcionalidades Principais

### 🏠 Home Page Moderna (SaaS)
- Landing page profissional com estatísticas em tempo real
- 4 Cards mostrando: Usuários, Streamers Monitorados, Webhooks Ativos, Monitoramentos
- Features showcase com 6 cards de benefícios
- Design responsivo com glassmorphism
- Auto-refresh de dados a cada 30 segundos

### 🎨 Dashboard Moderno
- Interface intuitiva com design glassmorphic
- Configuração de comandos por canal
- Métricas em tempo real
- Suporte para múltiplos canais
- Navegação consistente em todas as páginas

### ▶️ Overlay de Clipes
- Reprodução de clipes em tempo real durante transmissão
- Animações suaves com feedback visual
- Sincronização com chat via Socket.io
- Link copiável para adicionar à OBS/StreamLabs

### 💬 Bot de Chat
Comandos automáticos configuráveis:
- **!watch [url]** - Reproduzir clipe específico
- **!replay** - Repetir último clipe reproduzido
- **!repeat @user** - Modo repeat com clipes do usuário
- **!so @creator** - Shoutout com clipes do criador
- **!stop** - Para a reprodução
- **!clip** - Cria novo clipe do momento

### 📺 Monitoramento de Streamers
- Monitor múltiplos streamers
- Notificações automáticas quando streamers entram ao vivo
- Integração com Discord webhooks
- Dashboard dedicado para gerenciar streamers

### 🔗 Integração Discord
- OAuth flow completo
- Webhooks automáticos para notificações
- Vinculação de conta Discord ao perfil
- Teste de webhook e status

### 👤 Perfil de Usuário
- Informações do usuário Twitch
- Integração com Discord
- Configurações de conta e notificações
- Logout seguro (botão no perfil, não no header global)

### 🔐 Segurança
- Autenticação via Twitch OAuth
- Autenticação Discord opcional
- Sistema de permissões por role (broadcaster, moderator, vip, subscriber, viewer)
- Painel admin protegido com JWT
- Validação de entrada em todos os endpoints
- Sessions persistentes em arquivo

### 📊 Painel Administrativo
- Gerenciamento de canais
- Visualização de métricas globais
- Reset de estatísticas
- Monitoramento em tempo real

### 🔌 API Pública
- `GET /api/stats` - Estatísticas globais
- `GET /api/config` - Configuração pública
- `GET /api/public/clips/:channel` - Consultar clipes
- Cache servidor para melhor performance

## 🌴 Arquitetura - 2 Projetos Distintos

### 📺 Projeto 1: OVERLAY (Transmissão)
**Rota:** `/`, `/overlay`, `/autoclipes`, `/dashboard`

**Propósito:** Gerenciar overlays, clipes e comandos durante a transmissão

**Componentes:**
- Dashboard de controle
- Player de overlay
- Bot de chat
- Métricas e analytics

### 🤖 Projeto 2: MONITORING (Notificações)
**Rota:** `/profile`, `/monitoring`, `/api/streamers`

**Propósito:** Monitorar streamers e enviar notificações no Discord

**Componentes:**
- Perfil do usuário
- Página de monitoramento
- Gerenciamento de streamers
- Integração Discord

---

## 🚀 Como Começar

### Pré-requisitos
- Node.js 14+
- npm ou yarn
- Conta Twitch para configurar credenciais
- (Opcional) Conta Discord para webhooks

### Instalação

### 1. Configuração de Credenciais Twitch

Acesse [Twitch Developer Console](https://dev.twitch.tv/console/apps) e crie uma nova aplicação.

Você precisará:
- **Client ID** - ID da sua aplicação
- **Client Secret** - Chave secreta
- **OAuth Token** - Token do bot (para a conta do bot)

### 2. Arquivo .env

Crie um arquivo `.env` na raiz do projeto:

```env
# Twitch OAuth
TWITCH_CLIENT_ID=seu_client_id_aqui
TWITCH_CLIENT_SECRET=seu_client_secret_aqui
CALLBACK_URL=http://localhost:3000/auth/twitch/callback

# Sessão
SESSION_SECRET=sua_chave_secreta_aqui

# Admin Panel
ADMIN_USER=admin
ADMIN_PASS=senha_segura_aqui
ADMIN_JWT_SECRET=jwt_secret_aqui

# Bot
BOT_USERNAME=seu_bot_username
BOT_OAUTH_TOKEN=oauth:seu_bot_token_aqui

# Servidor
PORT=3000
```

### 3. Instalação e Execução

```bash
# Instalar dependências
npm install

# Iniciar em DESENVOLVIMENTO com nodemon (auto-reload)
npm run dev

# Iniciar em PRODUÇÃO
npm start

# O servidor estará disponível em http://localhost:3000
```

### Endpoints Principais

#### 🏠 Páginas Públicas
- `GET /home` - Homepage com estatísticas

#### 🔐 Autenticação
- `GET /auth/twitch` - Iniciar login Twitch
- `GET /auth/twitch/callback` - Callback da autenticação
- `GET /logout` - Fazer logout

#### 📊 Páginas Autenticadas
- `GET /dashboard` - Dashboard principal (overlay/bot)
- `GET /profile` - Perfil e integração Discord
- `GET /monitoring` - Monitoramento de streamers

#### 🔌 API Pública
- `GET /api/stats` - Estatísticas globais
- `GET /api/config` - Configuração pública

#### 🔌 API Autenticada
- `GET /api/profile` - Dados do perfil
- `PUT /api/profile` - Atualizar perfil
- `POST /api/profile/webhook` - Configurar webhook Discord
- `GET /api/streamers` - Lista de streamers
- `POST /api/streamers` - Adicionar streamer
- `DELETE /api/streamers/:id` - Remover streamer

---

## 📁 Estrutura do Projeto

```
SODORAFA/
├── index.js                      # Servidor Express principal
├── package.json                  # Dependências + scripts
├── .env                          # Variáveis de ambiente
├── channelsConfigs.json          # Configurações de canais
├── IMPLEMENTATION_SUMMARY.md     # Resumo de implementações
├── NAVIGATION_GUIDE.md           # Guia de navegação
├── README.md                     # Este arquivo
├── src/
│   ├── config.js                # Configurações
│   ├── state.js                 # Gerenciamento de estado
│   ├── persistence.js           # Salvamento em JSON
│   ├── sessionStore.js          # Session management
│   ├── bot.js                   # Bot TMI.js
│   ├── twitchApi.js             # Integração Twitch API
│   ├── discordApi.js            # Integração Discord
│   └── utils.js                 # Utilitários
│   └── sessionStore.js    # Armazenamento de sessões
├── public/
│   ├── home.html          # Página inicial
│   ├── index.html         # Dashboard principal
│   ├── admin.html         # Painel administrativo
│   ├── overlay.html       # Overlay de clipes
│   ├── autoclipes.html    # Auto reprodução de clipes
│   └── sounds/            # Arquivos de áudio
└── sessions/              # Sessões persistentes

```

## 🎮 Como Usar

### 1. Primeiro Acesso

1. Acesse `http://localhost:3000`
2. Clique em "Começar Agora"
3. Faça login com sua conta Twitch
4. Será redirecionado ao dashboard

### 2. Configurar Comandos

No dashboard:
1. Ative os comandos que deseja usar
2. Selecione quais roles podem usar cada comando
3. Clique em "Salvar"

Permissões disponíveis:
- 👑 **Broadcaster** - Dono do canal
- ⚔️ **Moderator** - Moderadores
- 💎 **VIP** - VIPs do canal
- ⭐ **Subscriber** - Inscritos
- 👥 **Viewer** - Todos

### 3. Adicionar ao OBS/StreamLabs

1. Copie o "Link Overlay" no dashboard
2. No OBS/StreamLabs, adicione uma nova fonte "Browser Source"
3. Cole o URL
4. Configure tamanho (recomendado: 1280x720)

### 4. Testar Comandos

No seu chat use:
```
!watch <URL_DO_CLIPE>
!replay
!repeat @seu_usuario
!so @criador
!stop
!clip
```

## ⚙️ Painel Admin

Acesse `http://localhost:3000/admin`

**Credenciais padrão:**
- Usuário: `admin`
- Senha: `admin123`

> ⚠️ Altere as credenciais no arquivo `.env` em produção!

### Funcionalidades Admin

- 📊 Visualizar estatísticas de todos os canais
- ➕ Adicionar novos canais
- 🔄 Resetar métricas
- 🗑️ Remover canais
- 📈 Monitoramento em tempo real

## 🔗 Endpoints Públicos

### Verificar Canal
```
GET /overlay/check/:channel
```

### Obter Clipes do Canal
```
GET /api/public/clips/:channel
```

Exemplo de resposta:
```json
[
  {
    "id": "clip_id",
    "duration": 30,
    "url": "https://clips.twitch.tv/...",
    "thumbnail": "https://..."
  }
]
```

### Saúde do Servidor
```
GET /health
```

Retorna status do servidor, conexão do bot e métricas.

## 📝 Configuração de Canais

O arquivo `channelsConfigs.json` armazena configurações de cada canal:

```json
{
  "seu_canal": {
    "allowedCommands": {
      "watch": { "enabled": true, "roles": ["broadcaster", "moderator"] },
      "replay": { "enabled": true, "roles": ["broadcaster", "moderator", "vip"] },
      ...
    },
    "userId": "12345",
    "login": "seu_canal"
  }
}
```

## 🐛 Troubleshooting

### "Canal não encontrado"
- Verifique se o nome do canal está correto
- Configure o canal primeiro no dashboard
- Aguarde 1-2 minutos para sincronização

### "Erro de autenticação"
- Confirme as credenciais no `.env`
- Verifique o CALLBACK_URL (deve corresponder ao registrado na Twitch)
- Limpe cookies do navegador

### "Bot não responde"
- Confira se o BOT_USERNAME e BOT_OAUTH_TOKEN estão corretos
- Bot precisa estar como mod ou broadcaster no canal
- Verifique se o comando está ativado no dashboard

### "Overlay não aparece"
- CSS bloqueia iframes? Verifique a página (inspecione no DevTools)
- Adicione o overlay como "Browser Source" na OBS
- Recarregue a página do overlay

## 🔄 Atualizações

Para atualizar o projeto:
```bash
git pull origin main
npm install
npm start
```

## 📄 Licença

MIT License - veja LICENSE.md para detalhes

## 🤝 Contribuindo

Contribuições são bem-vindas! Abra uma issue ou pull request.

## 📞 Suporte

Para problemas, dúvidas ou sugestões:
- Abra uma issue no GitHub
- Entre em contato via Twitter
- Consulte a documentação da Twitch

---

**Desenvolvido com ❤️ para a comunidade Twitch**
