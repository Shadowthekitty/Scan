// Promise wrapper around the image-processing worker.
export class WorkerClient {
  constructor(url) {
    this.worker = new Worker(url);
    this.seq = 1;
    this.pending = new Map();
    this.worker.onmessage = (ev) => {
      const { id, ok, result, error, progress } = ev.data || {};
      const p = this.pending.get(id);
      if (!p) return;
      if (progress) { if (p.onProgress) p.onProgress(progress.stage, progress.value); return; }
      this.pending.delete(id);
      if (ok) p.resolve(result); else p.reject(new Error(error || 'Processing failed'));
    };
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || 'The scanner engine crashed');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    this.ready = this.call('init');
  }

  call(cmd, args, opts = {}) {
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress: opts.onProgress });
      this.worker.postMessage({ id, cmd, args }, opts.transfer || []);
    });
  }

  get busyCount() { return this.pending.size; }
}
