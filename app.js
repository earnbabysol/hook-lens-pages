'use strict';

const $ = (id) => document.getElementById(id);
const HISTORY_KEY = 'hook-lens-history-v1';
const state = { sequence: 0, jobId: null, running: false, pollTimer: null, elapsedTimer: null, started: 0, result: null, rpcUrls: {}, meta: null, history: [] };
const chainNames = { eth: 'Ethereum', base: 'Base', bsc: 'BSC', robinhood: 'Robinhood' };
const confidenceNames = { confirmed: '链上已确认', sampled: '样本验证', unknown: '待确认' };
const directionNames = { buy: '买入', sell: '卖出', internal: '内部交易', unknown: '方向未确认' };
const statusNames = { confirmed: '确认额外收费', 'no-extra-observed': '未观察到额外税', ambiguous: '证据不足' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  const paths = { copy: 'M7 6h9v11H7zM4 13H3V3h9v1', down: 'm5 7 5 5 5-5', download: 'M10 3v9m-4-4 4 4 4-4M4 13v4h12v-4', external: 'M11 3h6v6m0-6-9 9M8 4H3v13h13v-5' };
  path.setAttribute('d', paths[name] || paths.external);
  svg.append(path);
  return svg;
}

function safeUrl(value) {
  if (!value || typeof value !== 'string') return null;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}

function link(label, url, className) {
  const target = safeUrl(url);
  if (!target) return el('span', className, label);
  const node = el('a', className, label);
  node.href = target; node.target = '_blank'; node.rel = 'noopener noreferrer';
  return node;
}

function short(value, lead = 8, tail = 6) {
  const text = String(value || '—');
  return text.length > lead + tail + 3 ? `${text.slice(0, lead)}…${text.slice(-tail)}` : text;
}

function pct(value) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '未确认';
  return `${Number(value).toLocaleString('en-US', { maximumFractionDigits: 6 })}%`;
}

function amount(value) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  if (number !== 0 && Math.abs(number) < 0.000001) return number.toExponential(3);
  return number.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

function tokenName(token) {
  if (typeof token === 'string') return token.startsWith('0x') ? short(token, 6, 4) : token;
  return token?.symbol || token?.name || short(token?.address, 6, 4);
}

function dateTime(value) {
  if (!value) return '时间未知';
  const numeric = typeof value === 'number' || /^\d+$/.test(String(value));
  const date = new Date(numeric ? Number(value) * (Number(value) < 1e12 ? 1000 : 1) : value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
}

function explorerUrl(result, type, value) {
  const base = safeUrl(result?.chain?.explorer);
  return base && value ? `${base.replace(/\/$/, '')}/${type}/${encodeURIComponent(value)}` : null;
}

function displayValue(value) {
  if (value === null || value === undefined) return '未确认';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function messageOf(error) {
  if (typeof error === 'string') return redactText(error);
  return redactText(error?.message || '数据请求失败，请稍后重试或在高级设置中更换 RPC。');
}

function redactText(value) {
  let output = String(value || '');
  for (const rpc of Object.values(state.rpcUrls)) if (rpc) output = output.split(rpc).join('[自定义 RPC]');
  return output.replace(/([?&](?:api[_-]?key|token|access[_-]?token|key|secret|authorization)=)[^\s&#]+/gi, '$1[已隐藏]');
}

function exportSafe(value, key = '') {
  if (/^(?:rpc(?:Urls?|Endpoints?)?|endpoint|api[_-]?key|access[_-]?token|authorization|headers|providerUrl|privateKey)$/i.test(key)) return undefined;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => exportSafe(item)).filter((item) => item !== undefined);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, exportSafe(item, name)]).filter(([, item]) => item !== undefined));
  return value;
}

let toastTimer;
function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2400);
}

function copyButton(value, label) {
  const button = el('button', 'copy-button');
  button.type = 'button'; button.title = `复制${label}`; button.setAttribute('aria-label', `复制${label}`); button.append(icon('copy'));
  button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(String(value)); toast(`${label}已复制`); }
    catch { toast('复制未成功，可选中地址手动复制。'); }
  });
  return button;
}

async function api(path, options = {}) {
  if (window.HookLensBrowser) return window.HookLensBrowser.request(path, options);
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  let data;
  try { data = await response.json(); } catch { throw new Error(`服务返回异常（HTTP ${response.status}），请确认本地服务正在运行。`); }
  if (!response.ok) throw new Error(messageOf(data.error || data.message || `请求失败（HTTP ${response.status}）`));
  return data;
}

function saveHistory(result) {
  const input = result.pool?.id || result.hook?.address;
  const chain = result.chain?.id;
  if (!/^0x[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(input || '') || !chainNames[chain]) return;
  const item = { input, chain, name: redactText(result.pool?.name || result.hook?.contractName || short(input)).slice(0, 60), at: result.analyzedAt };
  state.history = [item, ...state.history.filter((old) => old.input.toLowerCase() !== input.toLowerCase() || old.chain !== chain)].slice(0, 8);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history)); } catch { /* Local storage is optional. */ }
  renderHistory();
}

function renderHistory() {
  $('history-list').replaceChildren();
  $('history-section').hidden = !state.history.length;
  state.history.forEach((item) => {
    const button = el('button', 'history-button', item.name);
    button.type = 'button'; button.title = `重新分析 ${item.input}`;
    button.append(el('span', 'history-chain', chainNames[item.chain] || item.chain));
    button.addEventListener('click', () => useTarget(item.input, item.chain));
    $('history-list').append(button);
  });
}

function useTarget(input, chain) {
  if (state.running) { toast('当前分析进行中；可先取消，再查询另一个池子。'); return; }
  $('target-input').value = input; $('chain-select').value = chain || 'auto';
  $('analyze-form').requestSubmit();
}

function setRunning(running) {
  state.running = running;
  $('analyze-button').disabled = running;
  $('analyze-button').querySelector('span').textContent = running ? '分析中' : '开始分析';
  $('target-input').disabled = running; $('chain-select').disabled = running;
  $('sample-size').disabled = running;
  document.querySelectorAll('[data-rpc-chain]').forEach((input) => { input.disabled = running; });
  $('progress-panel').hidden = !running;
  if (!running) { clearTimeout(state.pollTimer); clearInterval(state.elapsedTimer); }
}

function renderProgress(progress) {
  if (!Array.isArray(progress) || !progress.length) return;
  const messages = progress.filter((entry) => entry && entry.message).slice(-7);
  if (!messages.length) return;
  $('progress-list').replaceChildren();
  messages.forEach((entry) => {
    const item = el('li'); item.append(el('span', '', redactText(entry.message)));
    if (entry.at) { const date = new Date(entry.at); if (!Number.isNaN(date.valueOf())) item.append(el('time', '', date.toLocaleTimeString('zh-CN', { hour12: false }))); }
    $('progress-list').append(item);
  });
  $('progress-title').textContent = redactText(messages[messages.length - 1].message);
  $('progress-list').scrollTop = $('progress-list').scrollHeight;
}

function showError(error) {
  setRunning(false);
  $('error-title').textContent = '本次分析未完成';
  $('error-message').textContent = messageOf(error);
  $('error-panel').hidden = false;
  $('empty-state').hidden = false;
}

async function pollJob(sequence, failures = 0) {
  if (sequence !== state.sequence || !state.jobId) return;
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(state.jobId)}`);
    if (sequence !== state.sequence) return;
    renderProgress(job.progress);
    if (job.status === 'complete' && job.result) {
      setRunning(false); state.result = job.result; state.jobId = null;
      renderResult(job.result); saveHistory(job.result);
      return;
    }
    if (job.status === 'error' || job.status === 'cancelled') { state.jobId = null; showError(job.error || '分析已停止，可重新发起。'); return; }
    state.pollTimer = setTimeout(() => pollJob(sequence), 1100);
  } catch (error) {
    if (sequence !== state.sequence) return;
    if (failures >= 3) { showError(error); return; }
    state.pollTimer = setTimeout(() => pollJob(sequence, failures + 1), 1700 * (failures + 1));
  }
}

async function beginAnalysis(event) {
  if (event) event.preventDefault();
  if (state.running) return;
  const input = $('target-input').value.trim();
  if (!input) { $('target-input').focus(); return; }
  const sequence = ++state.sequence;
  const rpcUrls = {};
  document.querySelectorAll('[data-rpc-chain]').forEach((node) => { if (node.value.trim()) rpcUrls[node.dataset.rpcChain] = node.value.trim(); });
  state.rpcUrls = rpcUrls; state.jobId = null; state.result = null;
  $('error-panel').hidden = true; $('empty-state').hidden = true; $('results').hidden = true;
  $('progress-list').replaceChildren(); $('progress-title').textContent = '正在连接链上数据'; $('elapsed').textContent = '0 秒';
  state.started = Date.now(); setRunning(true);
  state.elapsedTimer = setInterval(() => { const seconds = Math.floor((Date.now() - state.started) / 1000); $('elapsed').textContent = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`; }, 1000);
  try {
    const job = await api('/api/analyze', { method: 'POST', body: JSON.stringify({ input, chain: $('chain-select').value, sampleSize: Number($('sample-size').value), rpcUrls }) });
    if (!job.jobId) throw new Error('分析引擎未返回任务 ID，请重试。');
    if (sequence !== state.sequence) { await api(`/api/jobs/${encodeURIComponent(job.jobId)}`, { method: 'DELETE' }).catch(() => {}); return; }
    state.jobId = job.jobId;
    pollJob(sequence);
  } catch (error) { if (sequence === state.sequence) showError(error); }
}

function feeCard(direction, fee, result) {
  const data = fee || {};
  const unknown = data.approxTotalPct === null || data.approxTotalPct === undefined || data.approxTotalPct === '' || !Number.isFinite(Number(data.approxTotalPct));
  const confidence = confidenceNames[data.confidence] ? data.confidence : 'unknown';
  const card = el('article', `fee-card ${direction}${unknown ? ' unknown' : ''}`);
  const heading = el('div', 'fee-card-top');
  const label = el('div', 'fee-direction');
  label.append(el('span', 'direction-icon', direction === 'buy' ? '↙' : '↗'));
  const base = result.pool?.baseToken || result.pool?.token0;
  label.append(el('span', '', `${directionNames[direction]}${base ? ` ${tokenName(base)}` : ''}`));
  heading.append(label, el('span', `confidence-badge ${confidence}`, confidenceNames[confidence]));
  const main = el('div', 'fee-value-row');
  main.append(el('div', `fee-value${unknown ? ' unknown-value' : ''}`, `${unknown ? '' : '≈ '}${pct(data.approxTotalPct)}`), el('span', 'fee-value-label', '综合费用参考'));
  const components = el('div', 'fee-components');
  [['池内手续费', data.lpPct, ''], ['Hook 额外税', data.hookPct, data.hookBase === 'input' ? '按输入额' : data.hookBase === 'output' ? '按输出额' : '']].forEach(([name, value, basis]) => {
    const component = el('div'); component.append(el('div', 'fee-component-label', name));
    const number = el('div', 'fee-component-value', pct(value));
    if (basis) number.append(el('small', '', basis));
    component.append(number); components.append(component);
  });
  card.append(heading, main, components, el('p', 'fee-detail', data.detail || '仍需更多链上证据，暂不据此判定为零费率。'));
  return card;
}

function addressChip(label, address, url) {
  const node = el('div', 'address-chip'); node.append(el('span', 'address-label', label));
  const addressNode = link(address || '未找到', url, 'address-value');
  addressNode.title = address || '';
  node.append(addressNode);
  if (address) node.append(copyButton(address, label));
  return node;
}

function panelHeading(title, kicker) {
  const heading = el('div', 'panel-title'); heading.append(el('h3', '', title));
  if (kicker) heading.append(el('span', 'panel-kicker', kicker));
  return heading;
}

function factRow(label, value, url) {
  const row = el('div', 'fact-row'); row.append(el('dt', '', label));
  const detail = el('dd'); detail.append(url ? link(displayValue(value), url) : document.createTextNode(displayValue(value))); row.append(detail);
  return row;
}

function renderMechanism(result) {
  const mechanism = result.mechanism || {};
  const hook = result.hook || {};
  const grid = el('div', 'report-grid');
  const panel = el('section', 'panel'); panel.append(panelHeading('收费机制', 'MECHANISM'));
  const content = el('div', 'mechanism-content');
  content.append(el('h3', 'mechanism-name', mechanism.title || '机制尚待确认'), el('p', 'mechanism-summary', mechanism.summary || '当前没有足够证据完整还原收费逻辑。'));
  if (Array.isArray(mechanism.steps) && mechanism.steps.length) {
    const list = el('ol', 'mechanism-steps'); mechanism.steps.forEach((step) => list.append(el('li', '', displayValue(step)))); content.append(list);
  }
  if (hook.strategyAddress) {
    const strategy = el('div', 'strategy-box'); strategy.append(el('h4', '', '外部策略合约'), link(hook.strategyAddress, hook.strategyUrl || explorerUrl(result, 'address', hook.strategyAddress)), el('p', '', 'Hook 将部分逻辑交由此合约执行；实际费率需结合外部策略与交易回执判断。')); content.append(strategy);
  }
  panel.append(content);
  const details = el('section', 'panel'); details.append(panelHeading('合约与权限', 'CONTRACT'));
  const facts = el('dl', 'fact-list');
  facts.append(factRow('合约类型', hook.contractName || '未识别'), factRow('源码状态', hook.verified === true ? '已验证源码 ↗' : hook.verified === false ? '未取得验证源码' : '尚未确认', hook.sourceUrl));
  if (result.pool?.key) facts.append(factRow('池费率类型', Number(result.pool.key.fee) & 0x800000 ? '动态费率' : `${pct(Number(result.pool.key.fee) / 10000)} · 固定`), factRow('Tick spacing', result.pool.key.tickSpacing));
  facts.append(factRow('可调整性', mechanism.mutable === true ? '可调整，详见下方' : mechanism.mutable === false ? '已确认的参数不可调整' : '未确认'));
  if (Array.isArray(mechanism.facts)) mechanism.facts.forEach((fact) => facts.append(factRow(fact.label, fact.value)));
  details.append(facts);
  if (mechanism.changeNote) details.append(el('p', 'mutable-note', mechanism.changeNote));
  if (Array.isArray(hook.permissions) && hook.permissions.length) {
    const perms = el('details', 'permissions');
    const enabled = hook.permissions.filter((permission) => permission.enabled).length;
    perms.append(el('summary', '', `Hook 权限 · ${enabled} 项启用`));
    const list = el('div', 'permissions-grid');
    [...hook.permissions].sort((a, b) => Number(Boolean(b.enabled)) - Number(Boolean(a.enabled))).forEach((permission) => { const item = el('span', `permission${permission.enabled ? ' enabled' : ''}`, permission.name || permission.label); item.title = `${permission.label || permission.name}：${permission.enabled ? '启用' : '未启用'}`; list.append(item); });
    perms.append(list); details.append(perms);
  }
  grid.append(panel, details); return grid;
}

function detailItem(label, value, fullWidth = false, url = null) {
  const item = el('div', `detail-item${fullWidth ? ' full-width' : ''}`); item.append(el('span', '', label));
  const text = el('div'); text.append(url ? link(value, url) : document.createTextNode(value || '—')); item.append(text); return item;
}

function renderSample(sample, index, result) {
  const row = el('tr');
  const direction = directionNames[sample.direction] ? sample.direction : 'unknown';
  const first = el('td');
  const expand = el('button', 'sample-expand'); expand.type = 'button'; expand.setAttribute('aria-expanded', 'false'); expand.setAttribute('aria-controls', `sample-detail-${index}`); expand.setAttribute('aria-label', `展开第 ${index + 1} 笔交易证据`);
  expand.append(icon('down'), el('span', `direction-tag ${direction}`, directionNames[direction])); first.append(expand); row.append(first);
  row.append(el('td', 'sample-fee', pct(sample.poolFeePpm === null || sample.poolFeePpm === undefined ? null : Number(sample.poolFeePpm) / 10000)));
  const tax = el('td', 'sample-fee');
  if (sample.hookFee) { tax.append(el('span', '', pct(sample.hookFee.ratePct)), el('small', '', `${amount(sample.hookFee.amount)} ${tokenName(sample.hookFee.token)} · ${sample.hookFee.base === 'input' ? '输入额' : sample.hookFee.base === 'output' ? '输出额' : '基准未确认'}`)); }
  else tax.textContent = sample.status === 'no-extra-observed' ? '本笔未观察到' : '未确认';
  row.append(tax);
  const status = el('td'); status.append(el('span', `status-tag ${sample.status || 'ambiguous'}`, statusNames[sample.status] || '证据不足')); row.append(status);
  const hash = el('td'); hash.append(link(`${short(sample.txHash, 7, 5)} ↗`, explorerUrl(result, 'tx', sample.txHash), 'tx-link')); row.append(hash);
  const extra = el('tr', 'evidence-detail-row'); extra.id = `sample-detail-${index}`; extra.hidden = true;
  const cell = el('td'); cell.colSpan = 5;
  const wrapper = el('div', 'sample-detail'); const detailGrid = el('div', 'sample-detail-grid');
  detailGrid.append(detailItem('输入', sample.input ? `${sample.input.amount ?? '—'} ${tokenName(sample.input.token)}` : '—'), detailItem('输出', sample.output ? `${sample.output.amount ?? '—'} ${tokenName(sample.output.token)}` : '—'));
  detailGrid.append(detailItem('验证方法', sample.method || '未提供', true), detailItem('区块', `${displayValue(sample.blockNumber)}${sample.timestamp ? ` · ${dateTime(sample.timestamp)}` : ''}`));
  detailGrid.append(detailItem('同笔内部换税交易', String(sample.internalSwapCount || 0)));
  if (sample.hookFee) detailGrid.append(detailItem('确认的 Hook 收费', `${sample.hookFee.amount ?? '—'} ${tokenName(sample.hookFee.token)}（${sample.hookFee.raw ?? '—'} 原始单位）`, true));
  if (sample.recipient) detailGrid.append(detailItem('收费接收方', sample.recipient, true, explorerUrl(result, 'address', sample.recipient)));
  detailGrid.append(detailItem('交易哈希', sample.txHash, true, explorerUrl(result, 'tx', sample.txHash)));
  wrapper.append(detailGrid);
  const notes = Array.isArray(sample.notes) ? sample.notes : sample.notes ? [sample.notes] : [];
  notes.forEach((note) => wrapper.append(el('p', 'sample-note', displayValue(note)))); cell.append(wrapper); extra.append(cell);
  expand.addEventListener('click', () => { extra.hidden = !extra.hidden; expand.setAttribute('aria-expanded', String(!extra.hidden)); expand.setAttribute('aria-label', `${extra.hidden ? '展开' : '收起'}第 ${index + 1} 笔交易证据`); });
  return [row, extra];
}

function renderEvidence(result) {
  const evidence = result.evidence || {}; const stats = evidence.statistics || {}; const samples = evidence.samples || [];
  const panel = el('section', 'panel evidence-panel');
  const title = panelHeading('交易证据', null); title.append(el('span', 'evidence-title-note', '只统计本次取得的样本')); panel.append(title);
  const metrics = el('div', 'sample-metrics');
  const feeValues = stats.feePpmValues || result.fees?.lpFeePpmValues || [];
  const uniqueFeeValues = [...new Set(feeValues.filter((value) => value !== null && value !== undefined))];
  [
    ['交易样本', stats.sampledTransactions ?? samples.length, '笔', false],
    ['买入 / 卖出样本', `${samples.filter((sample) => sample.direction === 'buy').length} / ${samples.filter((sample) => sample.direction === 'sell').length}`, '笔', false],
    ['观察到的内部交易', stats.internalCount ?? 0, '笔', false],
    ['观察到的池费率', uniqueFeeValues.length ? uniqueFeeValues.map((fee) => pct(Number(fee) / 10000)).join(' / ') : '未确认', '', true]
  ].forEach(([label, value, unit, small]) => { const item = el('div', 'sample-metric'); const number = el('div', `sample-metric-value${small ? ' small' : ''}`, String(value)); if (unit) number.append(el('small', '', unit)); item.append(el('div', 'sample-metric-label', label), number); metrics.append(item); });
  panel.append(metrics);
  if (stats.swapsObserved) panel.append(el('p', 'evidence-footer', `本次取得 ${stats.swapsObserved} 条 Swap 日志，其中核对 ${stats.sampledTransactions ?? 0} 笔交易回执。${stats.fromBlock != null ? `日志区块范围：${stats.fromBlock}–${stats.toBlock}。` : ''}`));
  if (Array.isArray(stats.hookRevenue) && stats.hookRevenue.length) {
    const revenue = el('div', 'sample-revenue'); revenue.append(el('span', '', '确认的样本内 Hook 收费'));
    stats.hookRevenue.forEach((item) => revenue.append(el('strong', '', `${amount(item.amount)} ${tokenName(item.token)}`)));
    revenue.append(el('span', 'revenue-footnote', '非 24 小时收入，非净利润')); panel.append(revenue);
  }
  if (samples.length) {
    const wrap = el('div', 'table-scroll'); const table = el('table', 'evidence-table');
    const head = el('thead'); const headRow = el('tr'); ['方向', '池内手续费', 'Hook 额外税', '证据状态', '交易'].forEach((label) => { const cell = el('th', '', label); cell.scope = 'col'; headRow.append(cell); }); head.append(headRow);
    const body = el('tbody'); samples.forEach((sample, index) => body.append(...renderSample(sample, index, result))); table.append(head, body); wrap.append(table); panel.append(wrap);
  } else panel.append(el('div', 'evidence-empty', result.pool ? '本次未取得可验证的交易样本。不能据此认定为 0 税。' : '直接分析 Hook 合约时，需指定池子才能核对实际交易与买卖费率。'));
  panel.append(el('p', 'evidence-footer', '展开交易可查看计算依据与原始数量。“未观察到额外税”仅适用于对应样本；多跳路径、动态策略与未验证合约可能限制结论。'));
  return panel;
}

function downloadResult() {
  if (!state.result) return;
  const data = exportSafe(state.result);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const href = URL.createObjectURL(blob); const anchor = el('a');
  anchor.href = href; anchor.download = `hook-lens-${state.result.chain?.id || 'report'}-${String(state.result.pool?.id || state.result.hook?.address || 'analysis').slice(0, 12).replace(/[^a-z0-9-]/gi, '')}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(href), 1000);
  toast('已导出分析报告（不含 RPC 配置）');
}

function renderResult(result) {
  const target = $('results'); target.replaceChildren(); target.hidden = false;
  $('empty-state').hidden = true; $('error-panel').hidden = true;
  const heading = el('section', 'results-header');
  const intro = el('div'); const kicker = el('div', 'report-eyebrow'); kicker.append(el('span', 'chain-badge', result.chain?.name || chainNames[result.chain?.id] || '未知链'), el('span', '', '分析结果'));
  const name = result.pool?.name || result.hook?.contractName || 'Hook 合约';
  intro.append(kicker, el('h2', '', name));
  const time = el('div', 'report-time'); time.append(el('span', '', `分析于 ${dateTime(result.analyzedAt)}`));
  if (result.pool?.headBlock) time.append(el('span', '', `区块 #${Number(result.pool.headBlock).toLocaleString('en-US')}`));
  intro.append(time);
  const actions = el('div', 'report-actions'); const exportButton = el('button', 'secondary-button'); exportButton.type = 'button'; exportButton.title = '导出 JSON 分析报告'; exportButton.append(icon('download'), el('span', 'export-label', '导出报告')); exportButton.setAttribute('aria-label', '导出 JSON 分析报告'); exportButton.addEventListener('click', downloadResult); actions.append(exportButton); heading.append(intro, actions); target.append(heading);
  const addresses = el('div', 'addresses');
  if (result.pool?.id) addresses.append(addressChip('池 ID', result.pool.id, null));
  addresses.append(addressChip('Hook', result.hook?.address, result.hook?.explorerUrl || explorerUrl(result, 'address', result.hook?.address))); target.append(addresses);
  const fees = el('section', 'fee-grid'); fees.setAttribute('aria-label', '买卖费用'); fees.append(feeCard('buy', result.fees?.buy, result), feeCard('sell', result.fees?.sell, result)); target.append(fees);
  const scope = el('div', 'fee-scope'); scope.append(el('span', 'info-icon', 'i'));
  const scopeText = [result.fees?.scope, result.fees?.note, '综合费用为近似参考，不包含价格影响、滑点或路由器另行收费。'].filter(Boolean).join(' '); scope.append(el('p', '', scopeText)); target.append(scope);
  target.append(renderMechanism(result), renderEvidence(result));
  const warnings = [...new Set([...(Array.isArray(result.warnings) ? result.warnings : []), ...(Array.isArray(result.evidence?.warnings) ? result.evidence.warnings : [])].map(displayValue))];
  if (warnings.length) { const panel = el('section', 'warning-panel'); panel.append(el('h3', '', '结论边界与待确认事项')); const list = el('ul'); warnings.forEach((warning) => list.append(el('li', '', redactText(warning)))); panel.append(list); target.append(panel); }
  if (Array.isArray(result.sources) && result.sources.length) { const sources = el('div', 'sources-row'); sources.append(el('span', '', '数据与依据')); result.sources.forEach((source) => { if (safeUrl(source.url)) sources.append(link(`${source.label || '来源'} ↗`, source.url)); }); target.append(sources); }
  if (window.innerWidth < 701) heading.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

async function initialize() {
  if (window.HookLensBrowser) {
    const hint = document.querySelector('.settings-heading p');
    if (hint) hint.textContent = '默认使用公共数据源。自定义 RPC 需要 HTTPS 并允许浏览器跨域，地址仅在本页临时使用。';
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    state.history = Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.input === 'string' && /^0x[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(item.input) && chainNames[item.chain]).slice(0, 8).map((item) => ({ input: item.input, chain: item.chain, name: String(item.name || short(item.input)).slice(0, 60), at: item.at })) : [];
  } catch { state.history = []; }
  renderHistory();
  try {
    state.meta = await api('/api/meta');
    if (state.meta.version) $('version').textContent = `v${state.meta.version}`;
    if (Array.isArray(state.meta.chains)) state.meta.chains.forEach((chain) => { if (chain.id && chain.name) chainNames[chain.id] = chain.name; });
    if (Array.isArray(state.meta.examples)) {
      $('examples').replaceChildren();
      state.meta.examples.slice(0, 4).forEach((example) => {
        const button = el('button', 'example-button', example.label); button.type = 'button';
        button.append(el('span', '', chainNames[example.chain] || example.chain || '自动')); button.addEventListener('click', () => useTarget(example.input, example.chain)); $('examples').append(button);
      });
      $('examples-wrap').hidden = !$('examples').children.length;
    }
  } catch { $('version').textContent = ''; }
  const params = new URLSearchParams(window.location.search);
  if (params.get('input')) { $('target-input').value = params.get('input').slice(0, 1000); if (chainNames[params.get('chain')]) $('chain-select').value = params.get('chain'); }
}

$('analyze-form').addEventListener('submit', beginAnalysis);
$('analyze-form').addEventListener('invalid', (event) => { if (event.target.matches('[data-rpc-chain]')) { $('advanced-settings').hidden = false; $('settings-toggle').setAttribute('aria-expanded', 'true'); } }, true);
$('retry-button').addEventListener('click', () => $('analyze-form').requestSubmit());
$('settings-toggle').addEventListener('click', () => { const isOpen = $('advanced-settings').hidden; $('advanced-settings').hidden = !isOpen; $('settings-toggle').setAttribute('aria-expanded', String(isOpen)); });
$('clear-history').addEventListener('click', () => { state.history = []; try { localStorage.removeItem(HISTORY_KEY); } catch { /* Local storage is optional. */ } renderHistory(); });
$('cancel-button').addEventListener('click', async () => {
  const id = state.jobId; ++state.sequence; state.jobId = null; setRunning(false); $('empty-state').hidden = false; $('error-panel').hidden = true;
  toast('分析已取消');
  if (id) await api(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
});
initialize();
