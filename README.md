# Amigo Secreto dos Vingadores 🛡️

Cada pessoa se cadastra (nome, tamanho de roupa, o que gosta e um PIN de 4 números).
O organizador faz o sorteio. Depois, cada um usa o PIN para ver quem tirou — ninguém vê o resultado dos outros.

## Subir no Render
1. Suba esta pasta para um repositório novo no GitHub (`server.js` e `package.json` na raiz, `index.html` dentro de `public`).
2. No Render: **New + → Web Service**, escolha o repositório.
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plano: Free
3. Em **Environment**, crie:
   - `ADMIN_PASSWORD` = a senha do organizador
   - `DATABASE_URL` = a **Internal Database URL** do mesmo Postgres que você já usa no outro site (o Render só dá 1 banco grátis; os dois sites dividem sem misturar dados).
4. Abra o site, role até o rodapé e toque em **🔒 sou o organizador**.

## Rodar local
    npm install
    ADMIN_PASSWORD=minhasenha npm start
(sem DATABASE_URL, os dados ficam em data.json)
