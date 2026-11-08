// Order state machine for R1: authorize first, capture the full amount only after a
// deterministic verdict plus an explicit human click. The model never enables capture.
import { createHash } from 'node:crypto';
import { validar } from './validar.mjs';
import { checarParecer } from './parecer.mjs';

const sha256 = (t) => createHash('sha256').update(t).digest('hex');
const DIA = 86400000;

export class ErroRegra extends Error {
  constructor(codigo, msg) { super(`${codigo}: ${msg}`); this.codigo = codigo; }
}

/** JSON with sorted keys, so the payload hash does not depend on key order. */
export function canonico(v) {
  if (Array.isArray(v)) return `[${v.map(canonico).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonico(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// Forward-only ranking used by webhooks and reconciliation.
const RANK = { CRIADO: 0, AUTORIZADO: 1, ENTREGUE: 2, CONFERIDO: 3, CAPTURA_PEDIDA: 4, CAPTURA_PENDENTE: 5, CAPTURADO: 9, CAPTURA_RECUSADA: 9, ANULADO: 9, EXPIRADO: 9 };

export class Mesa {
  /**
   * @param {object} o
   * @param {object} o.paypal   client with the PayPal REST subset (real sandbox or fixture)
   * @param {() => number} o.agora  clock in ms
   * @param {object} [o.brief]
   * @param {string} [o.amostra] approved sample lines (no header)
   */
  constructor({ paypal, agora = () => Date.now(), brief, amostra }) {
    Object.assign(this, { paypal, agora, brief, amostra });
    this.pedidos = new Map();
    this.travas = new Map();
    this.eventos = new Set();
    this.log = [];
  }

  #trava(id, fn) {
    const anterior = this.travas.get(id) || Promise.resolve();
    const atual = anterior.catch(() => {}).then(fn);
    this.travas.set(id, atual.catch(() => {}));
    return atual;
  }

  #registrar(p, evento, extra = {}) {
    const linha = { t: new Date(this.agora()).toISOString(), pedido: p.id, estado: p.estado, evento, ...extra };
    p.trilha.push(linha);
    this.log.push(linha);
  }

  #alerta(p, msg) { p.alertas.push({ t: new Date(this.agora()).toISOString(), msg }); this.#registrar(p, 'alerta', { msg }); }

  pedido(id) {
    const p = this.pedidos.get(id);
    if (!p) throw new ErroRegra('PEDIDO_INEXISTENTE', id);
    this.#expirar(p);
    return p;
  }

  #dias(p) { return p.autorizado_em == null ? 0 : Math.floor((this.agora() - p.autorizado_em) / DIA); }
  #diasAutAtual(p) { return p.aut_atual_em == null ? 0 : Math.floor((this.agora() - p.aut_atual_em) / DIA); }

  #expirar(p) {
    const terminal = ['CAPTURADO', 'CAPTURA_RECUSADA', 'ANULADO', 'EXPIRADO', 'CAPTURA_PENDENTE', 'INCERTO'];
    if (p.autorizado_em != null && this.#dias(p) >= 30 && !terminal.includes(p.estado)) {
      p.estado = 'EXPIRADO';
      this.#registrar(p, 'expirou', { msg: 'nova autorização exige novo pedido' });
    }
  }

  /** Honor period warning (day 4 onwards of the current authorization). */
  avisos(id) {
    const p = this.pedido(id);
    const out = [];
    if (p.estado === 'EXPIRADO') out.push('Autorização expirada: nova autorização exige novo pedido.');
    else if (p.autorizacao_id && this.#diasAutAtual(p) >= 3 && !['CAPTURADO', 'ANULADO'].includes(p.estado)) out.push('Honor period vencido: a captura pode falhar; reautorizar exige ação humana (uma vez, do dia 4 ao 29).');
    return out;
  }

  async criar({ id, valor = '50.00', moeda = 'USD' }) {
    if (this.pedidos.has(id)) throw new ErroRegra('PEDIDO_EXISTE', id);
    const p = { id, valor, moeda, estado: 'CRIADO', trilha: [], alertas: [], requisicoes: {}, contadores: { posts_capture: 0, posts_void: 0, posts_reauth: 0, capturas_ok: 0 }, reentregas: 0, reautorizacoes: 0, autorizacoes_substituidas: [] };
    this.pedidos.set(id, p);
    const ordem = await this.paypal.criarPedido({ valor, moeda, requestId: sha256(`${id}|create`) });
    p.order_id = ordem.id;
    p.aprovacao_url = ordem.aprovacao_url;
    this.#registrar(p, 'pedido criado na PayPal', { order_id: ordem.id });
    return p;
  }

  /** After the buyer approved the order in PayPal: authorize it (money held, not captured). */
  async autorizar(id) {
    return this.#trava(id, async () => {
      const p = this.pedido(id);
      if (p.estado !== 'CRIADO') throw new ErroRegra('ESTADO', `autorizar exige CRIADO, está ${p.estado}`);
      const a = await this.paypal.autorizarPedido({ orderId: p.order_id, requestId: sha256(`${id}|authorize|${p.order_id}`) });
      p.autorizacao_id = a.id; p.autorizacao_original = a.id;
      p.autorizado_em = this.agora(); p.aut_atual_em = this.agora();
      p.estado = 'AUTORIZADO';
      this.#registrar(p, 'autorizado', { authorization_id: a.id, status: a.status });
      return p;
    });
  }

  entregar(id, lote) {
    const p = this.pedido(id);
    if (!['AUTORIZADO', 'REENTREGA'].includes(p.estado)) throw new ErroRegra('ESTADO', `entregar exige AUTORIZADO ou REENTREGA, está ${p.estado}`);
    p.lote = lote; p.lote_sha256 = sha256(lote); p.estado = 'ENTREGUE';
    delete p.relatorio; delete p.parecer;
    this.#registrar(p, 'lote entregue', { lote_sha256: p.lote_sha256 });
    return p;
  }

  conferir(id) {
    const p = this.pedido(id);
    if (p.estado !== 'ENTREGUE') throw new ErroRegra('ESTADO', `conferir exige ENTREGUE, está ${p.estado}`);
    p.relatorio = validar(this.brief, p.lote, this.amostra);
    p.estado = 'CONFERIDO';
    p.cor = p.relatorio.veredito;
    this.#registrar(p, 'conferido', { veredito: p.cor, validas: p.relatorio.validas, rejeicoes: p.relatorio.rejeicoes.length });
    return p.relatorio;
  }

  /** Advisory text from a model. Checked against the report; it can never enable or block capture. */
  async parecer(id, gerar) {
    const p = this.pedido(id);
    if (!p.relatorio) throw new ErroRegra('ESTADO', 'parecer exige relatório');
    let texto;
    try { texto = await gerar(p.relatorio, this.brief); } catch (e) {
      p.parecer = { estado: 'indisponivel', texto: 'Parecer indisponível', motivo: String(e.message || e) };
      this.#registrar(p, 'parecer indisponível', { motivo: p.parecer.motivo });
      return p.parecer;
    }
    const chk = checarParecer(texto, p.relatorio);
    p.parecer = chk.ok ? { estado: 'aceito', texto, rotulo: 'parecer, não decisão' } : { estado: 'rejeitado', texto, motivo: chk.motivo, rotulo: 'parecer rejeitado pela checagem' };
    this.#registrar(p, `parecer ${p.parecer.estado}`, chk.ok ? {} : { motivo: chk.motivo });
    return p.parecer;
  }

  podeCapturar(p, { li_rejeicoes = false } = {}) {
    if (p.estado !== 'CONFERIDO') return [false, `estado ${p.estado}`];
    if (p.capture_id) return [false, 'pedido já tem capture_id'];
    if (p.cor === 'verde') return [true];
    if (p.cor === 'amarelo') return li_rejeicoes ? [true] : [false, `marque "li as ${p.relatorio.rejeicoes.length} rejeições"`];
    return [false, 'veredito vermelho'];
  }

  /** Records request id and payload hash before sending; the same id with another payload is blocked locally. */
  #preparar(p, op, payload) {
    const requestId = sha256(`${p.id}|${op}|${p.autorizacao_id}`);
    const hash = sha256(canonico(payload));
    const antes = p.requisicoes[requestId];
    if (antes && antes.hash !== hash) {
      this.#alerta(p, `mesmo PayPal-Request-Id com payload diferente em ${op}; nada enviado`);
      throw new ErroRegra('REQUEST_ID_PAYLOAD_DIVERGENTE', `${op} ${requestId.slice(0, 12)}`);
    }
    p.requisicoes[requestId] = { op, hash, payload };
    return requestId;
  }

  /** Human click "capture". Full amount, final_capture true. */
  async capturar(id, { humano = false, li_rejeicoes = false } = {}) {
    if (!humano) throw new ErroRegra('SEM_CLIQUE_HUMANO', 'captura exige clique humano');
    return this.#trava(id, async () => {
      const p = this.pedido(id);
      const [ok, motivo] = this.podeCapturar(p, { li_rejeicoes });
      if (!ok) { this.#registrar(p, 'captura recusada localmente', { motivo }); return p; }
      return this.#enviarCaptura(p, { final_capture: true });
    });
  }

  /** Retry of a capture whose answer was lost. Only reachable through an explicit human action. */
  async repetirCaptura(id, payload = { final_capture: true }) {
    return this.#trava(id, async () => {
      const p = this.pedido(id);
      this.#preparar(p, 'capture', payload); // throws on divergent payload before anything else
      throw new ErroRegra('CAPTURA_BLOQUEADA', `invariante 8: ${p.estado}${p.capture_id ? ' com capture_id' : ''}; reconciliar por GET`);
    });
  }

  async #enviarCaptura(p, payload) {
    const requestId = this.#preparar(p, 'capture', payload);
    p.estado = 'CAPTURA_PEDIDA';
    this.#registrar(p, 'captura pedida', { requestId: requestId.slice(0, 12) });
    p.contadores.posts_capture++;
    let r;
    try {
      r = await this.paypal.capturar({ autorizacaoId: p.autorizacao_id, payload, requestId });
    } catch (e) {
      if (e.incerto) { p.estado = 'INCERTO'; p.incerto = 'capture'; this.#registrar(p, 'resposta perdida', { motivo: e.message }); return p; }
      p.estado = 'CAPTURA_RECUSADA'; this.#registrar(p, 'captura recusada pela PayPal', { motivo: e.message }); return p;
    }
    return this.#aplicarCaptura(p, r);
  }

  #aplicarCaptura(p, r) {
    if (r.status === 'COMPLETED') {
      p.capture_id = r.id; p.estado = 'CAPTURADO'; p.contadores.capturas_ok = 1; delete p.incerto;
      this.#registrar(p, 'capturado', { capture_id: r.id });
    } else if (r.status === 'PENDING') {
      p.capture_id = r.id; p.estado = 'CAPTURA_PENDENTE';
      this.#registrar(p, 'captura pendente (não é recebido)', { capture_id: r.id });
    } else {
      p.capture_id = r.id; p.estado = 'CAPTURA_RECUSADA';
      this.#registrar(p, 'captura recusada', { status: r.status });
    }
    return p;
  }

  /** Reconciliation by GET only. Never sends a new POST. */
  async reconciliar(id) {
    return this.#trava(id, async () => {
      const p = this.pedido(id);
      if (p.estado === 'CAPTURA_PENDENTE') {
        const c = await this.paypal.obterCaptura(p.capture_id);
        if (c.status === 'COMPLETED' && this.#confere(p, c)) return this.#aplicarCaptura(p, c);
        if (['DECLINED', 'FAILED'].includes(c.status)) return this.#aplicarCaptura(p, c);
        this.#registrar(p, 'captura segue pendente', { status: c.status });
        return p;
      }
      if (p.estado === 'INCERTO' && p.incerto === 'capture') {
        const a = await this.paypal.obterAutorizacao(p.autorizacao_id);
        const k = a.supplementary_data?.related_ids?.capture_id;
        if (a.status === 'CAPTURED' && k) {
          const c = await this.paypal.obterCaptura(k);
          if (c.status === 'COMPLETED' && this.#confere(p, c)) return this.#aplicarCaptura(p, c);
        }
        this.#alerta(p, 'captura provável sem vínculo verificável; captura, void e reautorização bloqueados até humano');
        return p;
      }
      // Divergence check for live states.
      if (['AUTORIZADO', 'ENTREGUE', 'CONFERIDO'].includes(p.estado) && p.autorizacao_id) {
        const a = await this.paypal.obterAutorizacao(p.autorizacao_id);
        const esperado = ['CREATED'];
        if (!esperado.includes(a.status)) {
          p.divergencia = { local: p.estado, paypal: a.status };
          p.estado = 'INCERTO'; p.incerto = 'divergencia';
          this.#alerta(p, `divergência: local ${p.divergencia.local}, PayPal ${a.status}; nenhuma ação até humano`);
        }
      }
      return p;
    });
  }

  #confere(p, c) {
    return c.amount?.value === p.valor && c.amount?.currency_code === p.moeda && c.supplementary_data?.related_ids?.authorization_id === p.autorizacao_id;
  }

  async anular(id, { humano = false } = {}) {
    if (!humano) throw new ErroRegra('SEM_CLIQUE_HUMANO', 'void exige clique humano');
    return this.#trava(id, async () => {
      const p = this.pedido(id);
      if (!['AUTORIZADO', 'ENTREGUE', 'CONFERIDO'].includes(p.estado)) { this.#registrar(p, 'void bloqueado', { motivo: `estado ${p.estado}` }); return p; }
      const requestId = this.#preparar(p, 'void', {});
      p.contadores.posts_void++;
      await this.paypal.anular({ autorizacaoId: p.autorizacao_id, requestId });
      p.estado = 'ANULADO';
      this.#registrar(p, 'anulado');
      return p;
    });
  }

  async reautorizar(id, { humano = false } = {}) {
    if (!humano) throw new ErroRegra('SEM_CLIQUE_HUMANO', 'reautorização exige clique humano');
    return this.#trava(id, async () => {
      const p = this.pedido(id);
      const d = this.#dias(p);
      if (!['AUTORIZADO', 'ENTREGUE', 'CONFERIDO'].includes(p.estado)) { this.#registrar(p, 'reautorização bloqueada', { motivo: `estado ${p.estado}` }); return p; }
      if (p.reautorizacoes >= 1) { this.#registrar(p, 'reautorização bloqueada', { motivo: 'invariante 7: no máximo uma' }); return p; }
      if (d < 3 || d > 29) { this.#registrar(p, 'reautorização bloqueada', { motivo: `dia ${d + 1}; permitido do dia 4 ao 29` }); return p; }
      const payload = { amount: { currency_code: p.moeda, value: p.valor } };
      const requestId = this.#preparar(p, 'reauthorize', payload);
      p.contadores.posts_reauth++;
      const a = await this.paypal.reautorizar({ autorizacaoId: p.autorizacao_id, payload, requestId });
      p.autorizacoes_substituidas.push(p.autorizacao_id);
      p.autorizacao_id = a.id; p.aut_atual_em = this.agora(); p.reautorizacoes++;
      this.#registrar(p, 'reautorizado', { authorization_id: a.id });
      return p;
    });
  }

  pedirReentrega(id) {
    const p = this.pedido(id);
    if (p.estado !== 'CONFERIDO' || p.cor === 'verde') throw new ErroRegra('ESTADO', 'reentrega só depois de conferência amarela ou vermelha');
    if (p.reentregas >= 2) throw new ErroRegra('LIMITE', 'máximo de 2 reentregas; anular ou negociar');
    p.reentregas++; p.estado = 'REENTREGA';
    this.#registrar(p, 'reentrega pedida', { contador: p.reentregas });
    return p;
  }

  /** Webhooks: deduplicated by event id; only forward transitions are applied. */
  webhook(evento) {
    if (this.eventos.has(evento.id)) return { aplicado: false, motivo: 'duplicado' };
    this.eventos.add(evento.id);
    const p = [...this.pedidos.values()].find((x) => x.autorizacao_id === evento.resource?.supplementary_data?.related_ids?.authorization_id || x.autorizacao_id === evento.resource?.id || x.capture_id === evento.resource?.id);
    if (!p) return { aplicado: false, motivo: 'pedido não encontrado' };
    const alvo = { 'PAYMENT.AUTHORIZATION.CREATED': 'AUTORIZADO', 'PAYMENT.CAPTURE.PENDING': 'CAPTURA_PENDENTE', 'PAYMENT.CAPTURE.COMPLETED': 'CAPTURADO', 'PAYMENT.CAPTURE.DENIED': 'CAPTURA_RECUSADA', 'PAYMENT.AUTHORIZATION.VOIDED': 'ANULADO' }[evento.event_type];
    if (!alvo) return { aplicado: false, motivo: 'tipo ignorado' };
    if ((RANK[alvo] ?? 0) <= (RANK[p.estado] ?? 0)) { this.#registrar(p, 'webhook ignorado (retrocesso)', { evento: evento.event_type }); return { aplicado: false, motivo: 'retrocesso' }; }
    if (alvo === 'CAPTURADO') { p.capture_id = evento.resource.id; p.contadores.capturas_ok = 1; }
    p.estado = alvo;
    this.#registrar(p, 'webhook aplicado', { evento: evento.event_type });
    return { aplicado: true };
  }
}
