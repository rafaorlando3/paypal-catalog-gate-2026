// Entry point. MODE=fixture (default, public, no PayPal call, labeled) or MODE=sandbox (PayPal sandbox REST, operator login).
// Run the two modes as separate processes with separate DATA_DIR; the sandbox process must never serve the public fixture.
import { criarApp } from './app.mjs';
import { PayPalRest } from './paypal-rest.mjs';
import { geradorGemini } from './parecer.mjs';
import { StoreArquivo } from './store.mjs';
import { criarVerificador, buscarCertHttps } from './webhook.mjs';

const modo = process.env.MODE === 'sandbox' ? 'sandbox' : 'fixture';
const porta = Number(process.env.PORT || 8787);
const baseUrl = process.env.BASE_URL || `http://localhost:${porta}`;
const num = (n, d) => (process.env[n] ? Number(process.env[n]) : d);

const config = {
  modo, baseUrl,
  gerar: process.env.GEMINI_API_KEY ? geradorGemini() : undefined,
  limites: { llmPorDia: num('LLM_MAX_PER_DAY', 50), llmPorSessao: num('LLM_MAX_PER_SESSION', 5), llmPorPedido: num('LLM_MAX_PER_ORDER', 3) },
};
if (modo === 'sandbox') {
  Object.assign(config, {
    paypal: new PayPalRest({ retornoUrl: `${baseUrl}/retorno` }),
    store: new StoreArquivo(`${process.env.DATA_DIR || './data'}/orders.json`), // exclusive lock: a second process fails here
    operadorSha256: process.env.OPERATOR_TOKEN_SHA256,
    verificarWebhook: process.env.PAYPAL_WEBHOOK_ID ? criarVerificador({ webhookId: process.env.PAYPAL_WEBHOOK_ID, buscarCert: buscarCertHttps }) : undefined,
  });
}
const { servidor } = criarApp(config);
for (const sinal of ['SIGINT', 'SIGTERM']) process.once(sinal, () => servidor.close(() => process.exit(0)));
servidor.listen(porta, () => console.log(`mode ${modo} on ${baseUrl}`));
