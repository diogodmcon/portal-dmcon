# Portal DMCON

Estrutura do projeto:

- `index.html` — o Portal (interface completa: Dashboard, Comercial, Societário, Onboarding, Fiscal, Assistente IA, etc.)
- `netlify/functions/chat.js` — função que faz a ponte segura entre o Assistente IA do Portal e a API da Anthropic (Claude). A chave de API fica guardada como variável de ambiente no Netlify, nunca dentro do código.
- `netlify/functions/daily-email.js` — função AGENDADA (roda sozinha todo dia, sem ninguém abrir o Portal) que manda o resumo diário do Fiscal por e-mail: um resumo geral pros gestores (o que foi feito ontem + situação de hoje) e um e-mail individual de pendências pra cada responsável fiscal. Só cobre o módulo Fiscal por enquanto.
- `netlify.toml` — configuração do Netlify (aponta pra pasta das funções e define o horário do e-mail diário — hoje às 8h de Brasília).

## Como publicar

1. Suba esses arquivos (mantendo a estrutura de pastas) para um repositório no GitHub.
2. No Netlify, use "Import from Git" e conecte esse repositório.
3. Em **Site settings → Environment variables**, adicione:
   - `ANTHROPIC_API_KEY` = a chave gerada em console.anthropic.com (pro Assistente IA)
   - `EMAILJS_PRIVATE_KEY` = a chave PRIVADA da sua conta EmailJS (pro e-mail diário do Fiscal — ver abaixo como conseguir)
   - `EMAILJS_TEMPLATE_DIGEST_ID` = o ID do template novo do EmailJS (ver abaixo)
4. Publique. O Assistente IA (menu lateral) já vai funcionar automaticamente.

## Como configurar o e-mail diário do Fiscal (opcional)

O Portal já usa o EmailJS pra mandar alguns avisos (novo cliente, @menção, etc.) direto do navegador. O e-mail diário é diferente: ele precisa ser enviado pelo SERVIDOR (de madrugada, sem ninguém com o Portal aberto), então usa uma chave diferente do EmailJS — a chave PRIVADA, não a pública. Passo a passo:

1. **Adicionar a coluna de e-mail na tabela de usuários** (se ainda não existir): no Supabase, rode
   ```sql
   alter table usuarios add column if not exists email text;
   ```
   Depois, cadastre o e-mail de cada pessoa em **👤 Usuários** dentro do Portal (campo "E-mail", ao editar ou criar um usuário).
2. **Pegar a chave privada do EmailJS**: entre em [emailjs.com](https://www.emailjs.com) → faça login na conta já usada pelo Portal → **Account → API Keys** → copie a "Private Key".
3. **Criar um template novo no EmailJS** (o resumo diário é maior que os avisos normais, então precisa de um template próprio): em **Email Templates → Create New Template**, crie um com estas 3 variáveis no corpo: `{{to_name}}`, `{{titulo}}` e `{{corpo}}` (esse último recebe o texto inteiro do resumo — deixe o campo grande o bastante e sem formatação chique, é texto simples). Copie o ID desse template (algo tipo `template_xxxxxxx`).
4. No Netlify, adicione as duas variáveis de ambiente citadas acima (`EMAILJS_PRIVATE_KEY` e `EMAILJS_TEMPLATE_DIGEST_ID`) com os valores que você pegou nos passos 2 e 3.
5. Pronto — a partir da próxima publicação, o e-mail sai sozinho todo dia às 8h. Pra pessoas sem e-mail cadastrado ainda, o resumo dos gestores avisa quem ficou de fora, pra você ir completando aos poucos.

## Como dar acesso avançado ao Fiscal (Gerencial, Configuração Fiscal e Conferência) pelo cadastro

Antes, essa permissão só podia ser liberada mexendo no código. Agora dá pra liberar direto pela tela **👤 Usuários**, editando o cadastro da pessoa e marcando a caixinha "Acesso avançado ao Fiscal".

1. No Supabase, rode (uma vez só):
   ```sql
   alter table usuarios add column if not exists fiscalconferente boolean default false;
   ```
2. No Portal, vá em **👤 Usuários → editar a pessoa** e marque "Acesso avançado ao Fiscal (Gerencial, Configuração Fiscal e Conferência)". Salve.
3. Pronto — na próxima vez que essa pessoa entrar no sistema, ela já vê essas abas dentro do Fiscal, sem precisar virar Gestor (Acesso Total) nem eu mexer em código.

Quem já tem "Acesso de Gestor" marcado continua enxergando tudo automaticamente (essa caixinha nem precisa ser marcada nesse caso).
