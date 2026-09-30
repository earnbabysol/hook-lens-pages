(function () {
  'use strict';
  const jobs = new Map();
  let metadata;
  const errorText = error => String(error?.message || error || '分析失败').replace(/https?:\/\/\S+/g, '[数据接口]').slice(0, 500);
  function snapshot(job) {
    return { id: job.id, status: job.status, progress: job.progress.slice(), result: job.result, error: job.error };
  }
  function stop(job, status, value) {
    if (job.status !== 'running') return;
    clearTimeout(job.timer);
    job.worker.terminate();
    job.status = status;
    if (status === 'complete') job.result = value;
    else job.error = errorText(value);
  }
  async function request(path, options = {}) {
    const method = options.method || 'GET';
    if (path === '/api/meta' && method === 'GET') {
      if (!metadata) {
        const response = await fetch(new URL('./meta.json', document.baseURI), { credentials: 'omit' });
        if (!response.ok) throw new Error('网页配置加载失败，请刷新页面重试');
        metadata = await response.json();
      }
      return metadata;
    }
    if (path === '/api/analyze' && method === 'POST') {
      if (!window.Worker || !window.crypto?.randomUUID) throw new Error('当前浏览器不支持分析引擎，请使用新版 Chrome、Edge、Safari 或 Firefox');
      if ([...jobs.values()].some(job => job.status === 'running')) throw new Error('请先等待当前分析完成或点击取消');
      let body;
      try { body = JSON.parse(options.body); } catch { throw new Error('查询参数格式无效'); }
      for (const [id, job] of jobs) if (job.status !== 'running' && jobs.size >= 12) jobs.delete(id);
      const id = crypto.randomUUID();
      const worker = new Worker(new URL('./analysis-worker.js', document.baseURI));
      const job = { id, worker, status: 'running', progress: [{ stage: 'start', message: '正在从浏览器连接链上只读接口', at: new Date().toISOString() }] };
      jobs.set(id, job);
      job.timer = setTimeout(() => stop(job, 'error', '分析超过 4 分钟，请指定网络或更换支持跨域的 HTTPS RPC 后重试'), 240000);
      worker.onmessage = event => {
        const message = event.data;
        if (!message || message.jobId !== id || job.status !== 'running') return;
        if (message.type === 'progress' && message.progress) {
          job.progress.push({ stage: message.progress.stage, message: message.progress.message, at: new Date().toISOString() });
          if (job.progress.length > 70) job.progress.shift();
        } else if (message.type === 'complete' && message.result) stop(job, 'complete', message.result);
        else if (message.type === 'error') stop(job, 'error', message.error || '分析失败');
      };
      worker.onerror = event => { event.preventDefault(); stop(job, 'error', '分析引擎加载或运行失败，请刷新页面重试'); };
      worker.onmessageerror = () => stop(job, 'error', '分析结果传输失败，请重新查询');
      worker.postMessage({ type: 'analyze', jobId: id, options: body });
      return { jobId: id };
    }
    const match = path.match(/^\/api\/jobs\/([a-f0-9-]{36})$/);
    if (match) {
      const job = jobs.get(match[1]);
      if (!job) throw new Error('分析任务已结束或页面已刷新，请重新查询');
      if (method === 'DELETE') { stop(job, 'error', '已取消分析'); return { id: job.id, status: job.status }; }
      if (method === 'GET') return snapshot(job);
    }
    throw new Error('不支持的查询操作');
  }
  window.addEventListener('pagehide', () => { for (const job of jobs.values()) if (job.status === 'running') stop(job, 'error', '页面已关闭'); });
  window.HookLensBrowser = Object.freeze({ request });
})();
