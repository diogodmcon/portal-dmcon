# Portal DMCON

Estrutura do projeto:

- `index.html` — o Portal (interface completa: Dashboard, Comercial, Societário, Onboarding, Fiscal, Assistente IA, etc.)
- `netlify/functions/chat.js` — função que faz a ponte segura entre o Assistente IA do Portal e a API da Anthropic (Claude). A chave de API fica guardada como variável de ambiente no Netlify, nunca dentro do código.
- `netlify.toml` — configuração do Netlify (aponta pra pasta das funções).

## Como publicar

1. Suba esses arquivos (mantendo a estrutura de pastas) para um repositório no GitHub.
2. No Netlify, use "Import from Git" e conecte esse repositório.
3. Em **Site settings → Environment variables**, adicione:
   - `ANTHROPIC_API_KEY` = a chave gerada em console.anthropic.com
4. Publique. O Assistente IA (menu lateral) já vai funcionar automaticamente.
