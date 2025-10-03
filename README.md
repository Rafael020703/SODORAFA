# SODORAFA

Sistema de Overlay e Bot para Twitch
------------------------------------

Este projeto integra um bot e um sistema de overlays para transmissões na Twitch, com autenticação via Twitch, gerenciamento de mídia, comandos customizados e integração com recompensas do canal.

Funcionalidades principais:
- Overlay de clipes e sons para usar em live
- Bot de chat com comandos customizáveis
- Integração com autenticação Twitch (OAuth)
- Gerenciamento de canais monitorados
- Sistema de sessão persistente (não precisa logar toda vez)
- Visual moderno e responsivo

Como usar:
1. Configure o arquivo `.env` com as credenciais da Twitch e dados do app.
2. Adicione o usuário e token do bot em `credentials.json`.
3. Liste os canais a serem monitorados em `channels.json` (um por linha, sem #).
4. Execute `npm install` para instalar as dependências.
5. Inicie o sistema com `npm start`.

Ao acessar o site, o login via Twitch é obrigatório. O sistema só permite acesso a usuários autenticados.

**Atenção:**
- Não compartilhe suas credenciais.
- O arquivo `channelConfigs.json` permite customizar permissões e comandos por canal.
