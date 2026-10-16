// Main-process ownership survives renderer reloads. Closing an owner also fences
// requests still resolving refs, so a late response cannot resurrect its server.
function createPreviewLifecycle({ stop }) {
  const owners = new Map();
  const resources = new Map();
  function ownerFor(id) {
    let owner = owners.get(id);
    if (!owner) { owner = { closed: false, keys: new Set() }; owners.set(id, owner); }
    return owner;
  }
  function check(owner) {
    if (owner.closed) throw new Error('Comparison preview cancelled.');
  }
  function retire(key, resource) {
    if (resource.closing) return resource.closing;
    resource.controller.abort(new Error('Preview compilation cancelled.'));
    resource.closing = (async () => {
      await Promise.allSettled([...resource.jobs]);
      const result = await stop(key);
      if (resources.get(key) === resource) resources.delete(key);
      for (const id of resource.owners) owners.get(id)?.keys.delete(key);
      return result;
    })().catch(error => {
      resource.closing = null;
      throw error;
    });
    return resource.closing;
  }
  function request(id, operation) {
    const owner = ownerFor(id);
    const task = Promise.resolve().then(() => {
      check(owner);
      return operation({
        check: () => check(owner),
        async use(key, start) {
          check(owner);
          let resource = resources.get(key);
          if (resource?.closing || resource?.controller.signal.aborted) {
            await retire(key, resource);
            check(owner);
            resource = resources.get(key);
          }
          if (!resource) {
            resource = { owners: new Set(), jobs: new Set(), controller: new AbortController() };
            resources.set(key, resource);
          }
          resource.owners.add(id);
          owner.keys.add(key);
          const job = Promise.resolve().then(() => {
            resource.controller.signal.throwIfAborted();
            return start(resource.controller.signal);
          });
          resource.jobs.add(job);
          try { const result = await job; check(owner); return result; }
          finally { resource.jobs.delete(job); }
        },
      });
    });
    return task;
  }
  function release(id) {
    const owner = ownerFor(id);
    if (owner.releasing) return owner.releasing;
    owner.closed = true;
    const closing = [];
    for (const key of owner.keys) {
      const resource = resources.get(key);
      if (!resource) continue;
      resource.owners.delete(id);
      if (!resource.owners.size) closing.push(retire(key, resource));
    }
    // Keep the closed owner as a tombstone for late IPC requests. Repeated close
    // requests must await the same disposal, and failed disposal can be retried.
    owner.releasing = Promise.all(closing).then(results => {
      owner.keys.clear();
      return results.flat().filter(Boolean);
    }).catch(error => {
      owner.releasing = null;
      throw error;
    });
    return owner.releasing;
  }
  async function forget(id) {
    const owner = owners.get(id);
    if (!owner) return;
    if (!owner.closed) throw new Error('Cannot forget an active comparison preview.');
    await owner.releasing;
    if (owner.keys.size) throw new Error('Cannot forget a comparison preview before cleanup finishes.');
    if (owners.get(id) === owner) owners.delete(id);
  }
  async function stopResource(key) {
    const resource = resources.get(key);
    return resource ? retire(key, resource) : stop(key);
  }
  return { request, release, forget, stopResource, stopAll: () => Promise.all([...resources].map(([key, resource]) => retire(key, resource))) };
}
module.exports = { createPreviewLifecycle };
